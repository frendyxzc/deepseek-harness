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

  it('extracts post (rich-text) content and carries message/quote ids', async () => {
    const received: FeishuReceiveEvent[] = []
    const provider = new FeishuBotProvider(options())
    provider.startReceiving(event => received.push(event))
    await flush()
    const onMessage = sdkMock.dispatchers[0]!.handles['im.message.receive_v1']!

    onMessage({
      sender: { sender_id: { open_id: 'ou_1' }, sender_type: 'open_id' },
      message: {
        message_id: 'om_9',
        parent_id: 'om_8',
        root_id: 'om_7',
        chat_id: 'oc_1',
        message_type: 'post',
        content: JSON.stringify({
          title: 'a title',
          content: [
            [{ tag: 'text', text: 'hello ' }, { tag: 'a', text: 'Feishu', href: 'https://feishu.cn' }],
            [{ tag: 'at', user_id: 'ou_2', user_name: 'Alice' }],
          ],
        }),
      },
    })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      chatId: 'oc_1',
      messageId: 'om_9',
      parentId: 'om_8',
      rootId: 'om_7',
      content: 'a title\nhello [Feishu](https://feishu.cn)\n@Alice',
    })
  })

  it('extracts interactive card content into text', async () => {
    const received: FeishuReceiveEvent[] = []
    const provider = new FeishuBotProvider(options())
    provider.startReceiving(event => received.push(event))
    await flush()
    const onMessage = sdkMock.dispatchers[0]!.handles['im.message.receive_v1']!

    onMessage({
      sender: { sender_id: { open_id: 'ou_1' }, sender_type: 'open_id' },
      message: {
        message_id: 'om_c',
        chat_id: 'oc_1',
        message_type: 'interactive',
        content: JSON.stringify({
          header: { title: { tag: 'plain_text', content: 'Approval' } },
          elements: [
            { tag: 'div', text: { tag: 'lark_md', content: 'Release **v1.0**?' } },
            { tag: 'button', text: { tag: 'plain_text', content: 'Approve' } },
          ],
        }),
      },
    })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      chatId: 'oc_1',
      messageId: 'om_c',
      content: 'Approval\nRelease **v1.0**?\nApprove',
    })
  })

  it('extracts a v2 (cubed) card header subtitle and nested body', async () => {
    const received: FeishuReceiveEvent[] = []
    const provider = new FeishuBotProvider(options())
    provider.startReceiving(event => received.push(event))
    await flush()
    const onMessage = sdkMock.dispatchers[0]!.handles['im.message.receive_v1']!

    onMessage({
      sender: { sender_id: { open_id: 'ou_1' }, sender_type: 'open_id' },
      message: {
        message_id: 'om_c2',
        chat_id: 'oc_1',
        message_type: 'interactive',
        content: JSON.stringify({
          schema: '2.0',
          header: {
            title: { tag: 'plain_text', content: 'Title' },
            subtitle: { tag: 'plain_text', content: 'Subtitle' },
          },
          body: {
            elements: [
              { tag: 'column_set', columns: [{ tag: 'column', elements: [
                { tag: 'div', text: { tag: 'lark_md', content: 'Body' } },
              ] }] },
            ],
          },
        }),
      },
    })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      chatId: 'oc_1',
      messageId: 'om_c2',
      content: 'Title\nSubtitle\nBody',
    })
  })

  it('renders a card image caption and a placeholder for uncaptioned images', async () => {
    const received: FeishuReceiveEvent[] = []
    const provider = new FeishuBotProvider(options())
    provider.startReceiving(event => received.push(event))
    await flush()
    const onMessage = sdkMock.dispatchers[0]!.handles['im.message.receive_v1']!

    onMessage({
      sender: { sender_id: { open_id: 'ou_1' }, sender_type: 'open_id' },
      message: {
        message_id: 'om_c3',
        chat_id: 'oc_1',
        message_type: 'interactive',
        content: JSON.stringify({
          elements: [
            { tag: 'img', img_key: 'img_1', alt: { tag: 'plain_text', content: 'a chart' } },
            { tag: 'img', img_key: 'img_2' },
          ],
        }),
      },
    })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      chatId: 'oc_1',
      messageId: 'om_c3',
      content: 'a chart\n[图片]',
    })
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

