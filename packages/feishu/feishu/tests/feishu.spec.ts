import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import FeishuRuntime, {
  FeishuError,
  type FeishuCardActionEvent,
  type FeishuMessage,
  type FeishuProvider,
  type FeishuProviderStatus,
  type FeishuReceiveEvent,
  type FeishuSendRequest,
  type FeishuSendResult,
} from '@deepseek-ai/dsh-feishu'

function makeProvider(
  id: string,
  available: boolean,
  send: (request: FeishuSendRequest) => Promise<FeishuSendResult>,
  startReceiving?: (handler: (event: FeishuReceiveEvent) => void) => () => void,
  status?: () => Promise<FeishuProviderStatus>,
  startReceivingCardActions?: (handler: (event: FeishuCardActionEvent) => void) => () => void,
  updateMessage?: (messageId: string, content: string) => Promise<void>,
  getMessage?: (messageId: string) => Promise<FeishuMessage>,
): FeishuProvider {
  return {
    id,
    available: () => available,
    sendMessage: request => send(request),
    ...(startReceiving !== undefined ? { startReceiving } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(startReceivingCardActions !== undefined ? { startReceivingCardActions } : {}),
    ...(updateMessage !== undefined ? { updateMessage } : {}),
    ...(getMessage !== undefined ? { getMessage } : {}),
  }
}

const available = true
const unavailable = false

function sendResult(marker: string): FeishuSendResult {
  return { messageId: marker }
}

async function mountFeishu(config: ConstructorParameters<typeof FeishuRuntime>[1] = {}): Promise<{ ctx: Context; feishu: FeishuRuntime }> {
  const ctx = new Context()
  await ctx.plugin(FeishuRuntime, config)
  return { ctx, feishu: ctx.feishu }
}

describe('FeishuRuntime registration', () => {
  it('registers a provider and unregisters it via the returned disposer', async () => {
    const { feishu } = await mountFeishu()
    const dispose = feishu.registerProvider(makeProvider('bot', available, () => Promise.resolve(sendResult('m1'))))
    await expect(feishu.sendMessage({ receiveId: 'u1', content: 'hi' })).resolves.toMatchObject({ messageId: 'm1' })
    dispose()
    await expect(feishu.sendMessage({ receiveId: 'u1', content: 'hi' })).rejects.toThrow(expect.objectContaining({ code: 'FEISHU_PROVIDER_UNAVAILABLE' }))
  })

  it('throws FEISHU_DUPLICATE_PROVIDER on a duplicate id', async () => {
    const { feishu } = await mountFeishu()
    feishu.registerProvider(makeProvider('bot', available, () => Promise.resolve(sendResult('m1'))))
    expect(() => feishu.registerProvider(makeProvider('bot', available, () => Promise.resolve(sendResult('m2')))))
      .toThrow(expect.objectContaining({ code: 'FEISHU_DUPLICATE_PROVIDER' }))
  })

  it('disposes provider registrations when the contributing fiber is disposed (HMR safety)', async () => {
    const { ctx, feishu } = await mountFeishu()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.feishu.registerProvider(makeProvider('bot', available, () => Promise.resolve(sendResult('m1'))))
    }, { inject: ['feishu'] }))
    await expect(feishu.sendMessage({ receiveId: 'u1', content: 'hi' })).resolves.toMatchObject({ messageId: 'm1' })
    await fiber.dispose()
    await expect(feishu.sendMessage({ receiveId: 'u1', content: 'hi' })).rejects.toThrow(expect.objectContaining({ code: 'FEISHU_PROVIDER_UNAVAILABLE' }))
  })

  it('emits feishu/provider-added when a provider registers', async () => {
    const { ctx, feishu } = await mountFeishu()
    const added: FeishuProvider[] = []
    ctx.on('feishu/provider-added', provider => void added.push(provider))
    const provider = makeProvider('bot', available, () => Promise.resolve(sendResult('m1')))
    feishu.registerProvider(provider)
    expect(added).toEqual([provider])
  })

  it('emits feishu/provider-removed when a registration is disposed', async () => {
    const { ctx, feishu } = await mountFeishu()
    const removed: string[] = []
    ctx.on('feishu/provider-removed', id => void removed.push(id))
    const dispose = feishu.registerProvider(makeProvider('bot', available, () => Promise.resolve(sendResult('m1'))))
    dispose()
    expect(removed).toEqual(['bot'])
  })

  it('rolls registration back when a feishu/provider-added listener throws', async () => {
    const { ctx, feishu } = await mountFeishu()
    ctx.on('feishu/provider-added', () => { throw new Error('added boom') })
    expect(() => feishu.registerProvider(makeProvider('bot', available, () => Promise.resolve(sendResult('m1')))))
      .toThrow('added boom')
    await expect(feishu.sendMessage({ receiveId: 'u1', content: 'hi' })).rejects.toThrow(expect.objectContaining({ code: 'FEISHU_PROVIDER_UNAVAILABLE' }))
  })
})

