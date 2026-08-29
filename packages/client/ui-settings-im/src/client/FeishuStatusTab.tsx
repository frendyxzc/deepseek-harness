import { useEffect, useState, type ReactNode } from 'react'
import type { FeishuBotStatusView, TdaiAgentOption, TdaiTeamOption } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { TdaiBotsEditor } from './TdaiBotsEditor.tsx'
import { FeishuLogo } from './FeishuLogo.tsx'
import type { TdaiBot, TdaiBotsView } from './tdai-bots.ts'
import css from './FeishuStatusTab.module.css'

/** Registration-side Remote face used by the section. */
export interface FeishuStatusTabInjected {
  /** Read each bot's display-safe status. */
  listStatus: () => Promise<FeishuBotStatusView[]>
  /** Read the current per-bot mapping. */
  loadBots: () => Promise<TdaiBotsView>
  /** Persist the whole per-bot mapping. */
  saveBots: (bots: readonly TdaiBot[]) => Promise<void>
  /** Read the TDAI core team catalog. */
  listTeams: () => Promise<TdaiTeamOption[]>
  /** Read one team's agent catalog. */
  listAgents: (teamId: string) => Promise<TdaiAgentOption[]>
}

/** Full component props assembled by the Settings slot renderer. */
export type FeishuStatusTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.im'>
  & InjectFace<FeishuStatusTabInjected>

/** Render the multi-bot manager: per-bot status plus the team/agent editor. */
export function FeishuStatusTab({ t, loadBots, saveBots, listTeams, listAgents, listStatus }: FeishuStatusTabProps): ReactNode {
  const [statuses, setStatuses] = useState<FeishuBotStatusView[]>([])

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => listStatus()).then(
      (view) => { if (current) setStatuses(view) },
      () => {},
    )
    return () => { current = false }
  }, [listStatus])

  return (
    <div className={css.section}>
      <header className={css.masthead}>
        <span className={css.logo} aria-hidden="true"><FeishuLogo size={26} /></span>
        <div className={css.brand}>
          <strong className={css.title}>{t('heading')}</strong>
          <p className={css.subtitle}>{t('mastheadHint')}</p>
        </div>
      </header>
      <TdaiBotsEditor t={t} loadBots={loadBots} saveBots={saveBots} listTeams={listTeams} listAgents={listAgents} statuses={statuses} />
    </div>
  )
}
