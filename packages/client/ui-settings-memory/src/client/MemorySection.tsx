/**
 * Memory panel settings section: a fixed jump link to the running
 * TencentDB-Agent-Memory (Memory Hub) panel opened in a new tab. The link is
 * a deployment fact, not a hidden tunable: the panel is the standalone
 * control console at the local memory stack's panel port.
 */

import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MemoryKey } from './locales.ts'
import styles from './MemorySection.module.css'

/**
 * The standalone memory stack's panel port. The deepseek-harness repo carries
 * no memory panel of its own; the panel is the TencentDB-Agent-Memory control
 * console on the same machine the DSH session's memory proxy (8096) binds.
 */
const PANEL_PORT = 8123

/**
 * Resolve the memory panel's origin for the page the section renders on. A
 * loopback page keeps the fixed local origin; a LAN origin reuses the same
 * host on the panel port, so the jump link follows the reachability the
 * browser already has to DSH itself.
 * @param hostname - the page's own host (`location.hostname`).
 * @param isLoopback - whether that host is loopback (the connection classification).
 * @returns the panel origin to open.
 */
export function panelUrl(hostname: string, isLoopback: boolean): string {
  return `http://${isLoopback ? '127.0.0.1' : hostname}:${PANEL_PORT}`
}

/** Injected dependencies of {@link MemorySection} (slot `inject`). */
export interface MemorySectionInjected {
  /** Section copy. */
  t: (key: MemoryKey) => string
  /** Whether the page reached DSH over loopback (false = a LAN origin). */
  isLoopback: boolean
}

/** Props delivered by the slot outlet: the inject face spread flat. */
export type MemorySectionProps = Partial<MemorySectionInjected>

/**
 * Render the Memory panel section content column.
 * @param props - composed slot props (`inject` face).
 * @returns the section element tree, or `null` before the shell injects.
 */
export function MemorySection(props: MemorySectionProps): ReactNode {
  const { t, isLoopback } = props
  if (t === undefined || isLoopback === undefined) return null
  const url = panelUrl(window.location.hostname, isLoopback)
  return (
    <div className={styles.section}>
      <h2 className={styles.title}>{t('title')}</h2>
      <p className={styles.intro}>{t('intro')}</p>
      <p className={styles.url}>
        {t('urlLabel')}: <code>{url}</code>
      </p>
      <Button
        variant="primary"
        onClick={() => { window.open(url, '_blank', 'noopener,noreferrer') }}
      >
        {t('open')}
      </Button>
    </div>
  )
}
