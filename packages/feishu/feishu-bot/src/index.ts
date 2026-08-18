/**
 * `@deepseek-ai/dsh-feishu-bot`: registers the Feishu Bot API provider with
 * `ctx.feishu`. A function/namespace plugin (NOT a default-export service):
 * it registers INTO the seam's provider registry.
 *
 * @module @deepseek-ai/dsh-feishu-bot
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-feishu'
import { FeishuBotProvider, FEISHU_DEFAULT_BASE_URL } from './provider.ts'
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

/** Default env var naming the Feishu App ID. */
const DEFAULT_APP_ID_ENV = 'FEISHU_APP_ID'
/** Default env var naming the Feishu App Secret. */
const DEFAULT_APP_SECRET_ENV = 'FEISHU_APP_SECRET'

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Literal Feishu App ID; prefer {@link appIdEnv} so no secret enters configuration files. */
  appId?: string
  /** Literal Feishu App Secret; prefer {@link appSecretEnv} so no secret enters configuration files. */
  appSecret?: string
  /** Credential reference resolved for each operation; defaults to `FEISHU_APP_ID`. */
  appIdEnv?: string
  /** Credential reference resolved for each operation; defaults to `FEISHU_APP_SECRET`. */
  appSecretEnv?: string
  /** Feishu Open API base URL. */
  baseURL?: string
}

export const Config: z<Config> = z.object({
  appId: z.string().role('secret'),
  appSecret: z.string().role('secret'),
  appIdEnv: z.string().role('credential-ref').default(DEFAULT_APP_ID_ENV),
  appSecretEnv: z.string().role('credential-ref').default(DEFAULT_APP_SECRET_ENV),
  baseURL: z.string(),
})

/**
 * Project one resolved section into the options the provider serves its next
 * operation with. Credential resolution stays here rather than in the provider:
 * every value the provider reads is already fully defaulted.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @returns options for one operation.
 */
function resolveOptions(ctx: Context, config: Config): FeishuBotProviderOptions {
  const appIdEnv = credentialRef(config.appIdEnv ?? DEFAULT_APP_ID_ENV)
  const appSecretEnv = credentialRef(config.appSecretEnv ?? DEFAULT_APP_SECRET_ENV)
  const literalAppId = config.appId !== undefined && config.appId.length > 0 ? config.appId : undefined
  const literalAppSecret = config.appSecret !== undefined && config.appSecret.length > 0 ? config.appSecret : undefined

  // Resolve one credential per operation: the credentials service first, then
  // the launch environment when no credentials seam is mounted.
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
    baseURL: config.baseURL ?? FEISHU_DEFAULT_BASE_URL,
    logger: ctx.logger,
  }
}

/** Register the Feishu Bot API provider with `ctx.feishu`. */
export function apply(ctx: Context, config: Config): void {
  ctx.feishu.registerProvider(new FeishuBotProvider(() => resolveOptions(ctx, config)))
}
