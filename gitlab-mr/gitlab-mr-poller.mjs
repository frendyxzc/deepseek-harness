// dsh-gitlab-mr — 内网 DSH 的 GitLab MR 入站轮询插件（函数插件，name 指向本文件挂载）
//
// 出站（改码/分支/提交/push(SSH)/建 MR/回复/合并）交给 agent 用 bash + git + glab（见配套 SKILL.md）。
// 本插件只做 bash 做不到的常驻入站 + 登记：
//   1. 提供 `gitlab_watch_mr` 工具：agent 建完 MR 后调用它，把「当前会话」登记为这个 MR 的事件接收者。
//   2. 后台每 pollIntervalMs 轮询已登记的 MR：检测新评论（过滤 bot 作者与 system 笔记）与
//      merged/closed 状态变化，用 agent.followup() 唤醒对应会话去二次行动 / 沉淀。
// 游标与追踪集持久化到一个 JSON state 文件，重启可恢复；sessionId 随登记写入，无需手工配置绑定会话。
//
// 只依赖 Node 全局（fetch/setInterval/AbortController）+ node:crypto/node:fs/node:path，
// 不 import 任何 @deepseek-ai 包；tool 按 DSH 真实 ToolDefinition（output.schema + output.render + execute(args, exec)）注册。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'gitlab-mr'

// 声明必需服务：cordis 会等 tools/agents 就绪后才 apply，否则并发加载时
// ctx.get('tools') 可能拿到 undefined，导致 gitlab_watch_mr 静默未注册。
export const inject = ['tools', 'agents']

const DEFAULTS = {
  tokenEnv: 'GITLAB_TOKEN',
  apiBase: 'https://gitlab.com/api/v4',
  botUsername: '', // bot 账号的 GitLab username，用于回环过滤（作者 == bot 的评论不投递）
  pollIntervalMs: 300000, // 轮询间隔，默认 5 分钟
  stateFilePath: '.dsh-gitlab-mr-state.json', // 相对 DSH_HOME 或 cwd
  perPage: 100,
}

function resolveConfig(raw = {}) {
  const cfg = { ...DEFAULTS, ...(raw ?? {}) }
  if (!cfg.botUsername) {
    throw new Error('gitlab-mr: config.botUsername 必填（过滤 agent 自己的评论，防自触发死循环）')
  }
  cfg.pollIntervalMs = Math.max(Number(cfg.pollIntervalMs) || 300000, 10000)
  cfg.perPage = Math.min(Math.max(Number(cfg.perPage) || 100, 1), 100)
  return cfg
}

function statePath(cfg) {
  return isAbsolute(cfg.stateFilePath)
    ? cfg.stateFilePath
    : resolve(join(process.env.DSH_HOME || process.cwd(), cfg.stateFilePath))
}

function loadState(cfg) {
  try {
    const parsed = JSON.parse(readFileSync(statePath(cfg), 'utf8'))
    return { tracked: {}, ...(parsed ?? {}) } // { tracked: { [projectKey]: { [iid]: { lastNoteId, state, sessionId } } } }
  } catch {
    return { tracked: {} }
  }
}

function saveState(cfg, state) {
  const path = statePath(cfg)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8')
}

/**
 * 从按 created_at 降序的 notes 里筛出「待投递的新评论」并推进游标。
 * - 投递条件：id > lastNoteId 且非 system 笔记且作者不是 bot。
 * - 游标推进：无条件推进到最新 note id（bot/系统评论也推进，防止下一轮重复计算）。
 * 导出为纯函数，便于单测。
 * @param {Array} notes 降序 note 列表
 * @param {number} lastNoteId 当前水位线
 * @param {string} botUsername bot 的 GitLab username
 * @returns {{ deliver: Array, nextCursor: number }}
 */
export function filterNewNotes(notes, lastNoteId, botUsername) {
  const list = Array.isArray(notes) ? notes : []
  const newest = list.length > 0 ? Math.max(...list.map((n) => n.id)) : lastNoteId
  const deliver = list.filter(
    (n) => n.id > lastNoteId && !n.system && String(n.author?.username ?? '') !== botUsername,
  )
  return { deliver, nextCursor: Math.max(lastNoteId, newest) }
}

