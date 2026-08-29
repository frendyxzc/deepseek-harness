import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import FeishuRuntime, { type FeishuProvider, type FeishuProviderStatus } from '@deepseek-ai/dsh-feishu'
import FeishuStatusGateway from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function makeProvider(overrides: Partial<FeishuProvider> = {}): FeishuProvider {
  return {
    id: 'bot',
    available: () => true,
    sendMessage: async () => ({ messageId: 'm1' }),
    ...overrides,
  }
}

async function harness(config: { provider?: string } = {}): Promise<{
  ctx: Context
  gateway: FeishuStatusGateway
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(FeishuRuntime, config)
  await ctx.plugin(FeishuStatusGateway)
  const gateway = ctx.get('feishuStatus') as FeishuStatusGateway
  return { ctx, gateway }
}

describe('FeishuStatusGateway', () => {
  it('publishes the status and list methods under the feishuStatus namespace', async () => {
    const { gateway } = await harness()
    expect(gateway.typertRemote).toMatchObject({
      serviceKey: 'feishuStatus',
      namespace: 'feishuStatus',
    })
    expect(remoteMethods(gateway)).toEqual([
      { method: 'status', invocation: { kind: 'direct' } },
      { method: 'list', invocation: { kind: 'direct' } },
    ])
  })

  it('lists every registered bot status', async () => {
    const { ctx, gateway } = await harness()
    ctx.feishu.registerProvider(makeProvider({
      id: 'bot-a',
      status: async () => ({ state: 'connected', appSecretConfigured: true, receiveActive: true, appIdMasked: 'cli_a****' }),
    }))
    ctx.feishu.registerProvider(makeProvider({ id: 'bot-b' }))
    const list = await gateway.list()
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ id: 'bot-a', state: 'connected', receiveActive: true, maskedAppId: 'cli_a****', appSecretConfigured: true })
    expect(list[1]).toMatchObject({ id: 'bot-b', state: 'connected', receiveActive: false, appSecretConfigured: false })
  })

  it('projects the seam status for a provider without a status report', async () => {
    const { ctx, gateway } = await harness()
    ctx.feishu.registerProvider(makeProvider())
    await expect(gateway.status()).resolves.toEqual({ state: 'connected', providerId: 'bot' })
  })

  it('projects the selected provider status report', async () => {
    const { ctx, gateway } = await harness()
    const report: FeishuProviderStatus = {
      state: 'unconfigured',
      appSecretConfigured: false,
      receiveActive: false,
      lastError: 'no credentials',
    }
    ctx.feishu.registerProvider(makeProvider({ status: async () => report }))
    await expect(gateway.status()).resolves.toEqual({
      state: 'unconfigured',
      providerId: 'bot',
      provider: report,
    })
  })

  it('projects selection failures without throwing', async () => {
    const { gateway } = await harness({ provider: 'missing' })
    await expect(gateway.status()).resolves.toEqual({
      state: 'error',
      providerId: 'missing',
      selectionError: 'configured Feishu provider "missing" is not registered',
    })
  })
})
