import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FeishuBotStatusView, TdaiAgentOption, TdaiTeamOption } from '@deepseek-ai/dsh-api-remotes/client'
import { FeishuLogo } from './FeishuLogo.tsx'
import type { TdaiBot, TdaiBotsView } from './tdai-bots.ts'
import type { ImStatusLocaleKey } from './locales.ts'
import css from './TdaiBotsEditor.module.css'

/** Injected actions and catalogs the editor drives. */
export interface TdaiBotsEditorInjected {
  /** Read the current bot list (waits out the first describe). */
  loadBots: () => Promise<TdaiBotsView>
  /** Persist the whole bot list. */
  saveBots: (bots: readonly TdaiBot[]) => Promise<void>
  /** Read the TDAI core team catalog. */
  listTeams: () => Promise<TdaiTeamOption[]>
  /** Read one team's agent catalog. */
  listAgents: (teamId: string) => Promise<TdaiAgentOption[]>
}

/** Resolved component props for the editor. */
export interface TdaiBotsEditorProps {
  t: (key: ImStatusLocaleKey) => string
  loadBots: () => Promise<TdaiBotsView>
  saveBots: (bots: readonly TdaiBot[]) => Promise<void>
  listTeams: () => Promise<TdaiTeamOption[]>
  listAgents: (teamId: string) => Promise<TdaiAgentOption[]>
  /** Per-bot status from `feishuStatus.list`, keyed by bot id. */
  statuses: readonly FeishuBotStatusView[]
}

const EMPTY_BOT: TdaiBot = { id: '', appId: '', teamId: '', agentId: '' }

/** Feishu connection state → locale key. */
const STATE_KEYS: Record<string, ImStatusLocaleKey> = {
  connected: 'stateConnected',
  unconfigured: 'stateUnconfigured',
  unavailable: 'stateUnavailable',
  error: 'stateError',
}

type LoadState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; view: TdaiBotsView }

