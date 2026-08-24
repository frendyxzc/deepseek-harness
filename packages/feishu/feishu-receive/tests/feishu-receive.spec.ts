/**
 * Consumer tests: incoming Feishu events create a dedicated agent per chat (keyed
 * by a fresh `feishu-<uuid>` session id, running the live session's preset),
 * deliver each message to that agent via followup, reuse the agent for the same
 * chat within one process, and survive the real Loader unwrap path.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import FeishuRuntime, { FeishuError, type FeishuReceiveEvent } from '@deepseek-ai/dsh-feishu'
import * as FeishuReceive from '@deepseek-ai/dsh-feishu-receive'

interface CreatedAgent {
  id: string
  followup: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}

interface CreatedOptions {
  sessionId: string
  meta?: { agentPreset?: string; cwd?: string }
  agentOptions?: { provider?: string; model?: string; maxTokens?: number }
  setup?: (agentCtx: Context) => Promise<void>
}

interface MountOptions {
  onRoots?: () => unknown[]
  presetOfRoot?: string
  defaultId?: string
  config?: { cwd?: string; ack?: boolean }
  /** Scripted referenced-message content keyed by the requested message id. */
  getMessage?: (messageId: string) => Promise<{ content: string; images?: Array<{ fileKey: string }> }>
  /** Scripted image-resource bytes keyed by (messageId, fileKey). */
  getMessageResource?: (messageId: string, fileKey: string) => Promise<{ data: Uint8Array }>
  /** Scripted attachment-store saveImage; returns durable refs for the test's assertions. */
  saveImage?: ReturnType<typeof vi.fn>
}

/** One acknowledgement (or any message) the scripted provider sent. */
interface SentMessage {
  receiveId: string
  receiveIdType?: string
  content: string
}

function root(): unknown {
  return {
    ctx: {},
    options: { provider: 'p1', model: 'm1' },
    session: { header: { cwd: '/work' } },
  }
}

/**
 * A mock systemPrompt service that records context registrations. Each call
 * returns a no-op disposer so the setup callback completes normally.
 */
function mockSystemPrompt() {
  const contextCalls: { name: string; order: number; text: string }[] = []
  return {
    context: vi.fn((entry: { name: string; order: number; text: string }) => {
      contextCalls.push(entry)
      return () => {}
    }),
    section: vi.fn(() => () => {}),
    assemble: vi.fn(async () => ({ sections: [], contexts: [], variables: new Map() })),
    contextCalls,
  }
}

function mountReceive(options: MountOptions = {}): Promise<{
  ctx: Context
  handler: (event: FeishuReceiveEvent) => void
  fiber: Awaited<ReturnType<Context['plugin']>>
  create: ReturnType<typeof vi.fn>
  agents: CreatedAgent[]
  systemPrompt: ReturnType<typeof mockSystemPrompt>
  sends: SentMessage[]
  controls: { failSend: boolean }
  gets: string[]
}> {
  return (async () => {
    const ctx = new Context()
    await ctx.plugin(FeishuRuntime, {})

    let handler: ((event: FeishuReceiveEvent) => void) | undefined
    const sends: SentMessage[] = []
    const gets: string[] = []
    const controls = { failSend: false }
    ctx.feishu.registerProvider({
      id: 'scripted',
      available: () => true,
      sendMessage: async (request) => {
        if (controls.failSend) throw new FeishuError('scripted send failure', 'FEISHU_PROVIDER_ERROR')
        sends.push({
          receiveId: request.receiveId,
          ...(request.receiveIdType !== undefined ? { receiveIdType: request.receiveIdType } : {}),
          content: request.content,
        })
        return { messageId: 'm' }
      },
      startReceiving: (h) => { handler = h; return () => {} },
      ...(options.getMessage !== undefined ? {
        getMessage: async (messageId: string) => {
          gets.push(messageId)
          const fetched = await options.getMessage!(messageId)
          return {
            messageId,
            msgType: 'text',
            content: fetched.content,
            ...(fetched.images !== undefined ? { images: fetched.images } : {}),
            raw: {},
          }
        },
      } : {}),
      ...(options.getMessageResource !== undefined ? {
        getMessageResource: async (messageId: string, fileKey: string) => options.getMessageResource!(messageId, fileKey),
      } : {}),
    })

    const systemPrompt = mockSystemPrompt()
    ctx.provide('systemPrompt', systemPrompt as never)
    if (options.saveImage !== undefined) {
      ctx.provide('attachments', { saveImage: options.saveImage } as never)
    }

    const agents: CreatedAgent[] = []
    const create = vi.fn(async (opts: CreatedOptions) => {
      const agent: CreatedAgent = { id: opts.sessionId, followup: vi.fn(), dispose: vi.fn(async () => {}) }
      agents.push(agent)
      // Call the setup callback so per-chat system-prompt context registration
      // runs, matching the real agents.create contract.
      if (opts.setup !== undefined) {
        const agentCtx = ctx.extend({ agent })
        await opts.setup(agentCtx)
      }
      return { agent, dispose: agent.dispose }
    })

    ctx.provide('agents', {
      roots: options.onRoots ?? (() => []),
      create,
    } as never)
    ctx.provide('agentPresets', {
      defaultId: options.defaultId ?? 'preset-default',
      composedPreset: () => options.presetOfRoot,
      mount: vi.fn(async () => {}),
    } as never)

    const fiber = await ctx.plugin(FeishuReceive, options.config ?? {})
    return { ctx, handler: handler!, fiber, create, agents, systemPrompt, sends, controls, gets }
  })()
}

