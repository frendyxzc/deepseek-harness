/**
 * `@deepseek-ai/dsh-feishu-bot`: registers Feishu Bot API provider(s) with
 * `ctx.feishu`. A function plugin (NOT a default-export service): it registers
 * INTO the seam's provider registry. Configure a single app with the flat
 * credential fields, or several apps through `bots` (identity + team/agent,
 * settings-editable) plus `credentials` (secrets, composition-only, keyed by
 * bot id) — the split keeps secrets out of the settings UI, which cannot reply
 * redacted `role('secret')` values and would otherwise overwrite them.
 *
 * @module @deepseek-ai/dsh-feishu-bot
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-feishu'
import type {} from '@deepseek-ai/dsh-settings'
import { FeishuBotProvider, FEISHU_BOT_PROVIDER_ID, FEISHU_DEFAULT_BASE_URL } from './provider.ts'
import type { FeishuBotProviderOptions } from './provider.ts'

export {
  FEISHU_BOT_PROVIDER_ID,
  FEISHU_DEFAULT_BASE_URL,
  FeishuBotProvider,
} from './provider.ts'
export type { FeishuBotProviderOptions, FeishuLogger, FeishuWsClient } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'feishu-bot'

/** The Feishu seam this provider registers into. */
export const inject = ['feishu']

/** Settings namespace carrying the per-bot identity/mapping (no secrets). */
export const FEISHU_BOT_SETTINGS_NAMESPACE = 'feishu-bot'

/** Default env var naming the Feishu App ID. */
const DEFAULT_APP_ID_ENV = 'FEISHU_APP_ID'
/** Default env var naming the Feishu App Secret. */
const DEFAULT_APP_SECRET_ENV = 'FEISHU_APP_SECRET'

/**
 * Derive the per-bot App Secret reference the provider resolves when the
 * composition names none. The flat single-app provider keeps the conventional
 * `FEISHU_APP_SECRET`; every other bot gets a reference derived from its own id,
 * so the Settings IM tab can store each bot's secret under a distinct, stable
 * name (write-only, through the credentials service).
 *
 * The Settings IM tab mirrors this rule in `dsh-client-ui-settings-im`; the two
 * must stay in sync so a new bot's secret lands under the reference this plugin
 * resolves.
 * @param botId - the bot's registry id.
 * @returns the App Secret credential reference name.
 */
export function feishuAppSecretRef(botId: string): string {
  if (botId === FEISHU_BOT_PROVIDER_ID) return DEFAULT_APP_SECRET_ENV
  const suffix = botId.toUpperCase().replace(/[^A-Za-z0-9]+/g, '_')
  const safe = suffix.length === 0 || /^[0-9]/.test(suffix) ? `BOT_${suffix}` : suffix
  return `FEISHU_APP_SECRET_${safe}`
}

/** One bot's settings-editable identity and mapping; secrets stay OUT of here. */
export interface FeishuBotEntry {
  /** Stable provider id (unique within the seam) used to route replies back to this app. */
  id: string
  /** Literal Feishu App ID; when absent, the credential's `appIdEnv` resolves it. */
  appId?: string
  /** TDAI team id this bot sends as `x-team-id`. */
  teamId?: string
  /** TDAI agent id this bot sends as `x-agent-id`. */
  agentId?: string
}

/** One bot's secrets and endpoint, composition-only and keyed by {@link FeishuBotEntry.id}. */
export interface FeishuBotCredential {
  /** The bot id these credentials belong to. */
  id: string
  /** Literal Feishu App Secret; prefer {@link appSecretEnv} so no secret enters configuration files. */
  appSecret?: string
  /** Credential reference resolving the App ID when the entry has no literal `appId`. */
  appIdEnv?: string
  /** Credential reference resolving the App Secret; defaults to `FEISHU_APP_SECRET`. */
  appSecretEnv?: string
  /** Feishu Open API base URL. */
  baseURL?: string
}

/** Plugin config: the flat single app, plus the multi-app `bots` + `credentials`. */
export interface Config {
  /** Literal Feishu App ID (flat single app). */
  appId?: string
  /** Literal Feishu App Secret (flat single app). */
  appSecret?: string
  /** Credential reference for the flat single app's App ID. */
  appIdEnv?: string
  /** Credential reference for the flat single app's App Secret. */
  appSecretEnv?: string
  /** Feishu Open API base URL (flat single app). */
  baseURL?: string
  /** Bot apps; when non-empty these replace the flat single-app fields. */
  bots?: FeishuBotEntry[]
  /** Secrets and endpoint per bot; composition-only, no settings exposure. */
  credentials?: FeishuBotCredential[]
}

const botEntrySchema: z<FeishuBotEntry> = z.object({
  id: z.string().required(),
  appId: z.string(),
  teamId: z.string(),
  agentId: z.string(),
})

const credentialSchema: z<FeishuBotCredential> = z.object({
  id: z.string().required(),
  appSecret: z.string().role('secret'),
  appIdEnv: z.string().role('credential-ref'),
  appSecretEnv: z.string().role('credential-ref'),
  baseURL: z.string(),
})

export const Config: z<Config> = z.object({
  appId: z.string().role('secret'),
  appSecret: z.string().role('secret'),
  appIdEnv: z.string().role('credential-ref').default(DEFAULT_APP_ID_ENV),
  appSecretEnv: z.string().role('credential-ref').default(DEFAULT_APP_SECRET_ENV),
  baseURL: z.string(),
  bots: z.array(botEntrySchema),
  credentials: z.array(credentialSchema),
})

