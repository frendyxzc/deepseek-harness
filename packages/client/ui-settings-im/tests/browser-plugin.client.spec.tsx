// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS } from '../src/client/index.ts'
import { FeishuStatusTab } from '../src/client/FeishuStatusTab.tsx'
import type { FeishuStatusTabInjected } from '../src/client/FeishuStatusTab.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

type StatusResult =
  | { readonly ok: true; readonly value: Array<{ readonly id: string; readonly state: string; readonly receiveActive: boolean }> }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  const status = vi.fn<() => Promise<StatusResult>>()
    .mockResolvedValue({ ok: true, value: [{ id: 'bot', state: 'connected', receiveActive: false }] })
  ctx.provide('remote.feishuStatus', { list: status })
  ctx.provide('remote.tdaiMemory', { listTeams: async () => [], listAgents: async () => [] })
  ctx.provide('settingsScope', {
    bind: () => ({
      getSnapshot: () => ({ status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'memory' }),
      subscribe: () => () => {},
      set: async () => {},
      unset: async () => {},
    }),
  })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, status }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-im browser plugin', () => {
  it('declares only the services used by the Settings Remote contribution', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.feishuStatus', 'remote.tdaiMemory', 'settingsScope'])
  })

  it('registers a localized tab without reading the Remote eagerly', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('settings.plugins.tab')[0]!
    expect(entry.component).toBe(FeishuStatusTab)
    expect(entry.options).toMatchObject({ id: 'im', order: 20 })
    expect(entry.locale).toBe(NS)
    expect(resolveSlotLabel(entry.options.label)).toBe('IM')
    expect(b.status).not.toHaveBeenCalled()

    const injected = (entry.inject as unknown as () => FeishuStatusTabInjected)()
    await expect(injected.listStatus()).resolves.toEqual([{ id: 'bot', state: 'connected', receiveActive: false }])
    expect(b.status).toHaveBeenCalledOnce()
    b.status.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'unavailable' } })
    await expect(injected.listStatus()).resolves.toEqual([])
    await b.ctx.fiber.dispose()
  })

  it('follows locale and recovers across late declaration and declarer reload', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)

    const stop = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.plugins.tab')).toHaveLength(1) })
    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.plugins.tab')[0]!.options.label)).toBe('IM')

    stop()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    declare(b.slots)
    await vi.waitFor(() => {
      expect(b.slots.entries('settings.plugins.tab')[0]?.component).toBe(FeishuStatusTab)
    })

    await fiber.dispose()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    expect(() => b.locale.register(NS, 'zh', {})).not.toThrow()
    await b.ctx.fiber.dispose()
  })
})
