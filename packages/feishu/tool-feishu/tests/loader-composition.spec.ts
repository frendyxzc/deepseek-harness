/**
 * Real-composition guard for the Feishu seam: boots a test-only cordis.yml of
 * `dsh-feishu` + `dsh-feishu-bot` + `dsh-tool-feishu` through the real Loader
 * and Include path (with only the Feishu HTTP boundary mocked), then asserts
 * the model-visible tool schema mounts and a send ends at the mocked API. A
 * hand-mounted `ctx.plugin` cannot catch Loader export-shape failures.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import FeishuRuntime from '@deepseek-ai/dsh-feishu'
import * as FeishuBot from '@deepseek-ai/dsh-feishu-bot'
import * as ToolFeishu from '@deepseek-ai/dsh-tool-feishu'

let server: Server
let root: string | undefined
let context: Context | undefined

function handler(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url?.startsWith('/auth/v3/tenant_access_token/internal')) {
      res.end(JSON.stringify({ code: 0, tenant_access_token: 'tok', expire: 7200 }))
    } else {
      res.end(JSON.stringify({ code: 0, data: { message_id: 'mid-1' } }))
    }
  })
}

beforeEach(async () => {
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

async function loadComposition(): Promise<{ ctx: Context; base: string }> {
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  root = await mkdtemp(join(tmpdir(), 'dsh-feishu-composition-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: feishu',
    "  name: '@deepseek-ai/dsh-feishu'",
    '- id: system-prompt',
    "  name: '@deepseek-ai/dsh-system-prompt'",
    '- id: tools',
    "  name: '@deepseek-ai/dsh-tools'",
    '- id: feishu-bot',
    "  name: '@deepseek-ai/dsh-feishu-bot'",
    '  config:',
    '    appId: app',
    '    appSecret: secret',
    `    baseURL: ${base}`,
    '- id: tool-feishu',
    "  name: '@deepseek-ai/dsh-tool-feishu'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-feishu', FeishuRuntime],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-feishu-bot', FeishuBot],
    ['@deepseek-ai/dsh-tool-feishu', ToolFeishu],
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
  return { ctx, base }
}

describe('feishu real composition', () => {
  it('mounts the model tool and sends a message end-to-end', async () => {
    const { ctx } = await loadComposition()

    expect(ctx.tools.schemas().map(s => s.name)).toContain('feishu_send_message')

    const out = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('c-1'),
      name: 'feishu_send_message',
      arguments: { receiveId: 'ou_1', content: 'hello' },
    })
    expect(out.isError).toBe(false)
    expect(out.content.map(b => (b.type === 'text' ? b.text : '')).join('')).toContain('mid-1')
  })

  it('mounts the update tool and updates a message end-to-end', async () => {
    const { ctx } = await loadComposition()

    expect(ctx.tools.schemas().map(s => s.name)).toContain('feishu_update_message')

    const out = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('c-2'),
      name: 'feishu_update_message',
      arguments: { messageId: 'mid-1', content: 'revised reply' },
    })
    expect(out.isError).toBe(false)
    expect(out.content.map(b => (b.type === 'text' ? b.text : '')).join('')).toContain('mid-1')
  })

  it('sends through ctx.feishu directly', async () => {
    const { ctx } = await loadComposition()
    await expect(ctx.feishu.sendMessage({ receiveId: 'ou_1', content: 'hi' })).resolves.toEqual({ messageId: 'mid-1' })
  })
})
