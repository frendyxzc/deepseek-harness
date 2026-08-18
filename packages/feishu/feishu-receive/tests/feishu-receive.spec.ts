/**
 * Consumer tests: incoming Feishu events route to the first root agent through
 * followup, a root-less composition drops the event without raising, and the
 * namespace exports survive the real Loader unwrap path.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import FeishuRuntime, { type FeishuReceiveEvent } from '@deepseek-ai/dsh-feishu'
import * as FeishuReceive from '@deepseek-ai/dsh-feishu-receive'

function mountReceive(onRoots: () => unknown[]): Promise<{ ctx: Context; handler: (event: FeishuReceiveEvent) => void; fiber: Awaited<ReturnType<Context['plugin']>> }> {
  return (async () => {
    const ctx = new Context()
    await ctx.plugin(FeishuRuntime, {})

    let handler: ((event: FeishuReceiveEvent) => void) | undefined
    ctx.feishu.registerProvider({
      id: 'scripted',
      available: () => true,
      sendMessage: async () => ({ messageId: 'm' }),
      startReceiving: (h) => { handler = h; return () => {} },
    })

    ctx.provide('agents', { roots: onRoots } as never)
    const fiber = await ctx.plugin(FeishuReceive)
    return { ctx, handler: handler!, fiber }
  })()
}

function event(text: string): FeishuReceiveEvent {
  return { eventType: 'im.message.receive_v1', senderId: 'ou_1', senderIdType: 'open_id', chatId: 'oc_1', content: text, raw: {} }
}

describe('feishu-receive', () => {
  it('keeps its namespace exports through the real Loader unwrap path', () => {
    expect('default' in FeishuReceive).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(FeishuReceive) as Record<string, unknown>
    expect(unwrapped).toBe(FeishuReceive)
    expect(unwrapped.name).toBe('feishu-receive')
    expect(unwrapped.inject).toEqual(['feishu', 'agents'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('delivers a received message to the first root agent via followup', async () => {
    const followup = vi.fn()
    const root = { id: 'agent-1', followup }
    const { ctx, handler, fiber } = await mountReceive(() => [root])

    handler(event('hello'))

    expect(followup).toHaveBeenCalledTimes(1)
    const first = followup.mock.calls[0]
    expect(first).toBeDefined()
    const message = first![0] as { content: unknown[]; source: { kind: string } }
    expect(message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(message.source.kind).toBe('user')
    await ctx.fiber.dispose()
    await fiber.dispose()
  })

  it('drops the event without raising when no root agent exists', async () => {
    const { ctx, handler } = await mountReceive(() => [])
    expect(() => { handler(event('hello')) }).not.toThrow()
    await ctx.fiber.dispose()
  })
})
