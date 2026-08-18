import { useEffect, useState, type ReactNode } from 'react'
import type { FeishuStatusView } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ImStatusLocaleKey } from './locales.ts'
import css from './FeishuStatusTab.module.css'

/** Registration-side Remote face used by the section. */
export interface FeishuStatusTabInjected {
  /** Fetch the current Feishu integration status from the Host. */
  fetch: () => Promise<FeishuStatusView>
}

/** Full component props assembled by the Settings slot renderer. */
export type FeishuStatusTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.im'>
  & InjectFace<FeishuStatusTabInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly view: FeishuStatusView }

const STATE_KEYS = {
  connected: 'stateConnected',
  unconfigured: 'stateUnconfigured',
  unavailable: 'stateUnavailable',
  error: 'stateError',
} satisfies Record<FeishuStatusView['state'], ImStatusLocaleKey>

/** Render the read-only Feishu integration status. */
export function FeishuStatusTab({ fetch, t }: FeishuStatusTabProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => fetch()).then(
      (view) => { if (current) setState({ status: 'ready', view }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [fetch, request])

  const retry = (): void => {
    setState({ status: 'loading' })
    setRequest(value => value + 1)
  }

  return (
    <div className={css.section} aria-busy={state.status === 'loading'}>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {state.status === 'ready' ? <ReadyView view={state.view} t={t} /> : null}
    </div>
  )
}

function ReadyView({ view, t }: { view: FeishuStatusView; t: FeishuStatusTabProps['t'] }): ReactNode {
  const stateLabel = t(STATE_KEYS[view.state])
  return (
    <div className={css.content}>
      <h3 className={css.heading}>{t('heading')}</h3>
      <dl className={css.fields}>
        <div className={css.row}>
          <dt>{t('connection')}</dt>
          <dd>
            <span className={css.statusDot} data-state={view.state} role="img" aria-label={stateLabel} />
            {stateLabel}
          </dd>
        </div>
        {view.providerId !== undefined ? (
          <div className={css.row}>
            <dt>{t('providerId')}</dt>
            <dd><code className={css.codeValue}>{view.providerId}</code></dd>
          </div>
        ) : null}
        {view.provider !== undefined ? (
          <ProviderDetails provider={view.provider} t={t} />
        ) : null}
        {view.selectionError !== undefined ? (
          <div className={css.row} data-error="true">
            <dt>{t('selectionError')}</dt>
            <dd>{view.selectionError}</dd>
          </div>
        ) : null}
        {view.state === 'unavailable' && view.provider === undefined && view.selectionError === undefined ? (
          <div className={css.row}>
            <dd className={css.hint}>{t('noProvider')}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  )
}

function ProviderDetails({ provider, t }: { provider: NonNullable<FeishuStatusView['provider']>; t: FeishuStatusTabProps['t'] }): ReactNode {
  return (
    <>
      {provider.appIdMasked !== undefined ? (
        <div className={css.row}>
          <dt>{t('appId')}</dt>
          <dd><code className={css.codeValue}>{provider.appIdMasked}</code></dd>
        </div>
      ) : null}
      <div className={css.row}>
        <dt>{t('appSecret')}</dt>
        <dd>{provider.appSecretConfigured ? t('secretConfigured') : t('secretNotConfigured')}</dd>
      </div>
      {provider.baseURL !== undefined ? (
        <div className={css.row}>
          <dt>{t('baseURL')}</dt>
          <dd><code className={css.codeValue}>{provider.baseURL}</code></dd>
        </div>
      ) : null}
      <div className={css.row}>
        <dt>{t('receiveActive')}</dt>
        <dd>{provider.receiveActive ? t('receiveActiveYes') : t('receiveActiveNo')}</dd>
      </div>
      {provider.lastError !== undefined ? (
        <div className={css.row} data-error="true">
          <dt>{t('lastError')}</dt>
          <dd>{provider.lastError}</dd>
        </div>
      ) : null}
    </>
  )
}
