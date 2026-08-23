// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TdaiBotsEditor } from '../src/client/TdaiBotsEditor.tsx'
import type { TdaiBot, TdaiBotsView } from '../src/client/tdai-bots.ts'

afterEach(cleanup)

const t = (key: string): string => key

function makeProps(overrides: Partial<Parameters<typeof TdaiBotsEditor>[0]> = {}) {
  return {
    t,
    loadBots: vi.fn<() => Promise<TdaiBotsView>>(() => Promise.resolve({
      available: true,
      writable: true,
      bots: [{ id: 'bot-a', appId: 'app-a', teamId: 'team-t' }],
    })),
    saveBots: vi.fn<(bots: readonly TdaiBot[]) => Promise<void>>(() => Promise.resolve()),
    listTeams: vi.fn(() => Promise.resolve([])),
    listAgents: vi.fn(() => Promise.resolve([])),
    statuses: [],
    ...overrides,
  }
}

describe('TdaiBotsEditor', () => {
  it('seeds the resolved bots and saves after an add', async () => {
    const saveBots = vi.fn<(bots: readonly TdaiBot[]) => Promise<void>>(() => Promise.resolve())
    render(<TdaiBotsEditor {...makeProps({ saveBots })} />)

    await screen.findByDisplayValue('app-a')
    // Team/agent are catalog-only selects; the empty catalog leaves them disabled,
    // so only the id and app id render as seeded text.
    expect(screen.getByDisplayValue('bot-a')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'botAdd' }))
    fireEvent.click(screen.getByRole('button', { name: 'botSave' }))

    await waitFor(() => { expect(saveBots).toHaveBeenCalled() })
    const saved = saveBots.mock.calls[0]![0]
    expect(saved).toHaveLength(2)
    expect(saved[0]).toEqual({ id: 'bot-a', appId: 'app-a', teamId: 'team-t' })
  })

  it('hides the editor when the namespace is not available', async () => {
    const { container } = render(<TdaiBotsEditor {...makeProps({
      loadBots: () => Promise.resolve({ available: false, writable: false, bots: [] }),
    })} />)
    await waitFor(() => { expect(container.querySelector('section')).toBeNull() })
  })

  it('shows an error state when the load rejects', async () => {
    render(<TdaiBotsEditor {...makeProps({
      loadBots: () => Promise.reject(new Error('boom')),
    })} />)
    await screen.findByRole('alert')
  })

  it('renders catalog selects when teams and agents are available', async () => {
    render(<TdaiBotsEditor {...makeProps({
      listTeams: () => Promise.resolve([{ teamId: 'team-t', name: 'DSH' }]),
      listAgents: () => Promise.resolve([{ agentId: 'agt-a', name: 'BugFixer' }]),
    })} />)
    await screen.findByDisplayValue('app-a')
    expect(await screen.findByText('DSH')).toBeTruthy()
    expect(await screen.findByText('BugFixer')).toBeTruthy()
  })
})
