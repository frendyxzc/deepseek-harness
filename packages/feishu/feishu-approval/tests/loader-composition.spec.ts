/**
 * Real-composition guard for the Feishu approval answerer: boots a test-only
 * cordis.yml of `dsh-session` + `dsh-user-approval` + `dsh-feishu` +
 * `dsh-feishu-bot` + `dsh-feishu-approval` through the real Loader and
 * Include path, with only the Feishu HTTP boundary mocked. Asserts the
 * durable audit pair, the outbound card, and the fail-closed timeout update
 * cross the REAL provider wire path — a hand-mounted `ctx.plugin` suite
 * cannot catch Loader export-shape or provider-boundary failures. The button
 * tap itself rides the long-connection channel, which unit tests cover with
 * a scripted provider.
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
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-feishu-receive'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import FeishuRuntime from '@deepseek-ai/dsh-feishu'
import * as FeishuBot from '@deepseek-ai/dsh-feishu-bot'
import * as FeishuApproval from '@deepseek-ai/dsh-feishu-approval'

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

async function loadComposition(approvalConfig: string[] = []): Promise<{ ctx: Context }> {
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  root = await mkdtemp(join(tmpdir(), 'dsh-feishu-approval-composition-'))
  const configPath = join(root, 'cordis.yml')
  await writeConfig(configPath, base, approvalConfig)

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-user-approval', ApprovalService],
    ['@deepseek-ai/dsh-feishu', FeishuRuntime],
    ['@deepseek-ai/dsh-feishu-bot', FeishuBot],
    ['@deepseek-ai/dsh-feishu-approval', FeishuApproval],
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

async function writeConfig(configPath: string, base: string, approvalConfig: string[]): Promise<void> {
  await writeFile(configPath, [
    '- id: session-store',
    "  name: '@deepseek-ai/dsh-session'",
    '- id: approval',
    "  name: '@deepseek-ai/dsh-user-approval'",
    '- id: feishu',
    "  name: '@deepseek-ai/dsh-feishu'",
    '- id: feishu-bot',
    "  name: '@deepseek-ai/dsh-feishu-bot'",
    '  config:',
    '    appId: app',
    '    appSecret: secret',
    `    baseURL: ${base}`,
    '- id: feishu-approval',
    "  name: '@deepseek-ai/dsh-feishu-approval'",
    ...(approvalConfig.length > 0 ? ['  config:', ...approvalConfig.map(line => `    ${line}`)] : []),
    '',
  ].join('\n'))
}

/** A live chat agent over a real session inside an open turn. */
function chatAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  return { session } as unknown as Agent
}

describe('feishu-approval real composition', () => {
  it('delivers an interactive approval card through the real provider and audits the pair', async () => {
    const { ctx } = await loadComposition()
    const agent = chatAgent(ctx, 'feishu-real-chat')
    ctx.emit('feishu/chat-agent', { agent, chatId: 'oc_real' })

    const pending = ctx.approval.request({ agent, toolName: 'bash', reason: 'rm -rf the build dir' })
    await vi.waitFor(() => {
      expect(apiCalls.some(call => call.method === 'POST' && call.url.startsWith('/im/v1/messages'))).toBe(true)
    })

    const send = apiCalls.find(call => call.method === 'POST' && call.url.startsWith('/im/v1/messages'))!
    expect(send.url).toContain('receive_id_type=chat_id')
    expect(send.body).toMatchObject({ receive_id: 'oc_real', msg_type: 'interactive' })
    const content = send.body.content as string
    expect(content).toContain('Tool approval request')
    expect(content).toContain('bash')
    expect(content).toContain('rm -rf the build dir')

    // The ask stays pending until a decision arrives; audit pair so far is the asked half.
    const asked = agent.session.events.filter(event => event.type === 'approval/asked')
    expect(asked).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'approval/decided')).toHaveLength(0)

    // Disposal withdraws the pending card fail-closed and completes the audit pair.
    await context!.fiber.dispose()
    context = undefined
    await expect(pending).resolves.toBe('cancelled')
    const decided = agent.session.events.filter(event => event.type === 'approval/decided')
    expect(decided).toHaveLength(1)
    expect(decided[0]!.data).toMatchObject({ outcome: 'cancelled' })
  })

  it('denies automatically when the card times out, updating the card over the wire', async () => {
    const { ctx } = await loadComposition(['timeoutMs: 40'])
    const agent = chatAgent(ctx, 'feishu-real-chat-2')
    ctx.emit('feishu/chat-agent', { agent, chatId: 'oc_real' })

    const outcome = await ctx.approval.request({ agent, toolName: 'bash' })
    expect(outcome).toBe('rejected')

    await vi.waitFor(() => {
      expect(apiCalls.some(call => call.method === 'PATCH' && call.url.startsWith('/im/v1/messages/om_real-'))).toBe(true)
    })
    const patch = apiCalls.find(call => call.method === 'PATCH')!
    expect(patch.url).toBe('/im/v1/messages/om_real-1')
    const settled = JSON.parse(patch.body.content as string) as { elements: Array<{ text: { content: string } }> }
    expect(settled.elements[0]!.text.content).toContain('Timed out')

    const decided = agent.session.events.filter(event => event.type === 'approval/decided')
    expect(decided).toHaveLength(1)
    expect(decided[0]!.data).toMatchObject({ outcome: 'rejected' })
  })

  it('routes an unbound session approval to the fallback chat through the real provider', async () => {
    const { ctx } = await loadComposition(['fallbackChatId: oc_fallback'])
    const agent = chatAgent(ctx, 'web-gui-real')

    const pending = ctx.approval.request({ agent, toolName: 'bash', reason: 'install a plugin' })
    await vi.waitFor(() => {
      expect(apiCalls.some(call => call.method === 'POST' && call.url.startsWith('/im/v1/messages'))).toBe(true)
    })

    const send = apiCalls.find(call => call.method === 'POST' && call.url.startsWith('/im/v1/messages'))!
    expect(send.url).toContain('receive_id_type=chat_id')
    expect(send.body).toMatchObject({ receive_id: 'oc_fallback', msg_type: 'interactive' })
    const content = send.body.content as string
    expect(content).toContain('Tool approval request')
    expect(content).toContain('bash')
    expect(content).toContain('install a plugin')

    const asked = agent.session.events.filter(event => event.type === 'approval/asked')
    expect(asked).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'approval/decided')).toHaveLength(0)

    // Disposal withdraws the pending fallback card and completes the audit pair.
    await context!.fiber.dispose()
    context = undefined
    await expect(pending).resolves.toBe('cancelled')
    const decided = agent.session.events.filter(event => event.type === 'approval/decided')
    expect(decided).toHaveLength(1)
    expect(decided[0]!.data).toMatchObject({ outcome: 'cancelled' })
  })
})
