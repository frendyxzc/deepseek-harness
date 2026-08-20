/**
 * Provider unit tests: token caching, send success/failure, abort, credential
 * resolution, and long-connection receive (SDK construction, dispatch, disposal).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { type FeishuCardActionEvent, type FeishuReceiveEvent } from '@deepseek-ai/dsh-feishu'
import { FeishuBotProvider, type FeishuBotProviderOptions } from '@deepseek-ai/dsh-feishu-bot/src/provider.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A registered `im.message.receive_v1` handler. */
type ReceiveHandle = (data: unknown) => void
/** A captured fake event dispatcher instance. */
interface FakeDispatcher {
  handles: Record<string, ReceiveHandle>
}
/** A captured fake long-connection client instance. */
interface FakeWsClient {
  params: Record<string, unknown>
  close: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
}

/** Leaked long-connection SDK fakes, reset per long-connection test. */
const sdkMock = vi.hoisted(() => ({
  clients: [] as FakeWsClient[],
  dispatchers: [] as FakeDispatcher[],
}))

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeEventDispatcher {
    handles: Record<string, ReceiveHandle> = {}
    register(handles: Record<string, ReceiveHandle>): this {
      this.handles = handles
      sdkMock.dispatchers.push(this)
      return this
    }
  }
  class FakeWSClient {
    close = vi.fn()
    start = vi.fn(() => Promise.resolve())
    constructor(readonly params: Record<string, unknown>) {
      sdkMock.clients.push(this)
    }
  }
  return {
    EventDispatcher: FakeEventDispatcher,
    WSClient: FakeWSClient,
    Domain: { Feishu: 0, Lark: 1 },
    LoggerLevel: { error: 1, warn: 2, info: 3, debug: 4, trace: 5, fatal: 6 },
  }
})