/**
 * Mount the seam + the receive consumer with NO provider registered yet, and
 * a factory for registering scripted providers later — the parallel-entry-load
 * situation where the provider plugin activates after the receive consumer.
 */
function mountReceiveDeferred(
  options: MountOptions = {},
  seamConfig: ConstructorParameters<typeof FeishuRuntime>[1] = {},
): Promise<{
  ctx: Context
  fiber: Awaited<ReturnType<Context['plugin']>>
  handlers: Array<(event: FeishuReceiveEvent) => void>
  create: ReturnType<typeof vi.fn>
  agents: CreatedAgent[]
  systemPrompt: ReturnType<typeof mockSystemPrompt>
  register: (id: string, opts?: { available?: () => boolean; receive?: boolean }) => () => void
}> {
  return (async () => {
    const ctx = new Context()
    await ctx.plugin(FeishuRuntime, seamConfig)

    const handlers: Array<(event: FeishuReceiveEvent) => void> = []
    const register = (
      id: string,
      opts: { available?: () => boolean; receive?: boolean } = {},
    ): (() => void) => ctx.feishu.registerProvider({
      id,
      available: opts.available ?? (() => true),
      sendMessage: async () => ({ messageId: 'm' }),
      ...(opts.receive === false ? {} : {
        startReceiving: (h) => { handlers.push(h); return () => {} },
      }),
    })

    const systemPrompt = mockSystemPrompt()
    ctx.provide('systemPrompt', systemPrompt as never)

    const agents: CreatedAgent[] = []
    const create = vi.fn(async (opts: CreatedOptions) => {
      const agent: CreatedAgent = { id: opts.sessionId, followup: vi.fn(), dispose: vi.fn(async () => {}) }
      agents.push(agent)
      // Call the setup callback so per-chat system-prompt context registration
      // runs, matching the real agents.create contract.
      if (opts.setup !== undefined) {
        const agentCtx = ctx.extend({ agent })
        await opts.setup(agentCtx)
      }
      return { agent, dispose: agent.dispose }
    })

    ctx.provide('agents', {
      roots: options.onRoots ?? (() => []),
      create,
    } as never)
    ctx.provide('agentPresets', {
      defaultId: options.defaultId ?? 'preset-default',
      composedPreset: () => options.presetOfRoot,
      mount: vi.fn(async () => {}),
    } as never)

    const fiber = await ctx.plugin(FeishuReceive, options.config ?? {})
    return { ctx, fiber, handlers, create, agents, systemPrompt, register }
  })()
}

function event(text: string, chatId = 'oc_1', extra: Partial<FeishuReceiveEvent> = {}): FeishuReceiveEvent {
  return { eventType: 'im.message.receive_v1', senderId: 'ou_1', senderIdType: 'open_id', chatId, content: text, raw: {}, ...extra }
}

