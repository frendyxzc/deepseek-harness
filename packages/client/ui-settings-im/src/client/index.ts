/** Read-only Feishu integration status registered into Web Settings. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { FeishuStatusTab, type FeishuStatusTabInjected } from './FeishuStatusTab.tsx'
import { en, zh, type ImStatusLocaleKey } from './locales.ts'

export type { FeishuStatusTabInjected, FeishuStatusTabProps } from './FeishuStatusTab.tsx'
export type { ImStatusLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Read-only Feishu integration status copy. */
    'settings.im': ImStatusLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.im'

/** Services required by the Settings registration and generated Remote face. */
export const inject = ['slots', 'locale', 'remote', 'remote.feishuStatus']

/** Contribute the lazy IM status tab to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-im: dictionaries')

  const t = ctx.locale.bind(NS)
  const fetch: FeishuStatusTabInjected['fetch'] = async () => {
    const result = await ctx.remote.feishuStatus.status()
    if (!result.ok) {
      throw new Error(`feishuStatus.status failed: ${result.error.code}: ${result.error.message}`)
    }
    return result.value
  }
  const injected = (): FeishuStatusTabInjected => ({ fetch })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'im',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, FeishuStatusTab))
}