function options(overrides: Partial<FeishuBotProviderOptions> = {}): () => FeishuBotProviderOptions {
  return () => ({
    appId: 'app',
    appSecret: 'secret',
    baseURL: 'https://open.feishu.cn/open-apis',
    ...overrides,
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function expectFetchUrls(urls: string[]): void {
  const calls = vi.mocked(fetch).mock.calls
  expect(calls.map(call => call[0] as unknown as string)).toEqual(urls)
}

describe('FeishuBotProvider.available', () => {
  it('is available with literal credentials and a parseable base URL', () => {
    expect(new FeishuBotProvider(options()).available()).toBe(true)
  })

  it('is unavailable without any credential source', () => {
    expect(new FeishuBotProvider(() => ({ baseURL: 'https://open.feishu.cn/open-apis' })).available()).toBe(false)
  })

  it('is available with resolvers even without literal credentials', () => {
    expect(new FeishuBotProvider(() => ({
      baseURL: 'https://open.feishu.cn/open-apis',
      resolveAppId: async () => 'app',
      resolveAppSecret: async () => 'secret',
    })).available()).toBe(true)
  })

  it('is unavailable with an unparseable base URL', () => {
    expect(new FeishuBotProvider(options({ baseURL: 'not a url' })).available()).toBe(false)
  })
})

describe('FeishuBotProvider.sendMessage', () => {
  it('fetches a token then sends the message', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: 'tok', expire: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { message_id: 'mid' } })))
    const provider = new FeishuBotProvider(options())
    const result = await provider.sendMessage({ receiveId: 'ou_x', content: 'hi', receiveIdType: 'open_id' })
    expect(result).toEqual({ messageId: 'mid' })
    expectFetchUrls([
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
    ])
  })

  it('reuses the cached token for a second send', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: 'tok', expire: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { message_id: 'm1' } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { message_id: 'm2' } })))
    const provider = new FeishuBotProvider(options())
    await provider.sendMessage({ receiveId: 'ou_x', content: 'a' })
    await provider.sendMessage({ receiveId: 'ou_x', content: 'b' })
    // Token fetched once, then two sends: three total calls.
    expect(vi.mocked(fetch).mock.calls).toHaveLength(3)
  })

  it('throws FEISHU_PROVIDER_AUTH_FAILED on a token-endpoint error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ code: 99991663, msg: 'bad credentials' })))
    const provider = new FeishuBotProvider(options())
    await expect(provider.sendMessage({ receiveId: 'ou_x', content: 'hi' })).rejects.toThrow(
      expect.objectContaining({ code: 'FEISHU_PROVIDER_AUTH_FAILED' }),
    )
  })

  it('throws FEISHU_PROVIDER_ERROR on a send-endpoint error', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: 'tok', expire: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ code: 1, msg: 'bad' })))
    const provider = new FeishuBotProvider(options())
    await expect(provider.sendMessage({ receiveId: 'ou_x', content: 'hi' })).rejects.toThrow(
      expect.objectContaining({ code: 'FEISHU_PROVIDER_ERROR' }),
    )
  })

  it('throws FEISHU_PROVIDER_ERROR when the send result has no message_id', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: 'tok', expire: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ code: 0 })))
    const provider = new FeishuBotProvider(options())
    await expect(provider.sendMessage({ receiveId: 'ou_x', content: 'hi' })).rejects.toThrow(
      expect.objectContaining({ code: 'FEISHU_PROVIDER_ERROR' }),
    )
  })

  it('throws FEISHU_PROVIDER_CREDENTIAL_MISSING when the resolver returns nothing', async () => {
    const provider = new FeishuBotProvider(() => ({
      baseURL: 'https://open.feishu.cn/open-apis',
      resolveAppId: async () => undefined,
      resolveAppSecret: async () => undefined,
    }))
    await expect(provider.sendMessage({ receiveId: 'ou_x', content: 'hi' })).rejects.toThrow(
      expect.objectContaining({ code: 'FEISHU_PROVIDER_CREDENTIAL_MISSING' }),
    )
  })

  it('throws FEISHU_ABORTED for a pre-aborted signal', async () => {
    const provider = new FeishuBotProvider(options())
    const controller = new AbortController()
    controller.abort()
    await expect(provider.sendMessage({ receiveId: 'ou_x', content: 'hi' }, controller.signal)).rejects.toThrow(
      expect.objectContaining({ code: 'FEISHU_ABORTED' }),
    )
  })
})