describe('feishu-receive', () => {
  it('keeps its namespace exports through the real Loader unwrap path', () => {
    expect('default' in FeishuReceive).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(FeishuReceive) as Record<string, unknown>
    expect(unwrapped).toBe(FeishuReceive)
    expect(unwrapped.name).toBe('feishu-receive')
    expect(unwrapped.inject).toEqual(['feishu', 'agents', 'agentPresets', 'systemPrompt'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('creates a per-chat agent running the live preset and delivers via followup', async () => {
    const { ctx, handler, fiber, create, agents } = await mountReceive({
      onRoots: () => [root()],
      presetOfRoot: 'preset-web',
    })

    handler(event('hello'))

    await vi.waitFor(() => { expect(create).toHaveBeenCalledTimes(1) })
    const options = create.mock.calls[0]![0] as CreatedOptions
    expect(options.sessionId).toMatch(/^feishu-/)
    expect(options.meta?.agentPreset).toBe('preset-web')
    expect(options.meta?.cwd).toBe('/work')
    expect(options.agentOptions).toEqual({ provider: 'p1', model: 'm1' })

    await vi.waitFor(() => { expect(agents[0]!.followup).toHaveBeenCalledTimes(1) })
    const message = agents[0]!.followup.mock.calls[0]![0] as { content: unknown[]; source: { kind: string } }
    expect(message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(message.source.kind).toBe('user')
    await ctx.fiber.dispose()
    await fiber.dispose()
  })

  it('announces each published per-chat agent with the feishu/chat-agent event', async () => {
    const { ctx, handler, fiber, agents } = await mountReceive({ onRoots: () => [root()] })
    const announcements: Array<{ agent: unknown; chatId: string }> = []
    ctx.on('feishu/chat-agent', payload => announcements.push(payload))

    handler(event('hello', 'oc_7'))

    await vi.waitFor(() => { expect(announcements).toHaveLength(1) })
    expect(announcements[0]).toEqual({ agent: agents[0], chatId: 'oc_7' })
    await ctx.fiber.dispose()
    await fiber.dispose()
  })

  it('reuses the created agent for a second message from the same chat', async () => {
    const { ctx, handler, fiber, create, agents } = await mountReceive({ onRoots: () => [root()] })

    handler(event('first'))
    handler(event('second'))

    await vi.waitFor(() => { expect(agents[0]!.followup).toHaveBeenCalledTimes(2) })
    expect(create).toHaveBeenCalledTimes(1)
    expect((create.mock.calls[0]![0] as CreatedOptions).sessionId).toMatch(/^feishu-/)
    await ctx.fiber.dispose()
    await fiber.dispose()
  })

  it('creates a separate agent per chat with a distinct session id', async () => {
    const { ctx, handler, fiber, create, agents } = await mountReceive({ onRoots: () => [root()] })

    handler(event('a', 'oc_1'))
    handler(event('b', 'oc_2'))

    await vi.waitFor(() => { expect(create).toHaveBeenCalledTimes(2) })
    const first = create.mock.calls[0]![0] as CreatedOptions
    const second = create.mock.calls[1]![0] as CreatedOptions
    expect(first.sessionId).toMatch(/^feishu-/)
    expect(second.sessionId).toMatch(/^feishu-/)
    expect(first.sessionId).not.toBe(second.sessionId)
    await vi.waitFor(() => { expect(agents[1]!.followup).toHaveBeenCalledTimes(1) })
    await ctx.fiber.dispose()
    await fiber.dispose()
  })

  it('falls back to the configured cwd when no live root agent exists', async () => {
    const { ctx, handler, fiber, create } = await mountReceive({
      onRoots: () => [],
      config: { cwd: '/configured-work' },
    })

    handler(event('hello'))

    await vi.waitFor(() => { expect(create).toHaveBeenCalledTimes(1) })
    const options = create.mock.calls[0]![0] as CreatedOptions
    expect(options.meta?.cwd).toBe('/configured-work')
    expect(options.meta?.agentPreset).toBe('preset-default')
    await ctx.fiber.dispose()
    await fiber.dispose()
  })

  it('rejects the first message when neither root cwd nor config.cwd is available without raising', async () => {
    const { ctx, handler, fiber, create } = await mountReceive({ onRoots: () => [] })

    // No live root and no config.cwd; resolveTemplate throws synchronously,
    // the rejection reaches the error logger, and create is never called.
    // The handler itself does not throw.
    expect(() => { handler(event('hello')) }).not.toThrow()
    await vi.waitFor(() => { expect(create).toHaveBeenCalledTimes(0) })
    await ctx.fiber.dispose()
    await fiber.dispose()
  })

  it('registers a per-chat system-prompt context with the chat id and reply instructions', async () => {
    const { ctx, handler, fiber, systemPrompt } = await mountReceive({
      onRoots: () => [root()],
      presetOfRoot: 'preset-web',
    })

    handler(event('hello', 'oc_42'))

    await vi.waitFor(() => { expect(systemPrompt.context).toHaveBeenCalledTimes(1) })
    const entry = systemPrompt.contextCalls[0]!
    expect(entry.name).toBe('feishu:chat-context')
    expect(entry.order).toBe(130)
    expect(entry.text).toContain('oc_42')
    expect(entry.text).toContain('chat_id')
    expect(entry.text).toContain('feishu_send_message')
    await ctx.fiber.dispose()
    await fiber.dispose()
  })

  it('drops events without a chat id without raising or creating', async () => {
    const { ctx, handler, fiber, create } = await mountReceive({ onRoots: () => [root()] })

    expect(() => { handler(event('hello', '')) }).not.toThrow()
    await vi.waitFor(() => { expect(create).toHaveBeenCalledTimes(0) })
    await ctx.fiber.dispose()
    await fiber.dispose()
  })

  it('survives a creation failure without raising', async () => {
    const create = vi.fn(async (): Promise<never> => { throw new Error('preset broken') })
    const ctx = new Context()
    await ctx.plugin(FeishuRuntime, {})
    let handler: ((event: FeishuReceiveEvent) => void) | undefined
    ctx.feishu.registerProvider({
      id: 'scripted',
      available: () => true,
      sendMessage: async () => ({ messageId: 'm' }),
      startReceiving: (h) => { handler = h; return () => {} },
    })
    ctx.provide('systemPrompt', mockSystemPrompt() as never)
    // The live root carries a cwd so resolveTemplate succeeds; the failure
    // happens inside agents.create, not during template resolution.
    ctx.provide('agents', { roots: () => [root()], create } as never)
    ctx.provide('agentPresets', {
      defaultId: 'preset-default',
      composedPreset: () => undefined,
      mount: vi.fn(async () => {}),
    } as never)
    const fiber = await ctx.plugin(FeishuReceive)

    expect(() => { handler!(event('hello')) }).not.toThrow()
    await vi.waitFor(() => { expect(create).toHaveBeenCalledTimes(1) })
    await ctx.fiber.dispose()
    await fiber.dispose()
  })

  it('disposes every created agent when its fiber disposes', async () => {
    const { ctx, handler, fiber, agents } = await mountReceive({ onRoots: () => [root()] })

    handler(event('hello'))
    await vi.waitFor(() => { expect(agents[0]!.followup).toHaveBeenCalledTimes(1) })

    await fiber.dispose()
    await vi.waitFor(() => { expect(agents[0]!.dispose).toHaveBeenCalledTimes(1) })
    await ctx.fiber.dispose()
  })

  it('loads without a registered provider and routes messages when one registers', async () => {
    const { ctx, fiber, handlers, create, agents, register } = await mountReceiveDeferred({ onRoots: () => [root()] })
    expect(handlers).toHaveLength(0)

    register('scripted')
    expect(handlers).toHaveLength(1)

    handlers[0]!(event('hello'))
    await vi.waitFor(() => { expect(create).toHaveBeenCalledTimes(1) })
    await vi.waitFor(() => { expect(agents[0]!.followup).toHaveBeenCalledTimes(1) })
    const createdOptions = create.mock.calls[0]![0] as CreatedOptions
    expect(createdOptions.sessionId).toMatch(/^feishu-/)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('fails the registration loudly when a later provider cannot receive', async () => {
    const { ctx, fiber, handlers, register } = await mountReceiveDeferred()
    expect(() => register('send-only', { receive: false })).toThrow(
      expect.objectContaining({ code: 'FEISHU_RECEIVE_UNSUPPORTED' }),
    )
    expect(handlers).toHaveLength(0)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps waiting through registrations that cannot host the channel', async () => {
    const { ctx, fiber, handlers, register } = await mountReceiveDeferred()
    const disposeCold = register('cold', { available: () => false })
    expect(handlers).toHaveLength(0)
    disposeCold()
    expect(handlers).toHaveLength(0)

    register('scripted')
    expect(handlers).toHaveLength(1)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('reopens the receive channel on the remaining provider when another leaves', async () => {
    const { ctx, fiber, handlers, register } = await mountReceiveDeferred()
    const disposeA = register('bot-a')
    expect(handlers).toHaveLength(1)
    const disposeB = register('bot-b')
    expect(handlers).toHaveLength(1)

    disposeB()
    expect(handlers).toHaveLength(2)
    disposeA()
    expect(handlers).toHaveLength(2)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('falls back to waiting when the remaining provider cannot host the channel', async () => {
    const { ctx, fiber, handlers, register } = await mountReceiveDeferred()
    const disposeGood = register('good')
    expect(handlers).toHaveLength(1)
    const disposeSendOnly = register('send-only', { receive: false })
    expect(handlers).toHaveLength(1)

    disposeGood()
    expect(handlers).toHaveLength(1)
    disposeSendOnly()
    register('good-2')
    expect(handlers).toHaveLength(2)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('waits for the configured provider when it registers after load', async () => {
    const { ctx, fiber, handlers, register } = await mountReceiveDeferred({}, { provider: 'pinned' })
    expect(handlers).toHaveLength(0)

    register('pinned')
    expect(handlers).toHaveLength(1)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('acknowledges each incoming message in its chat before delivery', async () => {
    const { ctx, handler, fiber, sends, agents } = await mountReceive({ onRoots: () => [root()] })

    handler(event('hello', 'oc_9'))

    await vi.waitFor(() => { expect(sends).toHaveLength(1) })
    expect(sends[0]).toEqual({ receiveId: 'oc_9', receiveIdType: 'chat_id', content: expect.stringContaining('已收到') as string })
    await vi.waitFor(() => { expect(agents[0]!.followup).toHaveBeenCalledTimes(1) })
    await ctx.fiber.dispose()
    await fiber.dispose()
  })

  it('skips the acknowledgement when ack is disabled', async () => {
    const { ctx, handler, fiber, sends, agents } = await mountReceive({
      onRoots: () => [root()],
      config: { ack: false },
    })

    handler(event('hello'))

    await vi.waitFor(() => { expect(agents[0]!.followup).toHaveBeenCalledTimes(1) })
    expect(sends).toHaveLength(0)
    await ctx.fiber.dispose()
    await fiber.dispose()
  })

  it('still delivers the message when the acknowledgement send fails', async () => {
    const { ctx, handler, fiber, controls, agents } = await mountReceive({ onRoots: () => [root()] })
    controls.failSend = true

    expect(() => { handler(event('hello')) }).not.toThrow()

    await vi.waitFor(() => { expect(agents[0]!.followup).toHaveBeenCalledTimes(1) })
    await ctx.fiber.dispose()
    await fiber.dispose()
  })

  it('prepends the referenced (quoted) message content when the event carries a parent id', async () => {
    const { ctx, handler, fiber, agents, gets } = await mountReceive({
      onRoots: () => [root()],
      getMessage: async messageId => ({ content: `quoted ${messageId}` }),
    })

    handler(event('reply text', 'oc_1', { parentId: 'om_quoted' }))

    await vi.waitFor(() => { expect(agents[0]!.followup).toHaveBeenCalledTimes(1) })
    const message = agents[0]!.followup.mock.calls[0]![0] as { content: unknown[] }
    expect(message.content).toEqual([{ type: 'text', text: '[引用消息]\nquoted om_quoted\n\nreply text' }])
    expect(gets).toEqual(['om_quoted'])
    await ctx.fiber.dispose()
    await fiber.dispose()
  })

  it('delivers the message unchanged when the event has no reference', async () => {
    const { ctx, handler, fiber, agents, gets } = await mountReceive({
      onRoots: () => [root()],
      getMessage: async messageId => ({ content: `quoted ${messageId}` }),
    })

    handler(event('plain text'))

    await vi.waitFor(() => { expect(agents[0]!.followup).toHaveBeenCalledTimes(1) })
    const message = agents[0]!.followup.mock.calls[0]![0] as { content: unknown[] }
    expect(message.content).toEqual([{ type: 'text', text: 'plain text' }])
    expect(gets).toEqual([])
    await ctx.fiber.dispose()
    await fiber.dispose()
  })

  it('delivers the message unchanged when reading the reference is unsupported', async () => {
    const { ctx, handler, fiber, agents } = await mountReceive({ onRoots: () => [root()] })

    // No getMessage on the scripted provider: FEISHU_GET_UNSUPPORTED is
    // swallowed and the original message still reaches the agent.
    handler(event('solo reply', 'oc_1', { parentId: 'om_missing' }))

    await vi.waitFor(() => { expect(agents[0]!.followup).toHaveBeenCalledTimes(1) })
    const message = agents[0]!.followup.mock.calls[0]![0] as { content: unknown[] }
    expect(message.content).toEqual([{ type: 'text', text: 'solo reply' }])
    await ctx.fiber.dispose()
    await fiber.dispose()
  })

  it('attaches images carried by the inbound event as image content blocks', async () => {
    const saveImage = vi.fn(async () => ({ attachmentId: 'sha256:abc', mediaType: 'image/jpeg', bytes: 4, width: 1, height: 1 }))
    const { ctx, handler, fiber, agents } = await mountReceive({
      onRoots: () => [root()],
      getMessageResource: async () => ({ data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) }),
      saveImage,
    })

    handler(event('[图片]', 'oc_1', { messageId: 'om_1', images: [{ fileKey: 'img_1' }] }))

    await vi.waitFor(() => { expect(agents[0]!.followup).toHaveBeenCalledTimes(1) })
    const message = agents[0]!.followup.mock.calls[0]![0] as { content: unknown[] }
    expect(message.content).toEqual([
      { type: 'text', text: '[图片]' },
      { type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/jpeg', bytes: 4, width: 1, height: 1 } },
    ])
    expect(saveImage).toHaveBeenCalledWith({ data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), mediaType: 'image/jpeg' })
    await ctx.fiber.dispose()
    await fiber.dispose()
  })

  it('attaches images from the quoted message alongside the referenced text', async () => {
    const saveImage = vi.fn(async () => ({ attachmentId: 'sha256:def', mediaType: 'image/png', bytes: 8, width: 2, height: 2 }))
    const { ctx, handler, fiber, agents } = await mountReceive({
      onRoots: () => [root()],
      getMessage: async messageId => ({ content: '[图片]', images: [{ fileKey: `ref_${messageId}` }] }),
      getMessageResource: async () => ({ data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }),
      saveImage,
    })

    handler(event('reply', 'oc_1', { parentId: 'om_quoted' }))

    await vi.waitFor(() => { expect(agents[0]!.followup).toHaveBeenCalledTimes(1) })
    const message = agents[0]!.followup.mock.calls[0]![0] as { content: unknown[] }
    expect(message.content).toEqual([
      { type: 'text', text: '[引用消息]\n[图片]\n\nreply' },
      { type: 'image', attachment: { attachmentId: 'sha256:def', mediaType: 'image/png', bytes: 8, width: 2, height: 2 } },
    ])
    await ctx.fiber.dispose()
    await fiber.dispose()
  })

  it('still delivers text when an image has an unrecognized format', async () => {
    const saveImage = vi.fn(async () => ({ attachmentId: 'sha256:x' }))
    const { ctx, handler, fiber, agents } = await mountReceive({
      onRoots: () => [root()],
      getMessageResource: async () => ({ data: new Uint8Array([0x00, 0x01, 0x02]) }),
      saveImage,
    })

    handler(event('see attached', 'oc_1', { messageId: 'om_1', images: [{ fileKey: 'img_1' }] }))

    await vi.waitFor(() => { expect(agents[0]!.followup).toHaveBeenCalledTimes(1) })
    const message = agents[0]!.followup.mock.calls[0]![0] as { content: unknown[] }
    expect(message.content).toEqual([{ type: 'text', text: 'see attached' }])
    expect(saveImage).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
    await fiber.dispose()
  })

  it('still delivers text when the image download fails', async () => {
    const saveImage = vi.fn(async () => ({ attachmentId: 'sha256:x' }))
    const { ctx, handler, fiber, agents } = await mountReceive({
      onRoots: () => [root()],
      getMessageResource: async () => { throw new FeishuError('Resource Has Been Deleted', 'FEISHU_PROVIDER_ERROR') },
      saveImage,
    })

    handler(event('see attached', 'oc_1', { messageId: 'om_1', images: [{ fileKey: 'img_1' }] }))

    await vi.waitFor(() => { expect(agents[0]!.followup).toHaveBeenCalledTimes(1) })
    const message = agents[0]!.followup.mock.calls[0]![0] as { content: unknown[] }
    expect(message.content).toEqual([{ type: 'text', text: 'see attached' }])
    await ctx.fiber.dispose()
    await fiber.dispose()
  })
})