describe('FeishuBotProvider.getMessage', () => {
  it('fetches a token then GETs the message and extracts its content', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: 'tok', expire: 7200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: {
          items: [{
            message_id: 'om_1',
            parent_id: 'om_0',
            root_id: 'om_0',
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'quoted text' }) },
          }],
        },
      })))
    const provider = new FeishuBotProvider(options())
    const result = await provider.getMessage('om_1')
    expect(result).toEqual({
      messageId: 'om_1',
      msgType: 'text',
      content: 'quoted text',
      parentId: 'om_0',
      rootId: 'om_0',
      raw: expect.objectContaining({ message_id: 'om_1' }),
    })
    expectFetchUrls([
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      'https://open.feishu.cn/open-apis/im/v1/messages/om_1',
    ])
    const getCall = vi.mocked(fetch).mock.calls[1]!
    expect(getCall[1]).toMatchObject({ method: 'GET' })
  })

  it('extracts a referenced interactive card returned in post-shaped form', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: 'tok', expire: 7200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: {
          items: [{
            message_id: 'om_card',
            msg_type: 'interactive',
            body: {
              content: JSON.stringify({
                title: null,
                elements: [
                  [
                    { tag: 'text', text: '✅ Answered\n' },
                    { tag: 'text', text: 'The agent has a question' },
                    { tag: 'a', text: 'help', href: 'https://feishu.cn/help' },
                    { tag: 'text', text: '\n是,关联团队资产' },
                  ],
                ],
              }),
            },
          }],
        },
      })))
    const provider = new FeishuBotProvider(options())
    const result = await provider.getMessage('om_card')
    expect(result).toEqual({
      messageId: 'om_card',
      msgType: 'interactive',
      content: '✅ Answered\nThe agent has a question[help](https://feishu.cn/help)\n是,关联团队资产',
      raw: expect.objectContaining({ message_id: 'om_card' }),
    })
  })

  it('returns empty content and no references for a message without them', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: 'tok', expire: 7200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { items: [{ message_id: 'om_2', msg_type: 'image', body: { content: '{"image_key":"img_1"}' } }] },
      })))
    const provider = new FeishuBotProvider(options())
    const result = await provider.getMessage('om_2')
    expect(result).toEqual({
      messageId: 'om_2',
      msgType: 'image',
      content: '',
      raw: expect.objectContaining({ message_id: 'om_2' }),
    })
  })

  it('throws FEISHU_PROVIDER_ERROR when the endpoint returns no message', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: 'tok', expire: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { items: [] } })))
    const provider = new FeishuBotProvider(options())
    await expect(provider.getMessage('om_3')).rejects.toThrow(
      expect.objectContaining({ code: 'FEISHU_PROVIDER_ERROR' }),
    )
  })

  it('throws FEISHU_PROVIDER_ERROR on an API error', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: 'tok', expire: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ code: 99991663, msg: 'not found' })))
    const provider = new FeishuBotProvider(options())
    await expect(provider.getMessage('om_4')).rejects.toThrow(
      expect.objectContaining({ code: 'FEISHU_PROVIDER_ERROR' }),
    )
  })

  it('throws FEISHU_ABORTED for a pre-aborted signal', async () => {
    const provider = new FeishuBotProvider(options())
    const controller = new AbortController()
    controller.abort()
    await expect(provider.getMessage('om_1', controller.signal)).rejects.toThrow(
      expect.objectContaining({ code: 'FEISHU_ABORTED' }),
    )
  })
})
