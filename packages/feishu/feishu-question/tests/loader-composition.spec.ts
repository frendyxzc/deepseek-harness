/**
 * Real-composition guard for the Feishu question answerer: boots a test-only
 * cordis.yml of `dsh-session` + `dsh-agent` + `dsh-user-questions` +
 * `dsh-feishu` + `dsh-feishu-bot` + `dsh-feishu-question` through the real
 * Loader and Include path, with only the Feishu HTTP boundary mocked. Asserts
 * the outbound question card and the fail-closed settlement updates cross the
 * REAL provider wire path — a hand-mounted `ctx.plugin` suite cannot catch
 * Loader export-shape or provider-boundary failures. The submit tap itself
 * rides the long-connection channel, which unit tests cover with a scripted
 * provider; the chat binding is announced directly the way
 * `@deepseek-ai/dsh-feishu-receive` announces it (its agent-creation stack is
 * out of this composition's scope).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-feishu-receive'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import FeishuRuntime from '@deepseek-ai/dsh-feishu'
import * as FeishuBot from '@deepseek-ai/dsh-feishu-bot'
import * as FeishuQuestion from '@deepseek-ai/dsh-feishu-question'

/** One request the mocked Feishu API received. */
interface FeishuApiCall {
  method: string
  url: string
  body: Record<string, unknown>
}

let server: Server
let root: string | undefined
let context: Context | undefined
let apiCalls: FeishuApiCall[] = []
let messageCounter = 0

function handler(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    apiCalls.push({
      method: req.method ?? '',
      url: req.url ?? '',
      body: raw.length > 0 ? JSON.parse(raw) as Record<string, unknown> : {},
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url?.startsWith('/auth/v3/tenant_access_token/internal')) {
      res.end(JSON.stringify({ code: 0, tenant_access_token: 'tok', expire: 7200 }))
    } else if (req.method === 'POST' && req.url?.startsWith('/im/v1/messages')) {
      messageCounter += 1
      res.end(JSON.stringify({ code: 0, data: { message_id: `om_real-${messageCounter}` } }))
    } else {
      // PATCH /im/v1/messages/:message_id — the card settlement update.
      res.end(JSON.stringify({ code: 0 }))
    }
  })
}

beforeEach(async () => {
  apiCalls = []
  messageCounter = 0
  server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await new Promise<void>(resolve => server.close(() => { resolve() }))
})

async function loadComposition(questionConfig: string[] = []): Promise<{ ctx: Context }> {
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  root = await mkdtemp(join(tmpdir(), 'dsh-feishu-question-composition-'))
  const configPath = join(root, 'cordis.yml')
  await writeConfig(configPath, base, questionConfig)

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-user-questions', UserQuestionService],
    ['@deepseek-ai/dsh-feishu', FeishuRuntime],
    ['@deepseek-ai/dsh-feishu-bot', FeishuBot],
    ['@deepseek-ai/dsh-feishu-question', FeishuQuestion],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return { ctx }
}

async function writeConfig(configPath: string, base: string, questionConfig: string[]): Promise<void> {
  await writeFile(configPath, [
    '- id: session-store',
    "  name: '@deepseek-ai/dsh-session'",
    '- id: agent',
    "  name: '@deepseek-ai/dsh-agent'",
    '- id: user-questions',
    "  name: '@deepseek-ai/dsh-user-questions'",
    '- id: feishu',
    "  name: '@deepseek-ai/dsh-feishu'",
    '- id: feishu-bot',
    "  name: '@deepseek-ai/dsh-feishu-bot'",
    '  config:',
    '    appId: app',
    '    appSecret: secret',
    `    baseURL: ${base}`,
    '- id: feishu-question',
    "  name: '@deepseek-ai/dsh-feishu-question'",
    ...(questionConfig.length > 0 ? ['  config:', ...questionConfig.map(line => `    ${line}`)] : []),
    '',
  ].join('\n'))
}

/** A live chat agent: a real session inside an open turn, entered in the registry. */
function chatAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  const agent = { id, session } as unknown as Agent
  ctx.agents.enter(agent, undefined)
  return agent
}

describe('feishu-question real composition', () => {
  it('delivers an interactive question card through the real provider and withdraws it on disposal', async () => {
    const { ctx } = await loadComposition()
    const agent = chatAgent(ctx, 'feishu-real-chat')
    ctx.emit('feishu/chat-agent', { agent, chatId: 'oc_real' })

    const pending = ctx.userQuestions.ask({
      questions: [{ id: 'q1', question: 'Pick a flavor', options: [{ label: 'Vanilla' }, { label: 'Matcha' }] }],
      agent,
    })
    await vi.waitFor(() => {
      expect(apiCalls.some(call => call.method === 'POST' && call.url.startsWith('/im/v1/messages'))).toBe(true)
    })

    const send = apiCalls.find(call => call.method === 'POST' && call.url.startsWith('/im/v1/messages'))!
    expect(send.url).toContain('receive_id_type=chat_id')
    expect(send.body).toMatchObject({ receive_id: 'oc_real', msg_type: 'interactive' })
    const content = send.body.content as string
    expect(content).toContain('Pick a flavor')
    expect(content).toContain('Vanilla')
    expect(content).toContain('Matcha')

    // Disposal settles the pending card fail-closed and redraws it over the wire.
    await context!.fiber.dispose()
    context = undefined
    await expect(pending).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    await vi.waitFor(() => {
      expect(apiCalls.some(call => call.method === 'PATCH' && call.url.startsWith('/im/v1/messages/om_real-'))).toBe(true)
    })
    const patch = apiCalls.find(call => call.method === 'PATCH')!
    expect(patch.url).toBe('/im/v1/messages/om_real-1')
    const settled = JSON.parse(patch.body.content as string) as { elements: Array<{ text: { content: string } }> }
    expect(settled.elements[0]!.text.content).toContain('question channel closed')
  })

  it('fails closed to ASK_TIMEOUT when the card is not answered in time, updating it over the wire', async () => {
    const { ctx } = await loadComposition(['timeoutMs: 40'])
    const agent = chatAgent(ctx, 'feishu-real-chat-2')
    ctx.emit('feishu/chat-agent', { agent, chatId: 'oc_real' })

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'q1', question: 'Pick one', options: [{ label: 'Alpha' }] }],
      agent,
    })).rejects.toMatchObject({ code: 'ASK_TIMEOUT' })

    await vi.waitFor(() => {
      expect(apiCalls.some(call => call.method === 'PATCH' && call.url.startsWith('/im/v1/messages/om_real-'))).toBe(true)
    })
    const patch = apiCalls.find(call => call.method === 'PATCH')!
    expect(patch.url).toBe('/im/v1/messages/om_real-1')
    const settled = JSON.parse(patch.body.content as string) as { elements: Array<{ text: { content: string } }> }
    expect(settled.elements[0]!.text.content).toContain('Timed out')
  })
})