describe('FeishuBotProvider.startReceiving', () => {
  beforeEach(() => {
    sdkMock.clients.length = 0
    sdkMock.dispatchers.length = 0
  })

  /** Flush the async connect chain (all microtasks; no real timers involved). */
  function flush(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
  }

  it('constructs the WS client with resolved credentials and the base-URL origin', async () => {
    const provider = new FeishuBotProvider(options())
    provider.startReceiving(() => {})
    await flush()
    expect(sdkMock.clients).toHaveLength(1)
    expect(sdkMock.clients[0]!.params).toMatchObject({
      appId: 'app',
      appSecret: 'secret',
      domain: 'https://open.feishu.cn',
      autoReconnect: true,
      source: 'deepseek-harness',
    })
    expect(sdkMock.clients[0]!.start).toHaveBeenCalledWith({ eventDispatcher: sdkMock.dispatchers[0] })
  })

  it('dispatches text events and drops non-text or empty content', async () => {
    const received: FeishuReceiveEvent[] = []
    const provider = new FeishuBotProvider(options())
    provider.startReceiving(event => received.push(event))
    await flush()
    expect(sdkMock.dispatchers).toHaveLength(1)
    const onMessage = sdkMock.dispatchers[0]!.handles['im.message.receive_v1']!

    onMessage({
      sender: { sender_id: { open_id: 'ou_1', union_id: 'on_1' }, sender_type: 'open_id' },
      message: { chat_id: 'oc_1', message_type: 'text', content: JSON.stringify({ text: 'hello' }) },
    })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      eventType: 'im.message.receive_v1',
      senderId: 'ou_1',
      senderIdType: 'open_id',
      chatId: 'oc_1',
      content: 'hello',
    })

    onMessage({ sender: {}, message: { message_type: 'image', content: '{}' } })
    onMessage({ sender: {}, message: { message_type: 'text', content: JSON.stringify({ text: '' }) } })
    expect(received).toHaveLength(1)
  })

  it('closes the connection and marks receive inactive on disposal', async () => {
    const provider = new FeishuBotProvider(options())
    const dispose = provider.startReceiving(() => {})
    await flush()
    expect(sdkMock.clients[0]!.close).not.toHaveBeenCalled()
    dispose()
    expect(sdkMock.clients[0]!.close).toHaveBeenCalledWith({ force: true })
    await expect(provider.status()).resolves.toMatchObject({ receiveActive: false })
  })

  it('records a connection failure via the WS onError callback', async () => {
    const errorLogger = vi.fn()
    const provider = new FeishuBotProvider(options({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: errorLogger },
    }))
    provider.startReceiving(() => {})
    await flush()
    const onError = sdkMock.clients[0]!.params.onError as (error: Error) => void
    onError(new Error('connection refused'))
    expect(errorLogger).toHaveBeenCalled()
    await expect(provider.status()).resolves.toMatchObject({ state: 'error' })
  })

  it('records a setup failure when credential resolution rejects', async () => {
    const errorLogger = vi.fn()
    const provider = new FeishuBotProvider(() => ({
      baseURL: 'https://open.feishu.cn/open-apis',
      resolveAppId: async () => { throw new Error('boom') },
      resolveAppSecret: async () => 'secret',
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: errorLogger },
    }))
    const dispose = provider.startReceiving(() => {})
    await flush()
    dispose()
    expect(errorLogger).toHaveBeenCalled()
    await expect(provider.status()).resolves.toMatchObject({ state: 'error', receiveActive: false })
  })
})

