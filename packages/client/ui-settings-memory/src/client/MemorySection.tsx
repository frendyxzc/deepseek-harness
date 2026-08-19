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
 * The local memory stack's panel origin. The deepseek-harness repo carries no
 * memory panel of its own; this points at the standalone TencentDB-Agent-Memory
 * panel that the DSH session's memory proxy (8096) binds against.
 */
const PANEL_URL = 'http://127.0.0.1:8123'

/** Injected dependencies of {@link MemorySection} (slot `inject`). */
export interface MemorySectionInjected {
  /** Section copy. */
  t: (key: MemoryKey) => string
}

/** Props delivered by the slot outlet: the inject face spread flat. */
export type MemorySectionProps = Partial<MemorySectionInjected>

/**
 * Render the Memory panel section content column.
 * @param props - composed slot props (`inject` face).
 * @returns the section element tree, or `null` before the shell injects.
 */
export function MemorySection(props: MemorySectionProps): ReactNode {
  const { t } = props
  if (t === undefined) return null
  return (
    <div className={styles.section}>
      <h2 className={styles.title}>{t('title')}</h2>
      <p className={styles.intro}>{t('intro')}</p>
      <p className={styles.url}>
        {t('urlLabel')}: <code>{PANEL_URL}</code>
      </p>
      <Button
        variant="primary"
        onClick={() => { window.open(PANEL_URL, '_blank', 'noopener,noreferrer') }}
      >
        {t('open')}
      </Button>
    </div>
  )
}
