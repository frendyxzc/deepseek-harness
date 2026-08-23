/** The per-bot mapping controller over a real settings scope. */

import { describe, expect, it, vi } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { TdaiBotsController, type TdaiBot, type TdaiBotsSection } from '../src/client/tdai-bots.ts'

function scopeOf(snapshot: SettingsScopeSnapshot<TdaiBotsSection>): SettingsScope<TdaiBotsSection> {
  const listeners = new Set<() => void>()
  let current = snapshot
  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: vi.fn(async (field: string, value: unknown) => {
      current = {
        ...current,
        status: 'ready',
        writable: true,
        revision: (current.revision ?? 0) + 1,
        value: { ...(current.value ?? {}), [field]: value },
      }
      for (const listener of [...listeners]) listener()
    }),
    unset: vi.fn(async () => {}),
  }
}

const ready = (bots: unknown, writable = true): SettingsScopeSnapshot<TdaiBotsSection> => ({
  status: 'ready', value: { bots: bots as TdaiBot[] }, base: undefined, user: undefined, revision: 1, writable, mode: 'host',
})

describe('TdaiBotsController', () => {
  it('loads the resolved bots once the scope is ready', async () => {
    const scope = scopeOf(ready([{ id: 'bot-a', appId: 'a', teamId: 't' }]))
    const controller = new TdaiBotsController(scope)
    await expect(controller.load()).resolves.toEqual({ available: true, writable: true, bots: [{ id: 'bot-a', appId: 'a', teamId: 't' }] })
  })

  it('waits out a loading snapshot and then resolves', async () => {
    const scope = scopeOf({ status: 'loading', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'host' })
    const controller = new TdaiBotsController(scope)
    const pending = controller.load()
    // Advance the snapshot to ready; the controller resolves on the next publish.
    scope.set('bots', [{ id: 'bot-b', appId: 'b' }])
    await expect(pending).resolves.toEqual({ available: true, writable: true, bots: [{ id: 'bot-b', appId: 'b' }] })
  })

  it('reports an unavailable namespace without waiting', async () => {
    const scope = scopeOf({ status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'memory' })
    const controller = new TdaiBotsController(scope)
    await expect(controller.load()).resolves.toEqual({ available: false, writable: false, bots: [] })
  })

  it('saves the whole list, stripping empty optional ids', async () => {
    const scope = scopeOf(ready([]))
    const controller = new TdaiBotsController(scope)
    await controller.save([
      { id: ' bot-a ', appId: ' a ', teamId: 't', agentId: '' },
    ])
    expect(scope.set).toHaveBeenCalledWith('bots', [{ id: 'bot-a', appId: 'a', teamId: 't' }])
  })
})