describe('FeishuBotProvider.startReceivingCardActions', () => {
  beforeEach(() => {
    sdkMock.clients.length = 0
    sdkMock.dispatchers.length = 0
  })

  /** Flush the async connect chain (all microtasks; no real timers involved). */
  function flush(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
  }

  it('shares ONE long connection between message and card-action subscribers', async () => {
    const provider = new FeishuBotProvider(options())
    const disposeMessage = provider.startReceiving(() => {})
    const disposeCard = provider.startReceivingCardActions(() => {})
    await flush()
    expect(sdkMock.clients).toHaveLength(1)

    disposeMessage()
    expect(sdkMock.clients[0]!.close).not.toHaveBeenCalled()
    await expect(provider.status()).resolves.toMatchObject({ receiveActive: true })

    disposeCard()
    expect(sdkMock.clients[0]!.close).toHaveBeenCalledWith({ force: true })
    await expect(provider.status()).resolves.toMatchObject({ receiveActive: false })
  })

  it('ignores a second dispose and never closes a reopened connection', async () => {
    const provider = new FeishuBotProvider(options())
    const disposeFirst = provider.startReceivingCardActions(() => {})
    await flush()
    disposeFirst()
    disposeFirst()
    provider.startReceivingCardActions(() => {})
    await flush()
    expect(sdkMock.clients).toHaveLength(2)
    expect(sdkMock.clients[1]!.close).not.toHaveBeenCalled()
  })

  it('normalizes card actions with context-nested ids and passes the value through', async () => {
    const actions: FeishuCardActionEvent[] = []
    const provider = new FeishuBotProvider(options())
    provider.startReceivingCardActions(event => actions.push(event))
    await flush()
    const onCardAction = sdkMock.dispatchers[0]!.handles['card.action.trigger']!

    const raw = {
      context: { open_chat_id: 'oc_1', open_message_id: 'om_1' },
      operator: { open_id: 'ou_1' },
      action: { tag: 'button', value: { nonce: 'n1' } },
    }
    onCardAction(raw)
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      operatorId: 'ou_1',
      chatId: 'oc_1',
      messageId: 'om_1',
      value: { nonce: 'n1' },
    })
    expect(actions[0]!.raw).toBe(raw)
  })

  it('passes a submitted form value through to card-action subscribers', async () => {
    const actions: FeishuCardActionEvent[] = []
    const provider = new FeishuBotProvider(options())
    provider.startReceivingCardActions(event => actions.push(event))
    await flush()
    const onCardAction = sdkMock.dispatchers[0]!.handles['card.action.trigger']!

    onCardAction({
      context: { open_chat_id: 'oc_3', open_message_id: 'om_3' },
      operator: { open_id: 'ou_3' },
      action: { tag: 'button', value: { nonce: 'n3' }, form_value: { q1: ['0'], q1x: 'custom' } },
    })
    // Garbage form values (non-objects) stay absent rather than leaking.
    onCardAction({ action: { tag: 'button', form_value: 'garbage' } })
    expect(actions).toHaveLength(2)
    expect(actions[0]!.formValue).toEqual({ q1: ['0'], q1x: 'custom' })
    expect(actions[1]!.formValue).toBeUndefined()
  })

  it('falls back to top-level ids and tolerates malformed payloads', async () => {
    const actions: FeishuCardActionEvent[] = []
    const provider = new FeishuBotProvider(options())
    provider.startReceivingCardActions(event => actions.push(event))
    await flush()
    const onCardAction = sdkMock.dispatchers[0]!.handles['card.action.trigger']!

    onCardAction({ open_chat_id: 'oc_2', open_message_id: 'om_2', operator: { open_id: 'ou_2' }, action: {} })
    onCardAction(null)
    onCardAction('garbage')
    expect(actions).toHaveLength(3)
    expect(actions[0]).toMatchObject({ operatorId: 'ou_2', chatId: 'oc_2', messageId: 'om_2', value: undefined })
    expect(actions[1]).toEqual({ operatorId: '', chatId: '', messageId: '', value: undefined, raw: null })
    expect(actions[2]).toEqual({ operatorId: '', chatId: '', messageId: '', value: undefined, raw: 'garbage' })
  })

  it('does not deliver card actions after the subscription is disposed', async () => {
    const actions: FeishuCardActionEvent[] = []
    const provider = new FeishuBotProvider(options())
    const dispose = provider.startReceivingCardActions(event => actions.push(event))
    await flush()
    dispose()
    // A late frame on the closed dispatcher must not reach the handler.
    sdkMock.dispatchers[0]!.handles['card.action.trigger']!({ action: {} })
    expect(actions).toHaveLength(0)
  })
})

describe('FeishuBotProvider.updateMessage', () => {
  it('fetches a token then PATCHes the message content', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: 'tok', expire: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ code: 0 })))
    const provider = new FeishuBotProvider(options())
    await provider.updateMessage('om_1', '{"settled":true}')
    expectFetchUrls([
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      'https://open.feishu.cn/open-apis/im/v1/messages/om_1',
    ])
    const patchCall = vi.mocked(fetch).mock.calls[1]!
    expect(patchCall[1]).toMatchObject({ method: 'PATCH', body: JSON.stringify({ content: '{"settled":true}' }) })
  })

  it('throws FEISHU_PROVIDER_ERROR on an update-endpoint error', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: 'tok', expire: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ code: 230002, msg: 'bot capability is disabled' })))
    const provider = new FeishuBotProvider(options())
    await expect(provider.updateMessage('om_1', '{}')).rejects.toThrow(
      expect.objectContaining({ code: 'FEISHU_PROVIDER_ERROR' }),
    )
  })

  it('throws FEISHU_ABORTED for a pre-aborted signal', async () => {
    const provider = new FeishuBotProvider(options())
    const controller = new AbortController()
    controller.abort()
    await expect(provider.updateMessage('om_1', '{}', controller.signal)).rejects.toThrow(
      expect.objectContaining({ code: 'FEISHU_ABORTED' }),
    )
  })
})