/** The multi-bot manager, styled as one plugin-configuration card. */
export function TdaiBotsEditor({ t, loadBots, saveBots, listTeams, listAgents, statuses }: TdaiBotsEditorProps): ReactNode {
  const [open, setOpen] = useState(true)
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [draft, setDraft] = useState<TdaiBot[]>([])
  const [teams, setTeams] = useState<TdaiTeamOption[]>([])
  const [agents, setAgents] = useState<Record<string, TdaiAgentOption[]>>({})
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  const statusById = new Map(statuses.map(status => [status.id, status]))

  const ensureAgents = (teamId: string): void => {
    if (teamId === '') return
    setAgents((prev) => {
      if (prev[teamId] !== undefined) return prev
      void listAgents(teamId).then((options) => {
        setAgents(current => ({ ...current, [teamId]: options }))
      }, () => {})
      return prev
    })
  }

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => loadBots()).then(
      (view) => {
        if (!current) return
        setLoad({ status: 'ready', view })
        setDraft(view.bots.map(clone))
        for (const bot of view.bots) {
          if (bot.teamId !== undefined && bot.teamId !== '') ensureAgents(bot.teamId)
        }
      },
      () => { if (current) setLoad({ status: 'error' }) },
    )
    void Promise.resolve().then(() => listTeams()).then(
      (options) => { if (current) setTeams(options) },
      () => {},
    )
    return () => { current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadBots, listTeams])

  const reseed = (view: TdaiBotsView): void => {
    setLoad({ status: 'ready', view })
    setDraft(view.bots.map(clone))
    setDirty(false)
    setFailed(false)
  }

  const add = (): void => {
    setDraft([...draft, { ...EMPTY_BOT }])
    setDirty(true)
    setFailed(false)
  }

  const remove = (index: number): void => {
    setDraft(draft.filter((_, i) => i !== index))
    setDirty(true)
    setFailed(false)
  }

  const edit = (index: number, patch: Partial<TdaiBot>): void => {
    setDraft(draft.map((bot, i) => i === index ? { ...bot, ...patch } : bot))
    setDirty(true)
    setFailed(false)
    if (patch.teamId !== undefined) ensureAgents(patch.teamId)
  }

  const save = (): void => {
    if (load.status !== 'ready' || load.view.writable === false) return
    void (async () => {
      setSaving(true)
      setFailed(false)
      try {
        await saveBots(draft)
        reseed(await loadBots())
      } catch {
        setFailed(true)
      } finally {
        setSaving(false)
      }
    })()
  }

  const discard = (): void => {
    if (load.status !== 'ready') return
    reseed(load.view)
  }

  if (load.status === 'loading') return <p className={css.state}>{t('botsLoading')}</p>
  if (load.status === 'error') return <p className={css.state} role="alert">{t('botsError')}</p>
  if (load.view.available === false) return null
  const writable = load.view.writable
  const blocked = !dirty || saving || !writable

  return (
    <section className={clsx(css.card, open && css.cardOpen)}>
      <button type="button" className={css.header} aria-expanded={open} onClick={() => { setOpen(!open) }}>
        <span className={css.headText}>
          <span className={css.name}>{t('botsHeading')}</span>
          <span className={css.description}>{t('botsHint')}</span>
        </span>
        {dirty ? <span className={css.pending}>{t('botsUnsaved')}</span> : null}
        <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>
      {open
        ? (
          <div className={css.body}>
            {!writable ? <p className={css.readOnly} role="status">{t('readOnly')}</p> : null}
            {teams.length === 0 ? <p className={css.catalogHint}>{t('catalogUnavailable')}</p> : null}
            {draft.length === 0 ? <p className={css.empty}>{t('botsEmpty')}</p> : null}
            <ul className={css.list}>
              {draft.map((bot, index) => {
                const status = statusById.get(bot.id)
                return (
                  <li className={css.bot} key={index}>
                    <div className={css.botTop}>
                      <span className={css.avatar} aria-hidden="true"><FeishuLogo size={24} /></span>
                      <div className={css.identity}>
                        <span className={css.botName}>{bot.id.trim() !== '' ? bot.id : t('botUntitled')}</span>
                        {bot.appId ? <span className={css.botAppId}>{bot.appId}</span> : null}
                      </div>
                      <StatusBadge t={t} state={status?.state} />
                    </div>
                    <div className={css.fields}>
                      <Field label={t('botId')}>
                        <input className={css.input} type="text" value={bot.id} disabled={!writable}
                          onChange={(event) => { edit(index, { id: event.target.value }) }} />
                      </Field>
                      <Field label={t('botAppId')}>
                        <input className={css.input} type="text" value={bot.appId ?? ''} disabled={!writable}
                          onChange={(event) => { edit(index, { appId: event.target.value }) }} />
                      </Field>
                      <TeamSelect t={t} value={bot.teamId ?? ''} teams={teams} disabled={!writable}
                        onChange={(teamId) => { edit(index, { teamId }) }} />
                      <AgentSelect t={t} value={bot.agentId ?? ''} agents={agents[bot.teamId ?? ''] ?? []} disabled={!writable}
                        onChange={(agentId) => { edit(index, { agentId }) }} />
                    </div>
                    <div className={css.botFooter}>
                      <span className={css.spacer} />
                      <button type="button" className={css.remove} disabled={!writable} onClick={() => { remove(index) }}>
                        {t('botRemove')}
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
            <div className={css.footer}>
              {failed ? <p className={css.failed} role="status">{t('botsFailed')}</p> : null}
              <button type="button" className={css.add} disabled={!writable} onClick={add}>{t('botAdd')}</button>
              <span className={css.spacer} />
              <button type="button" className={css.discard} disabled={!dirty || saving} onClick={discard}>
                {t('botDiscard')}
              </button>
              <button type="button" className={css.save} disabled={blocked} onClick={save}>
                {t(saving ? 'botsSaving' : 'botSave')}
              </button>
            </div>
          </div>
        )
        : null}
    </section>
  )
}

/** One labelled field row, mirroring the plugin-card field chrome. */
function Field({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <span className={css.label}>{label}</span>
      </div>
      {children}
    </div>
  )
}

/** Feishu connection state → visual tone for the status dot. */
const STATE_TONES: Record<string, 'success' | 'warning' | 'error'> = {
  connected: 'success',
  unconfigured: 'warning',
  error: 'error',
}

/** A health-pill state indicator for one bot (colored dot + locale label). */
function StatusBadge({ t, state }: { t: (key: ImStatusLocaleKey) => string; state: string | undefined }): ReactNode {
  const key = state === undefined || STATE_KEYS[state] === undefined ? 'stateUnavailable' : STATE_KEYS[state]
  const tone = state === undefined ? 'neutral' : (STATE_TONES[state] ?? 'neutral')
  return (
    <span className={css.statusPill} data-tone={tone}>
      <span className={css.statusDot} aria-hidden="true" />
      {t(key)}
    </span>
  )
}

/** Team field: catalog-only select — teams are built in the memory hub, never typed by hand. */
function TeamSelect({ t, value, teams, disabled, onChange }: {
  t: (key: ImStatusLocaleKey) => string
  value: string
  teams: readonly TdaiTeamOption[]
  disabled: boolean
  onChange: (value: string) => void
}): ReactNode {
  const empty = teams.length === 0
  return (
    <Field label={t('botTeamId')}>
      <select className={css.input} value={teams.some(option => option.teamId === value) ? value : ''}
        disabled={disabled || empty} onChange={(event) => { onChange(event.target.value) }}>
        <option value="">{empty ? t('catalogEmpty') : t('botTeamPlaceholder')}</option>
        {teams.map(option => <option key={option.teamId} value={option.teamId}>{option.name}</option>)}
      </select>
    </Field>
  )
}

/** Agent field: catalog-only select — agents come from the chosen team, never typed by hand. */
function AgentSelect({ t, value, agents, disabled, onChange }: {
  t: (key: ImStatusLocaleKey) => string
  value: string
  agents: readonly TdaiAgentOption[]
  disabled: boolean
  onChange: (value: string) => void
}): ReactNode {
  const empty = agents.length === 0
  return (
    <Field label={t('botAgentId')}>
      <select className={css.input} value={agents.some(option => option.agentId === value) ? value : ''}
        disabled={disabled || empty} onChange={(event) => { onChange(event.target.value) }}>
        <option value="">{empty ? t('agentNeedsTeam') : t('botAgentPlaceholder')}</option>
        {agents.map(option => <option key={option.agentId} value={option.agentId}>{option.name}</option>)}
      </select>
    </Field>
  )
}

/** Detached copy so the draft never aliases the loaded view. */
function clone(bot: TdaiBot): TdaiBot {
  return { ...bot }
}
