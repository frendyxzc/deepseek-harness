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
let updates: Array<{ messageId: string; content: string }>
let fiber: Awaited<ReturnType<Context['plugin']>>

beforeEach(async () => {
  sends = []
  updates = []
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
    updateMessage: async (messageId, content) => {
      updates.push({ messageId, content })
    },
  })
  fiber = await ctx.plugin(ToolFeishu)
})

afterEach(async () => {
  await fiber.dispose()
})

let counter = 0
function call(args: unknown, name = 'feishu_send_message'): Promise<ToolExecutionResult> {
  return ctx.tools.execute({ signal: testToolSignal, callId: CallId(`call-${++counter}`), name, arguments: args })
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

  it('rejects a blank content', async () => {
    const out = await call({ receiveId: 'ou_1', content: '  ' })
    expect(out.isError).toBe(true)
    expect(sends).toHaveLength(0)
  })

  it('presents both tools and reports them concurrency-safe', () => {
    const send = ctx.tools.get('feishu_send_message')
    expect(send?.isConcurrencySafe?.({ receiveId: 'ou_1', content: 'hello' })).toBe(true)
    expect(send?.presentCall?.({ receiveId: 'ou_1', content: 'hello' })).toEqual({
      card: 'generic', title: 'Send to ou_1', kind: 'other', rawInput: 'hello',
    })
    expect(send?.presentResult?.({ receiveId: 'ou_1', content: 'hello' }, { isError: false } as ToolExecutionResult)).toEqual({
      card: 'generic', kind: 'other', title: 'Sent to ou_1',
    })
    expect(send?.presentResult?.({ receiveId: 'ou_1', content: 'hello' }, { isError: true } as ToolExecutionResult)).toBeUndefined()

    const update = ctx.tools.get('feishu_update_message')
    expect(update?.isConcurrencySafe?.({ messageId: 'mid-1', content: 'revised' })).toBe(true)
    expect(update?.presentCall?.({ messageId: 'mid-1', content: 'revised' })).toEqual({
      card: 'generic', title: 'Update message mid-1', kind: 'other', rawInput: 'revised',
    })
    expect(update?.presentResult?.({ messageId: 'mid-1', content: 'revised' }, { isError: false } as ToolExecutionResult)).toEqual({
      card: 'generic', kind: 'other', title: 'Updated message mid-1',
    })
    expect(update?.presentResult?.({ messageId: 'mid-1', content: 'revised' }, { isError: true } as ToolExecutionResult)).toBeUndefined()
  })

  it('registers feishu_update_message with required messageId and content', () => {
    const schema = ctx.tools.schemas().find(s => s.name === 'feishu_update_message')
    expect(schema).toBeDefined()
    const params = schema!.parameters as { properties: Record<string, { type?: string }> }
    expect(Object.keys(params.properties).sort()).toEqual(['content', 'messageId'])
  })

  it('updates the message through ctx.feishu and reports the message id', async () => {
    const out = await call({ messageId: 'mid-1', content: 'revised reply' }, 'feishu_update_message')
    expect(out.isError).toBe(false)
    expect(out.content.map(b => (b.type === 'text' ? b.text : '')).join('')).toContain('mid-1')
    expect(updates).toEqual([{ messageId: 'mid-1', content: 'revised reply' }])
  })

  it('rejects blank update arguments', async () => {
    expect((await call({ messageId: '  ', content: 'x' }, 'feishu_update_message')).isError).toBe(true)
    expect((await call({ messageId: 'mid-1', content: ' ' }, 'feishu_update_message')).isError).toBe(true)
    expect(updates).toHaveLength(0)
  })

  it('surfaces the seam error when the provider cannot update messages', async () => {
    // A fresh composition whose only provider is send-only: the seam rejects
    // the update with its own error and the tool propagates it as an error result.
    const bare = new Context()
    await bare.plugin(SystemPrompt)
    await bare.plugin(ToolRuntime)
    await bare.plugin(FeishuRuntime, {})
    bare.feishu.registerProvider({
      id: 'send-only',
      available: () => true,
      sendMessage: async () => ({ messageId: 'm' }),
    })
    const bareFiber = await bare.plugin(ToolFeishu)
    const out = await bare.tools.execute({
      signal: testToolSignal,
      callId: CallId(`call-${++counter}`),
      name: 'feishu_update_message',
      arguments: { messageId: 'mid-1', content: 'revised' },
    })
    expect(out.isError).toBe(true)
    expect(out.content.map(b => (b.type === 'text' ? b.text : '')).join('')).toContain('does not support updating')
    await bareFiber.dispose()
    await bare.fiber.dispose()
  })

  it('skips the update tool when update is disabled', async () => {
    await fiber.dispose()
    fiber = await ctx.plugin(ToolFeishu, { update: false })
    expect(ctx.tools.schemas().find(s => s.name === 'feishu_update_message')).toBeUndefined()
    expect(ctx.tools.schemas().find(s => s.name === 'feishu_send_message')).toBeDefined()
  })

  it('skips the send tool when send is disabled', async () => {
    await fiber.dispose()
    fiber = await ctx.plugin(ToolFeishu, { send: false })
    expect(ctx.tools.schemas().find(s => s.name === 'feishu_send_message')).toBeUndefined()
    expect(ctx.tools.schemas().find(s => s.name === 'feishu_update_message')).toBeDefined()
  })
})