describe('FeishuRuntime execution resolution', () => {
  it('throws FEISHU_PROVIDER_UNAVAILABLE when nothing is registered', async () => {
    const { feishu } = await mountFeishu()
    await expect(feishu.sendMessage({ receiveId: 'u1', content: 'hi' })).rejects.toThrow(expect.objectContaining({ code: 'FEISHU_PROVIDER_UNAVAILABLE' }))
  })

  it('throws FEISHU_PROVIDER_UNAVAILABLE when the only provider is unavailable', async () => {
    const { feishu } = await mountFeishu()
    feishu.registerProvider(makeProvider('bot', unavailable, () => Promise.resolve(sendResult('m1'))))
    await expect(feishu.sendMessage({ receiveId: 'u1', content: 'hi' })).rejects.toThrow(expect.objectContaining({ code: 'FEISHU_PROVIDER_UNAVAILABLE' }))
  })

  it('selects the sole provider without a configured id', async () => {
    const { feishu } = await mountFeishu()
    feishu.registerProvider(makeProvider('bot', available, () => Promise.resolve(sendResult('m1'))))
    await expect(feishu.sendMessage({ receiveId: 'u1', content: 'hi' })).resolves.toMatchObject({ messageId: 'm1' })
  })

  it('selects the configured provider among several', async () => {
    const { feishu } = await mountFeishu({ provider: 'bot-b' })
    feishu.registerProvider(makeProvider('bot-a', available, () => Promise.resolve(sendResult('a'))))
    feishu.registerProvider(makeProvider('bot-b', available, () => Promise.resolve(sendResult('b'))))
    await expect(feishu.sendMessage({ receiveId: 'u1', content: 'hi' })).resolves.toMatchObject({ messageId: 'b' })
  })

  it('throws FEISHU_PROVIDER_CONFIGURED_MISSING for a configured id that is not registered', async () => {
    const { feishu } = await mountFeishu({ provider: 'missing' })
    feishu.registerProvider(makeProvider('bot', available, () => Promise.resolve(sendResult('m1'))))
    await expect(feishu.sendMessage({ receiveId: 'u1', content: 'hi' })).rejects.toThrow(expect.objectContaining({ code: 'FEISHU_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('throws FEISHU_PROVIDER_CONFIGURED_UNAVAILABLE for a configured id that is unavailable', async () => {
    const { feishu } = await mountFeishu({ provider: 'bot' })
    feishu.registerProvider(makeProvider('bot', unavailable, () => Promise.resolve(sendResult('m1'))))
    await expect(feishu.sendMessage({ receiveId: 'u1', content: 'hi' })).rejects.toThrow(expect.objectContaining({ code: 'FEISHU_PROVIDER_CONFIGURED_UNAVAILABLE' }))
  })

  it('throws FEISHU_PROVIDER_AMBIGUOUS for multiple usable providers without a configured id', async () => {
    const { feishu } = await mountFeishu()
    feishu.registerProvider(makeProvider('bot-a', available, () => Promise.resolve(sendResult('a'))))
    feishu.registerProvider(makeProvider('bot-b', available, () => Promise.resolve(sendResult('b'))))
    await expect(feishu.sendMessage({ receiveId: 'u1', content: 'hi' })).rejects.toThrow(expect.objectContaining({ code: 'FEISHU_PROVIDER_AMBIGUOUS' }))
  })
})

describe('FeishuRuntime describeStatus', () => {
  it('reports unavailable when nothing is registered', async () => {
    const { feishu } = await mountFeishu()
    await expect(feishu.describeStatus()).resolves.toEqual({ state: 'unavailable' })
  })

  it('projects a status-less provider from available()', async () => {
    const { feishu } = await mountFeishu()
    feishu.registerProvider(makeProvider('bot', available, () => Promise.resolve(sendResult('m1'))))
    await expect(feishu.describeStatus()).resolves.toEqual({ state: 'connected', providerId: 'bot' })
  })

  it('projects a configured but unavailable status-less provider from available()', async () => {
    const { feishu } = await mountFeishu({ provider: 'bot' })
    feishu.registerProvider(makeProvider('bot', unavailable, () => Promise.resolve(sendResult('m1'))))
    await expect(feishu.describeStatus()).resolves.toEqual({ state: 'unavailable', providerId: 'bot' })
  })

  it('returns the selected provider status report', async () => {
    const { feishu } = await mountFeishu({ provider: 'bot' })
    const report: FeishuProviderStatus = {
      state: 'unconfigured',
      appSecretConfigured: false,
      receiveActive: false,
      lastError: 'no credentials',
    }
    feishu.registerProvider(makeProvider('bot', available, () => Promise.resolve(sendResult('m1')), undefined, async () => report))
    await expect(feishu.describeStatus()).resolves.toEqual({ state: 'unconfigured', providerId: 'bot', providerStatus: report })
  })

  it('reports error with selection detail for a configured id that is not registered', async () => {
    const { feishu } = await mountFeishu({ provider: 'missing' })
    await expect(feishu.describeStatus()).resolves.toEqual({
      state: 'error',
      providerId: 'missing',
      selectionError: 'configured Feishu provider "missing" is not registered',
    })
  })

  it('reports error with selection detail for multiple usable providers without a configured id', async () => {
    const { feishu } = await mountFeishu()
    feishu.registerProvider(makeProvider('bot-a', available, () => Promise.resolve(sendResult('a'))))
    feishu.registerProvider(makeProvider('bot-b', available, () => Promise.resolve(sendResult('b'))))
    await expect(feishu.describeStatus()).resolves.toEqual({
      state: 'error',
      selectionError: 'multiple usable Feishu providers are registered (bot-a, bot-b); configure one explicitly',
    })
  })
})

describe('FeishuRuntime receive', () => {
  it('delegates startReceiving to the selected provider and returns its disposer', async () => {
    const { feishu } = await mountFeishu()
    let handler: ((event: FeishuReceiveEvent) => void) | undefined
    const dispose = () => {}
    feishu.registerProvider(makeProvider('bot', available, () => Promise.resolve(sendResult('m1')), (h) => { handler = h; return dispose }))
    const returned = feishu.startReceiving(() => {})
    expect(returned).toBe(dispose)
    expect(handler).toBeTypeOf('function')
  })

  it('throws FEISHU_RECEIVE_UNSUPPORTED when the provider has no startReceiving', async () => {
    const { feishu } = await mountFeishu()
    feishu.registerProvider(makeProvider('bot', available, () => Promise.resolve(sendResult('m1'))))
    expect(() => feishu.startReceiving(() => {})).toThrow(expect.objectContaining({ code: 'FEISHU_RECEIVE_UNSUPPORTED' }))
  })

  it('throws FEISHU_PROVIDER_UNAVAILABLE for receive when nothing is registered', async () => {
    const { feishu } = await mountFeishu()
    expect(() => feishu.startReceiving(() => {})).toThrow(expect.objectContaining({ code: 'FEISHU_PROVIDER_UNAVAILABLE' }))
  })
})

describe('FeishuRuntime card-action receive', () => {
  it('delegates startReceivingCardActions to the selected provider and returns its disposer', async () => {
    const { feishu } = await mountFeishu()
    let handler: ((event: FeishuCardActionEvent) => void) | undefined
    const dispose = () => {}
    feishu.registerProvider(makeProvider('bot', available, () => Promise.resolve(sendResult('m1')), undefined, undefined, (h) => { handler = h; return dispose }))
    const returned = feishu.startReceivingCardActions(() => {})
    expect(returned).toBe(dispose)
    expect(handler).toBeTypeOf('function')
  })

  it('delivers card-action events with their form value intact to subscribers', async () => {
    const { feishu } = await mountFeishu()
    const seen: FeishuCardActionEvent[] = []
    let handler: ((event: FeishuCardActionEvent) => void) | undefined
    feishu.registerProvider(makeProvider('bot', available, () => Promise.resolve(sendResult('m1')), undefined, undefined, (h) => { handler = h; return () => {} }))
    feishu.startReceivingCardActions(event => seen.push(event))
    const event: FeishuCardActionEvent = {
      operatorId: 'ou_1',
      chatId: 'oc_1',
      messageId: 'om_1',
      value: { nonce: 'n1' },
      formValue: { q1: ['0'], q1x: 'custom answer' },
      raw: {},
    }
    handler!(event)
    expect(seen).toEqual([event])
  })

  it('throws FEISHU_RECEIVE_UNSUPPORTED when the provider has no startReceivingCardActions', async () => {
    const { feishu } = await mountFeishu()
    feishu.registerProvider(makeProvider('bot', available, () => Promise.resolve(sendResult('m1'))))
    expect(() => feishu.startReceivingCardActions(() => {})).toThrow(expect.objectContaining({ code: 'FEISHU_RECEIVE_UNSUPPORTED' }))
  })

  it('throws FEISHU_PROVIDER_UNAVAILABLE for card-action receive when nothing is registered', async () => {
    const { feishu } = await mountFeishu()
    expect(() => feishu.startReceivingCardActions(() => {})).toThrow(expect.objectContaining({ code: 'FEISHU_PROVIDER_UNAVAILABLE' }))
  })
})

describe('FeishuRuntime updateMessage', () => {
  it('delegates updateMessage to the selected provider', async () => {
    const { feishu } = await mountFeishu()
    const updates: Array<{ messageId: string; content: string }> = []
    feishu.registerProvider(makeProvider('bot', available, () => Promise.resolve(sendResult('m1')), undefined, undefined, undefined, async (messageId, content) => {
      updates.push({ messageId, content })
    }))
    await feishu.updateMessage('m1', '{"settled":true}')
    expect(updates).toEqual([{ messageId: 'm1', content: '{"settled":true}' }])
  })

  it('throws FEISHU_UPDATE_UNSUPPORTED when the provider has no updateMessage', async () => {
    const { feishu } = await mountFeishu()
    feishu.registerProvider(makeProvider('bot', available, () => Promise.resolve(sendResult('m1'))))
    await expect(feishu.updateMessage('m1', '{}')).rejects.toThrow(expect.objectContaining({ code: 'FEISHU_UPDATE_UNSUPPORTED' }))
  })

  it('throws FEISHU_PROVIDER_UNAVAILABLE for update when nothing is registered', async () => {
    const { feishu } = await mountFeishu()
    await expect(feishu.updateMessage('m1', '{}')).rejects.toThrow(expect.objectContaining({ code: 'FEISHU_PROVIDER_UNAVAILABLE' }))
  })
})

describe('FeishuRuntime getMessage', () => {
  it('delegates getMessage to the selected provider', async () => {
    const { feishu } = await mountFeishu()
    const fetched: string[] = []
    feishu.registerProvider(makeProvider('bot', available, () => Promise.resolve(sendResult('m1')),
      undefined, undefined, undefined, undefined, async (messageId) => {
        fetched.push(messageId)
        return { messageId, msgType: 'text', content: 'quoted', raw: {} }
      }))
    await expect(feishu.getMessage('om_1')).resolves.toMatchObject({ messageId: 'om_1', content: 'quoted' })
    expect(fetched).toEqual(['om_1'])
  })

  it('throws FEISHU_GET_UNSUPPORTED when the provider has no getMessage', async () => {
    const { feishu } = await mountFeishu()
    feishu.registerProvider(makeProvider('bot', available, () => Promise.resolve(sendResult('m1'))))
    await expect(feishu.getMessage('om_1')).rejects.toThrow(expect.objectContaining({ code: 'FEISHU_GET_UNSUPPORTED' }))
  })

  it('throws FEISHU_PROVIDER_UNAVAILABLE for get when nothing is registered', async () => {
    const { feishu } = await mountFeishu()
    await expect(feishu.getMessage('om_1')).rejects.toThrow(expect.objectContaining({ code: 'FEISHU_PROVIDER_UNAVAILABLE' }))
  })
})

describe('FeishuError', () => {
  it('is a HarnessError carrying its code', () => {
    const error = new FeishuError('boom', 'FEISHU_PROVIDER_ERROR')
    expect(error.code).toBe('FEISHU_PROVIDER_ERROR')
    expect(error.name).toBe('FeishuError')
  })
})