/** Settings-section shape: identity/mapping only, so the UI never writes secrets. */
export interface FeishuBotSettings {
  bots?: FeishuBotEntry[]
}

/** Zod schema for the `feishu-bot` settings section (identity/mapping only). */
export const FeishuBotSettingsConfig: z<FeishuBotSettings> = z.object({
  bots: z.array(botEntrySchema),
})

/** Credential-shaped fields shared by the flat config and per-bot credentials. */
interface CredentialLike {
  appSecret?: string
  appIdEnv?: string
  appSecretEnv?: string
  baseURL?: string
}

/** One bot's merged registration inputs: identity plus its credential fields. */
interface ResolvedEntry extends FeishuBotEntry {
  credential: CredentialLike
}

/**
 * Resolve the credential fields for one bot from the credentials list by id, or
 * the flat single-app fields when there is no per-bot credential list.
 * @param config - the currently authoritative composition config.
 * @param botId - the bot id whose credentials to resolve.
 * @returns the credential fields, possibly empty.
 */
function credentialFor(config: Config, botId: string): CredentialLike {
  const match = config.credentials?.find(credential => credential.id === botId)
  if (match !== undefined) return match
  if (botId === FEISHU_BOT_PROVIDER_ID || config.credentials === undefined || config.credentials.length === 0) {
    return {
      ...(config.appSecret === undefined ? {} : { appSecret: config.appSecret }),
      ...(config.appIdEnv === undefined ? {} : { appIdEnv: config.appIdEnv }),
      ...(config.appSecretEnv === undefined ? {} : { appSecretEnv: config.appSecretEnv }),
      ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
    }
  }
  return {}
}

/**
 * Project one merged bot entry into the options the provider serves its next
 * operation with. Credential resolution stays here rather than in the provider:
 * every value the provider reads is already fully defaulted.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param entry - the bot entry plus its resolved credential fields.
 * @returns options for one operation.
 */
function resolveOptions(ctx: Context, entry: ResolvedEntry): FeishuBotProviderOptions {
  const credential = entry.credential
  const appIdEnv = credentialRef(credential.appIdEnv ?? DEFAULT_APP_ID_ENV)
  const appSecretEnv = credentialRef(credential.appSecretEnv !== undefined && credential.appSecretEnv.length > 0
    ? credential.appSecretEnv
    : feishuAppSecretRef(entry.id))
  const literalAppId = entry.appId !== undefined && entry.appId.length > 0 ? entry.appId : undefined
  const literalAppSecret = credential.appSecret !== undefined && credential.appSecret.length > 0 ? credential.appSecret : undefined

  const resolveCredential = (ref: CredentialRef) => async (): Promise<string | undefined> => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) return (await credentials.resolve(ref))?.value
    const ambient = launchEnvironmentOf(ctx).get(ref)
    return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
  }

  return {
    ...literalAppId === undefined ? {} : { appId: literalAppId },
    ...literalAppSecret === undefined ? {} : { appSecret: literalAppSecret },
    resolveAppId: resolveCredential(appIdEnv),
    resolveAppSecret: resolveCredential(appSecretEnv),
    appIdEnv,
    appSecretEnv,
    baseURL: credential.baseURL ?? FEISHU_DEFAULT_BASE_URL,
    logger: ctx.logger,
  }
}

/** One provider registration to reconcile against the resolved config. */
interface Registration {
  disposer: () => void
}

/**
 * Register the Feishu Bot provider(s), re-registering live as the `feishu-bot`
 * settings section changes. The composition entry stays usable without a
 * settings provider; when one is mounted its user layer is read live.
 */
export function apply(ctx: Context, config: Config): void {
  let currentSettings: () => FeishuBotSettings = () => ({ bots: config.bots ?? [] })
  const registrations = new Map<string, Registration>()

  const sync = (): void => {
    const settings = currentSettings()
    const bots = (settings.bots ?? []).length > 0 ? settings.bots : config.bots
    const desired = new Map<string, ResolvedEntry>()
    if (bots !== undefined && bots.length > 0) {
      for (const bot of bots) {
        desired.set(bot.id, { ...bot, credential: credentialFor(config, bot.id) })
      }
    } else {
      desired.set(FEISHU_BOT_PROVIDER_ID, {
        id: FEISHU_BOT_PROVIDER_ID,
        ...(config.appId === undefined ? {} : { appId: config.appId }),
        credential: credentialFor(config, FEISHU_BOT_PROVIDER_ID),
      })
    }
    for (const [id, entry] of desired) {
      if (registrations.has(id)) continue
      const disposer = ctx.feishu.registerProvider(new FeishuBotProvider(() => resolveOptions(ctx, entry), id))
      registrations.set(id, { disposer })
    }
    for (const [id, registration] of registrations) {
      if (desired.has(id)) continue
      registration.disposer()
      registrations.delete(id)
    }
  }

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, FEISHU_BOT_SETTINGS_NAMESPACE, FeishuBotSettingsConfig, { bots: config.bots ?? [] }, {
      setSource: (source) => {
        currentSettings = source
      },
      onChange: sync,
    })
  })
  // Register from the composition entry up front; the settings section, when
  // mounted, re-syncs from its live user layer.
  sync()
}
