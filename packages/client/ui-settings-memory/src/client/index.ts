/**
 * Memory panel settings section plugin, browser half: registers the Memory
 * section (a jump link to the running TencentDB-Agent-Memory panel) on the
 * settings surface owned by ui-settings-general. Export discipline:
 * packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { MemorySection } from './MemorySection.tsx'
import type { MemorySectionInjected } from './MemorySection.tsx'
import { en, zh, type MemoryKey } from './locales.ts'

export type { MemorySectionInjected, MemorySectionProps } from './MemorySection.tsx'
export type { MemoryKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Memory panel section copy. */
    'settings.memory': MemoryKey
  }
}

/** Dictionary namespace owned by this plugin (section copy). */
const NS = 'settings.memory'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registration depends on the slot through `slots.inject()`.
 */
export const inject = ['slots', 'locale']

/**
 * Register the `settings.memory` dictionaries and the Memory section once the
 * `settings.section` declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-memory: copy dictionaries')

  const t = ctx.locale.bind(NS) as MemorySectionInjected['t']
  const injected = (): MemorySectionInjected => ({ t })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'memory',
    order: 20,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, MemorySection))
}
