/** Feishu multi-bot manager (status + team/agent mapping) registered into Web Settings. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { FeishuBotStatusView, TdaiAgentOption, TdaiTeamOption } from '@deepseek-ai/dsh-api-remotes/client'
import { FeishuStatusTab, type FeishuStatusTabInjected } from './FeishuStatusTab.tsx'
import { TdaiBotsController, FEISHU_BOT_SETTINGS_NAMESPACE } from './tdai-bots.ts'
import { en, zh, type ImStatusLocaleKey } from './locales.ts'

export type { FeishuStatusTabInjected, FeishuStatusTabProps } from './FeishuStatusTab.tsx'
export type { ImStatusLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Feishu integration status + multi-bot mapping copy. */
    'settings.im': ImStatusLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.im'

/** Services required by the Settings registration and generated Remote face. */
export const inject = ['slots', 'locale', 'remote', 'remote.feishuStatus', 'remote.tdaiMemory', 'settingsScope']

/** Contribute the lazy IM settings tab to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-im: dictionaries')

  const t = ctx.locale.bind(NS)
  const bots = new TdaiBotsController(ctx.settingsScope.bind({ namespace: FEISHU_BOT_SETTINGS_NAMESPACE }))
  const listStatus = async (): Promise<FeishuBotStatusView[]> => {
    const result = await ctx.remote.feishuStatus.list()
    return result.ok ? result.value : []
  }
  const listTeams = async (): Promise<TdaiTeamOption[]> => {
    const result = await ctx.remote.tdaiMemory.listTeams()
    return result.ok ? result.value : []
  }
  const listAgents = async (teamId: string): Promise<TdaiAgentOption[]> => {
    const result = await ctx.remote.tdaiMemory.listAgents(teamId)
    return result.ok ? result.value : []
  }
  const injected = (): FeishuStatusTabInjected => ({
    listStatus,
    loadBots: () => bots.load(),
    saveBots: next => bots.save(next),
    listTeams,
    listAgents,
  })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'im',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, FeishuStatusTab))
}