export function apply(ctx, rawConfig) {
  let cfg
  try {
    cfg = resolveConfig(rawConfig)
  } catch (error) {
    emitWarn(ctx, `[gitlab-mr] ${error.message}`)
    return
  }

  // ctx.logger 是 cordis LoggerService（函数）：ctx.logger('name') 返回带 info/warn/error
  // 的 logger；同时落到 console，确保 start-all.sh 的日志重定向里也能看到启动日志。
  function emitLog(ctx, level, line) {
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('gitlab-mr') : ctx.logger
      if (logger && typeof logger[level] === 'function') logger[level](line)
    } catch {
      /* fall through to console */
    }
    const c = level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'log'
    console[c](`[gitlab-mr] ${line}`)
  }
  function emitWarn(ctx, line) {
    emitLog(ctx, 'warn', line)
  }

  const log = (level, msg) => emitLog(ctx, level, msg)

  const agents = ctx.agents
  const credentials = ctx.get('credentials')
  const tools = ctx.tools

  let state = loadState(cfg)
  let timer = null
  let polling = false
  let disposed = false

  const enc = (project) => encodeURIComponent(String(project))

  async function resolveToken() {
    try {
      if (credentials) {
        const resolved = await credentials.resolve(cfg.tokenEnv)
        if (resolved && resolved.value) return resolved.value
      }
    } catch {
      /* fall through */
    }
    return process.env[cfg.tokenEnv]
  }

  async function glFetch(pathname, signal) {
    const token = await resolveToken()
    if (!token) throw new Error(`GitLab token 未配置：请设置环境变量 ${cfg.tokenEnv}`)
    const res = await fetch(`${cfg.apiBase}${pathname}`, {
      headers: { 'PRIVATE-TOKEN': token, 'user-agent': 'dsh-gitlab-mr' },
      signal,
    })
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = { raw: text.slice(0, 500) }
    }
    if (!res.ok) {
      const err = new Error(`GitLab ${res.status} ${pathname}: ${JSON.stringify(data).slice(0, 300)}`)
      err.status = res.status
      throw err
    }
    return data
  }

  function wake(agent, text) {
    // followup 要求完整 UserMessage（id + role + content + source）。
    // SessionId/MessageId 运行时都是普通字符串，用 uuid 构造即符合运行契约。
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
  }

  function resolveAgent(sessionId) {
    if (!agents) return undefined
    try {
      return agents.get(sessionId)
    } catch {
      return undefined
    }
  }

  // ---- 登记工具：agent 建 MR 后调用，把当前会话登记为该 MR 的接收者 ----
  function registerTool() {
    if (!tools) {
      log('warn', 'tools 服务不可用，跳过 gitlab_watch_mr 工具注册（poller 仍可用但需手工登记 state）')
      return () => {}
    }
    return tools.register({
      name: 'gitlab_watch_mr',
      description:
        '登记跟踪一个已创建/已存在的 GitLab Merge Request：之后该 MR 的新评论或合并/关闭会以消息唤醒当前会话。建完 MR 后立即调用。',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: "项目路径，如 'group/repo'。" },
          mrIid: { type: 'integer', description: 'Merge Request 的内部编号（!iid）。' },
        },
        required: ['project', 'mrIid'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            project: { type: 'string' },
            mrIid: { type: 'integer' },
            sessionId: { type: 'string' },
            lastNoteId: { type: 'integer' },
          },
          required: ['project', 'mrIid', 'sessionId', 'lastNoteId'],
          additionalProperties: false,
        },
        render: (_args, value) => [
          { type: 'text', text: `已跟踪 ${value.project} MR !${value.mrIid}，新评论/合并将唤醒本会话。` },
        ],
      },
      timeoutMs: 30000,
      execute: async (args, exec) => {
        const sessionId = exec.agent?.id
        if (!sessionId) throw new Error('gitlab_watch_mr 只能在 agent 会话内调用')
        const key = enc(args.project)
        const detail = await glFetch(`/projects/${key}/merge_requests/${args.mrIid}`, exec.signal)
        const notes = (await glFetch(`/projects/${key}/merge_requests/${args.mrIid}/notes?sort=desc&order_by=created_at&per_page=1`, exec.signal)) ?? []
        const lastNoteId = notes.length > 0 ? notes[0].id : 0
        ;(state.tracked[key] ??= {})[String(args.mrIid)] = {
          lastNoteId, // 登记时水位线=当前最新，历史评论不回放
          state: detail.state ?? 'opened',
          sessionId,
        }
        saveState(cfg, state)
        log('info', `${args.project} !${args.mrIid} 已由会话 ${sessionId} 登记（lastNoteId=${lastNoteId}）`)
        return { project: args.project, mrIid: args.mrIid, sessionId, lastNoteId }
      },
    })
  }

  // ---- 轮询：遍历已登记 MR，检测新评论 / 合并 / 关闭 ----
  async function tick() {
    if (polling || disposed) return
    polling = true
    try {
      let changed = false
      for (const key of Object.keys(state.tracked)) {
        const mrs = state.tracked[key]
        for (const iidStr of Object.keys(mrs)) {
          const rec = mrs[iidStr]
          const iid = Number(iidStr)

          const agent = resolveAgent(rec.sessionId)
          if (!agent) {
            // 会话当前未在运行（未 resume/已关）：保留登记，等它回来后续轮再补投，不丢事件
            log('warn', `跳过 ${key}!${iid}：会话 ${rec.sessionId} 未在运行`)
            continue
          }

          let detail
          try {
            detail = await glFetch(`/projects/${key}/merge_requests/${iid}`)
          } catch (error) {
            if (error?.status === 404) {
              delete mrs[iidStr]
              changed = true
              log('info', `${key}!${iid} 已不存在（404），移除追踪`)
            } else {
              log('warn', `查询 ${key}!${iid} 失败：${error instanceof Error ? error.message : String(error)}`)
            }
            continue
          }

          const st = detail.state
          if (st === 'merged') {
            wake(agent, `【GitLab MR 合并】${key.replace('%2F', '/')} MR !${iid} 《${detail.title ?? ''}》已合并。请沉淀本次经验：写出可复用的结论/坑/模板（Agent Note 或决策记录）。`)
            log('info', `${key}!${iid} 已合并，唤醒会话沉淀`)
            delete mrs[iidStr]
            changed = true
            continue
          }
          if (st === 'closed') {
            wake(agent, `【GitLab MR 关闭】${key.replace('%2F', '/')} MR !${iid} 《${detail.title ?? ''}》已关闭，停止跟踪。`)
            log('info', `${key}!${iid} 已关闭，移除追踪`)
            delete mrs[iidStr]
            changed = true
            continue
          }

          rec.state = st
          const notes = (await glFetch(`/projects/${key}/merge_requests/${iid}/notes?sort=desc&order_by=created_at&per_page=${cfg.perPage}`)) ?? []
          const prevCursor = rec.lastNoteId
          const { deliver, nextCursor } = filterNewNotes(notes, prevCursor, cfg.botUsername)
          rec.lastNoteId = nextCursor
          if (prevCursor !== nextCursor) changed = true

          if (deliver.length > 0) {
            const lines = deliver
              .slice()
              .reverse()
              .map((n) => `- ${n.author?.username ?? '?'}: ${(n.body ?? '').slice(0, 400)}`)
              .join('\n')
            wake(
              agent,
              `【GitLab MR 评论】${key.replace('%2F', '/')} MR !${iid} 《${detail.title ?? ''}》有 ${deliver.length} 条新评论：\n${lines}\n\n请查看并按需处理：修改代码用本地 git（建分支/commit/push），回复评论用 \`glab mr note ${iid} -m "..."\`。`,
            )
            log('info', `${key}!${iid} 发现 ${deliver.length} 条新评论，已唤醒会话 ${rec.sessionId}`)
          }
        }
      }
      if (changed) saveState(cfg, state)
    } catch (error) {
      log('warn', `轮询出错：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      polling = false
    }
  }

  // ---- 启动 ----
  const disposeTool = registerTool()
  log('info', `启动：bot=${cfg.botUsername} 间隔=${cfg.pollIntervalMs}ms，追踪 ${Object.keys(state.tracked).length} 个项目`)
  ;(async () => {
    await tick()
    timer = setInterval(tick, cfg.pollIntervalMs)
  })()

  ctx.effect(() => () => {
    disposed = true
    if (timer) clearInterval(timer)
    try {
      disposeTool()
    } catch {
      /* best-effort */
    }
  })
}