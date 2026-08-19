// @vitest-environment jsdom
/** Memory section rendering: copy, panel URL resolution, and the open-in-new-tab action. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemorySection, panelUrl } from '../src/client/MemorySection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]

describe('panelUrl', () => {
  it('keeps the fixed local origin for a loopback page regardless of its hostname', () => {
    expect(panelUrl('127.0.0.1', true)).toBe('http://127.0.0.1:8123')
    expect(panelUrl('localhost', true)).toBe('http://127.0.0.1:8123')
    expect(panelUrl('[::1]', true)).toBe('http://127.0.0.1:8123')
  })

  it('reuses the page host on the panel port for a LAN origin', () => {
    expect(panelUrl('192.168.1.5', false)).toBe('http://192.168.1.5:8123')
    expect(panelUrl('harness.internal', false)).toBe('http://harness.internal:8123')
  })
})

describe('MemorySection', () => {
  it('renders the title, intro, panel URL, and an open button', () => {
    render(<MemorySection t={t} isLoopback={true} />)
    expect(screen.getByText('Memory Hub')).toBeTruthy()
    expect(screen.getByText('Open memory panel')).toBeTruthy()
    expect(screen.getByText('http://127.0.0.1:8123')).toBeTruthy()
  })

  it('opens the panel in a new tab on click', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<MemorySection t={t} isLoopback={true} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open memory panel' }))
    expect(open).toHaveBeenCalledWith('http://127.0.0.1:8123', '_blank', 'noopener,noreferrer')
    open.mockRestore()
  })
})
