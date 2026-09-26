/** The per-bot mapping controller over a real configuration form. */

import { describe, expect, it, vi } from 'vitest'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { TdaiBotsController, type TdaiBot, type TdaiBotsSection } from '../src/client/tdai-bots.ts'

function formOf(snapshot: ConfigFormSnapshot<TdaiBotsSection>): ConfigForm<TdaiBotsSection> {
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
      return true
    }),
    unset: vi.fn(async () => true),
    mutate: vi.fn(async () => true),
  }
}

const ready = (bots: unknown, writable = true): ConfigFormSnapshot<TdaiBotsSection> => ({
  status: 'ready', value: { bots: bots as TdaiBot[] }, base: undefined, user: undefined, revision: 1, writable, mode: 'host',
})

describe('TdaiBotsController', () => {
  it('loads the resolved bots once the form is ready', async () => {
    const scope = formOf(ready([{ id: 'bot-a', appId: 'a', teamId: 't' }]))
    const controller = new TdaiBotsController(scope)
    await expect(controller.load()).resolves.toEqual({ available: true, writable: true, bots: [{ id: 'bot-a', appId: 'a', teamId: 't' }] })
  })

  it('waits out a loading snapshot and then resolves', async () => {
    const scope = formOf({ status: 'loading', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'host' })
    const controller = new TdaiBotsController(scope)
    const pending = controller.load()
    // Advance the snapshot to ready; the controller resolves on the next publish.
    void scope.set('bots', [{ id: 'bot-b', appId: 'b' }])
    await expect(pending).resolves.toEqual({ available: true, writable: true, bots: [{ id: 'bot-b', appId: 'b' }] })
  })

  it('reports an unavailable namespace without waiting', async () => {
    const scope = formOf({ status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'memory' })
    const controller = new TdaiBotsController(scope)
    await expect(controller.load()).resolves.toEqual({ available: false, writable: false, bots: [] })
  })

  it('saves the whole list, stripping empty optional ids', async () => {
    const scope = formOf(ready([]))
    const controller = new TdaiBotsController(scope)
    await controller.save([
      { id: ' bot-a ', appId: ' a ', teamId: 't', agentId: '' },
    ])
    // The fake form's set() publishes immediately, so the snapshot shows the saved list.
    expect(scope.getSnapshot().value).toEqual({ bots: [{ id: 'bot-a', appId: 'a', teamId: 't' }] })
  })
})
