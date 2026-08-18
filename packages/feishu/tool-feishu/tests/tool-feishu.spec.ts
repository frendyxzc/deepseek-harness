/**
 * Tool-level tests: schema enum validation, end-to-end send through a scripted
 * provider, and result formatting. Mounts the real seam, tools, system-prompt,
 * and tool-feishu packages; only the provider boundary is scripted.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import FeishuRuntime, { type FeishuSendRequest } from '@deepseek-ai/dsh-feishu'
import * as ToolFeishu from '@deepseek-ai/dsh-tool-feishu'

const testToolSignal = new AbortController().signal

let ctx: Context
let sends: FeishuSendRequest[]
let fiber: Awaited<ReturnType<Context['plugin']>>

beforeEach(async () => {
  sends = []
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FeishuRuntime, {})
  ctx.feishu.registerProvider({
    id: 'scripted',
    available: () => true,
    sendMessage: async (request) => {
      sends.push(request)
      return { messageId: 'mid-1' }
    },
  })
  fiber = await ctx.plugin(ToolFeishu)
})

afterEach(async () => {
  await fiber.dispose()
})

let counter = 0
function call(args: unknown): Promise<ToolExecutionResult> {
  return ctx.tools.execute({ signal: testToolSignal, callId: CallId(`call-${++counter}`), name: 'feishu_send_message', arguments: args })
}

describe('tool-feishu', () => {
  it('exposes receiveIdType and msgType as constrained enums in the schema', () => {
    const schema = ctx.tools.schemas().find(s => s.name === 'feishu_send_message')
    expect(schema).toBeDefined()
    const params = schema!.parameters as { properties: Record<string, { enum?: unknown[] }> }
    expect(params.properties.receiveIdType?.enum).toEqual(['open_id', 'user_id', 'union_id', 'email', 'chat_id'])
    expect(params.properties.msgType?.enum).toEqual(['text', 'interactive'])
  })

  it('sends the message through ctx.feishu and reports the message id', async () => {
    const out = await call({ receiveId: 'ou_1', content: 'hello' })
    expect(out.isError).toBe(false)
    expect(out.content.map(b => (b.type === 'text' ? b.text : '')).join('')).toContain('mid-1')
    expect(sends).toEqual([{ receiveId: 'ou_1', content: 'hello' }])
  })

  it('passes receiveIdType and msgType through to the provider', async () => {
    await call({ receiveId: 'oc_1', content: 'hello', receiveIdType: 'chat_id', msgType: 'interactive' })
    expect(sends).toEqual([{ receiveId: 'oc_1', content: 'hello', receiveIdType: 'chat_id', msgType: 'interactive' }])
  })

  it('rejects an invalid receiveIdType through the tool executor', async () => {
    const out = await call({ receiveId: 'ou_1', content: 'hello', receiveIdType: 'bogus' })
    expect(out.isError).toBe(true)
  })

  it('rejects a blank receiveId', async () => {
    const out = await call({ receiveId: '   ', content: 'hello' })
    expect(out.isError).toBe(true)
  })
})
