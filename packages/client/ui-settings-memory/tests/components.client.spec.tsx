// @vitest-environment jsdom
/** Memory section rendering: copy, panel URL, and the open-in-new-tab action. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemorySection } from '../src/client/MemorySection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]

describe('MemorySection', () => {
  it('renders the title, intro, panel URL, and an open button', () => {
    render(<MemorySection t={t} />)
    expect(screen.getByText('Memory Hub')).toBeTruthy()
    expect(screen.getByText('Open memory panel')).toBeTruthy()
    expect(screen.getByText('http://127.0.0.1:8123')).toBeTruthy()
  })

  it('opens the panel in a new tab on click', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<MemorySection t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open memory panel' }))
    expect(open).toHaveBeenCalledWith('http://127.0.0.1:8123', '_blank', 'noopener,noreferrer')
    open.mockRestore()
  })
})
