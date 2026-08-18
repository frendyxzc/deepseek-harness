/**
 * Feishu Bot API provider for `ctx.feishu`: authenticates with App ID and App Secret
 * to obtain a tenant access token, sends messages through the Feishu Open API, and
 * receives `im.message.receive_v1` events through the official long-connection SDK.
 * Token caching and expiry are handled internally.
 *
 * Credentials are resolved through `ctx.credentials` (the `FEISHU_APP_ID` and
 * `FEISHU_APP_SECRET` environment variables), or supplied as literal config values.
 * @module @deepseek-ai/dsh-feishu-bot/provider
 */

import { FEISHU_RECEIVE_ID_TYPES, FeishuError } from '@deepseek-ai/dsh-feishu'
import type {
  FeishuProvider,
  FeishuProviderStatus,
  FeishuReceiveEvent,
  FeishuReceiveHandler,
  FeishuReceiveIdType,
  FeishuSendRequest,
  FeishuSendResult,
} from '@deepseek-ai/dsh-feishu'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

/** Stable id this provider registers under. */
export const FEISHU_BOT_PROVIDER_ID = 'feishu-bot'

/** Default Feishu Open API base URL. */
export const FEISHU_DEFAULT_BASE_URL = 'https://open.feishu.cn/open-apis'

/** Attribution header sent on every request. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Response shape from the tenant_access_token endpoint. */
interface TenantAccessTokenResponse {
  code: number
  msg?: string
  tenant_access_token?: string
  expire?: number
}

/** Response shape from the send message endpoint. */
interface SendMessageResponse {
  code: number
  msg?: string
  data?: {
    message_id?: string
  }
}

/** Minimal logger surface the provider uses for async receive-channel diagnostics. */
export interface FeishuLogger {
  /** Log a debug diagnostic. */
  debug(format: string, ...args: unknown[]): void
  /** Log an informational diagnostic. */
  info(format: string, ...args: unknown[]): void
  /** Log a warning diagnostic. */
  warn(format: string, ...args: unknown[]): void
  /** Log an error diagnostic. */
  error(format: string, ...args: unknown[]): void
}

/** The long-connection client handle; only `close` is needed for disposal. */
export interface FeishuWsClient {
  /** Close the long connection. `force` terminates the socket immediately. */
  close(params?: { force?: boolean }): void
}

/** Resolved provider options (the plugin's `apply` supplies credential and constant defaults). */
export interface FeishuBotProviderOptions {
  /** Literal Feishu App ID; when present it wins over {@link resolveAppId}. */
  appId?: string
  /** Literal Feishu App Secret; when present it wins over {@link resolveAppSecret}. */
  appSecret?: string
  /** Resolve the current App ID for one operation. */
  resolveAppId?: () => Promise<string | undefined>
  /** Resolve the current App Secret for one operation. */
  resolveAppSecret?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  appIdEnv?: CredentialRef
  /** Credential reference named by missing-credential diagnostics. */
  appSecretEnv?: CredentialRef
  /** Feishu Open API base URL. */
  baseURL: string
  /** Logger for async receive-channel diagnostics. */
  logger?: FeishuLogger
}

/**
 * The Feishu Bot API provider. Caches the tenant access token and refreshes it
 * on expiry.
 */
export class FeishuBotProvider implements FeishuProvider {
  readonly id = FEISHU_BOT_PROVIDER_ID

  private cachedToken: string | undefined
  private tokenExpiresAt = 0
  /** The most recent recorded operation failure; cleared by a successful send. */
  private lastError: string | undefined
  /** The App ID resolved by the most recent successful authentication. */
  private lastResolvedAppId: string | undefined
  /** Whether a receive channel is currently open. */
  private receiveActive = false

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted
   * once at each operation's entry so one send never mixes two credential sections.
   */
  constructor(private readonly resolveOptions: () => FeishuBotProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return ((options.appId?.length ?? 0) > 0 || options.resolveAppId !== undefined)
      && ((options.appSecret?.length ?? 0) > 0 || options.resolveAppSecret !== undefined)
      && URL.canParse(options.baseURL)
  }

  /**
   * Project this provider's connection state and display-safe configuration.
   * Resolves credentials for a truthful check; failures resolve to `error` or
   * `unconfigured` instead of throwing.
   * @returns the provider's current status projection.
   */
  async status(): Promise<FeishuProviderStatus> {
    const options = this.resolveOptions()
    if (!URL.canParse(options.baseURL)) {
      return {
        state: 'unavailable',
        appSecretConfigured: false,
        receiveActive: this.receiveActive,
        baseURL: options.baseURL,
        lastError: `Feishu base URL cannot be parsed: "${options.baseURL}"`,
      }
    }

    let appId: string | undefined = (options.appId?.length ?? 0) > 0 ? options.appId : this.lastResolvedAppId
    let appSecret: string | undefined = (options.appSecret?.length ?? 0) > 0 ? options.appSecret : undefined
    try {
      appId ??= await options.resolveAppId?.()
      appSecret ??= await options.resolveAppSecret?.()
    } catch (error: unknown) {
      return {
        state: 'error',
        appSecretConfigured: false,
        receiveActive: this.receiveActive,
        baseURL: options.baseURL,
        lastError: `Feishu credential resolution failed: ${String(error)}`,
      }
    }
    const appIdMasked = appId !== undefined && appId.length > 0 ? maskAppId(appId) : undefined
    const appSecretConfigured = appSecret !== undefined && appSecret.length > 0
    if (appIdMasked === undefined || !appSecretConfigured) {
      return {
        state: 'unconfigured',
        ...(appIdMasked === undefined ? {} : { appIdMasked }),
        appSecretConfigured,
        receiveActive: this.receiveActive,
        baseURL: options.baseURL,
        ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      }
    }
    if (this.lastError !== undefined) {
      return {
        state: 'error',
        appIdMasked,
        appSecretConfigured,
        receiveActive: this.receiveActive,
        baseURL: options.baseURL,
        lastError: this.lastError,
      }
    }
    return {
      state: 'connected',
      appIdMasked,
      appSecretConfigured,
      receiveActive: this.receiveActive,
      baseURL: options.baseURL,
    }
  }

  async sendMessage(request: FeishuSendRequest, signal?: AbortSignal): Promise<FeishuSendResult> {
    const options = this.resolveOptions()
    throwIfAborted(signal)

    const token = await this.getAccessToken(options, signal)
    throwIfAborted(signal)

    const receiveIdType = request.receiveIdType ?? 'open_id'
    const msgType = request.msgType ?? 'text'
    const content = msgType === 'text'
      ? JSON.stringify({ text: request.content })
      : request.content

    const url = `${options.baseURL}/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          receive_id: request.receiveId,
          msg_type: msgType,
          content,
        }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw sendAborted(signal, error)
      throw this.fail(
        `Feishu send message request failed: ${String(error)}`,
        'FEISHU_PROVIDER_ERROR',
        error,
      )
    }

    const body = await response.json() as SendMessageResponse
    if (body.code !== 0) {
      throw this.fail(
        `Feishu API error (code ${body.code}): ${body.msg ?? 'unknown error'}`,
        'FEISHU_PROVIDER_ERROR',
      )
    }
    if (body.data?.message_id === undefined) {
      throw this.fail(
        'Feishu send message returned no message_id',
        'FEISHU_PROVIDER_ERROR',
      )
    }
    this.lastError = undefined
    return { messageId: body.data.message_id }
  }

  /**
   * Start the Feishu long-connection receive channel. The official SDK dials
   * OUT to Feishu, so no public callback URL is required. Setup and connection
   * are asynchronous: failures surface through `lastError` and the logger, and
   * the returned disposer closes the connection.
   */
  startReceiving(handler: FeishuReceiveHandler): () => void {
    const options = this.resolveOptions()
    const controller = new AbortController()
    const logger = options.logger
    let wsClient: FeishuWsClient | undefined
    this.receiveActive = true

    const begin = async (): Promise<void> => {
      try {
        const appId = await this.resolveCredential(
          options.appId, options.resolveAppId, options.appIdEnv ?? 'FEISHU_APP_ID',
          'App ID', controller.signal,
        )
        const appSecret = await this.resolveCredential(
          options.appSecret, options.resolveAppSecret, options.appSecretEnv ?? 'FEISHU_APP_SECRET',
          'App Secret', controller.signal,
        )
        if (controller.signal.aborted) return

        const sdk = await import('@larksuiteoapi/node-sdk')
        if (controller.signal.aborted) return

        const dispatcher = new sdk.EventDispatcher({ loggerLevel: sdk.LoggerLevel.warn })
        dispatcher.register({
          'im.message.receive_v1': (data: unknown): void => {
            const inner = data as { message?: unknown; sender?: unknown } | null | undefined
            const received = toReceiveEvent(inner?.message, inner?.sender, data)
            if (received !== undefined) handler(received)
          },
        })

        const client = new sdk.WSClient({
          appId,
          appSecret,
          domain: new URL(options.baseURL).origin,
          autoReconnect: true,
          loggerLevel: sdk.LoggerLevel.warn,
          source: 'deepseek-harness',
          onReady: () => logger?.debug('feishu long connection established'),
          onReconnecting: () => logger?.warn('feishu long connection reconnecting'),
          onReconnected: () => logger?.info('feishu long connection reconnected'),
          onError: (error: Error) => {
            this.lastError = `Feishu long connection failed: ${String(error)}`
            logger?.error(`feishu long connection failed: ${String(error)}`)
          },
        })
        wsClient = client

        void client.start({ eventDispatcher: dispatcher }).catch((error: unknown) => {
          if (controller.signal.aborted) return
          this.lastError = `Feishu long connection start failed: ${String(error)}`
          logger?.error(`feishu long connection start failed: ${String(error)}`)
        })
      } catch (error: unknown) {
        if (controller.signal.aborted) return
        this.receiveActive = false
        this.lastError = `Feishu long connection setup failed: ${String(error)}`
        logger?.error(`feishu long connection setup failed: ${String(error)}`)
      }
    }

    void begin()

    return () => {
      controller.abort()
      this.receiveActive = false
      wsClient?.close({ force: true })
    }
  }

  /**
   * Obtain a valid tenant access token, refreshing the cache when expired.
   * @param options - the caller's credential snapshot.
   * @param signal - abort signal for the surrounding operation.
   * @returns the current bearer token.
   */
  private async getAccessToken(options: FeishuBotProviderOptions, signal?: AbortSignal): Promise<string> {
    if (this.cachedToken !== undefined && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.cachedToken
    }

    const appId = await this.resolveCredential(
      options.appId, options.resolveAppId, options.appIdEnv ?? 'FEISHU_APP_ID',
      'App ID', signal,
    )
    const appSecret = await this.resolveCredential(
      options.appSecret, options.resolveAppSecret, options.appSecretEnv ?? 'FEISHU_APP_SECRET',
      'App Secret', signal,
    )

    const url = `${options.baseURL}/auth/v3/tenant_access_token/internal`
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw sendAborted(signal, error)
      throw this.fail(
        `Feishu auth request failed: ${String(error)}`,
        'FEISHU_PROVIDER_ERROR',
        error,
      )
    }

    const body = await response.json() as TenantAccessTokenResponse
    if (body.code !== 0 || body.tenant_access_token === undefined) {
      throw this.fail(
        `Feishu auth failed (code ${body.code}): ${body.msg ?? 'no token returned'}`,
        'FEISHU_PROVIDER_AUTH_FAILED',
      )
    }

    this.cachedToken = body.tenant_access_token
    this.lastResolvedAppId = appId
    // Default to 2 hours when expire is absent; subtract 60s for safety margin.
    this.tokenExpiresAt = Date.now() + ((body.expire ?? 7200) - 60) * 1000
    return this.cachedToken
  }

  /**
   * Resolve one credential value from literal, resolver, or diagnostic.
   * @param literal - the literal config value, if set.
   * @param resolver - the async resolver thunk, if set.
   * @param ref - the env-var name for diagnostics.
   * @param label - human-readable label for the credential (e.g. "App ID").
   * @param signal - abort signal.
   * @returns the resolved non-empty credential value.
   */
  private async resolveCredential(
    literal: string | undefined,
    resolver: (() => Promise<string | undefined>) | undefined,
    ref: string,
    label: string,
    signal?: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal)
    if (literal !== undefined && literal.length > 0) return literal
    let resolved: string | undefined
    try {
      resolved = await abortable(resolver?.() ?? Promise.resolve(undefined), signal)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw sendAborted(signal, error)
      throw this.fail(
        `Feishu ${label} resolution failed: ${String(error)}`,
        'FEISHU_PROVIDER_ERROR',
        error,
      )
    }
    if (resolved !== undefined && resolved.length > 0) return resolved
    throw this.fail(
      `Feishu provider has no ${label} for "${ref}"; store it through the credentials service`
      + ' or set a literal "appId"/"appSecret" in the feishu-bot config',
      'FEISHU_PROVIDER_CREDENTIAL_MISSING',
    )
  }

  /** Record and throw a provider operation failure with a stable code. */
  private fail(message: string, code: string, cause?: unknown): never {
    this.lastError = message
    throw new FeishuError(message, code, cause === undefined ? {} : { cause })
  }
}

/** Race a same-process asynchronous preflight against caller cancellation. */
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(sendAborted(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(sendAborted(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(new Error(String(error).replace(/^Error: /u, ''), { cause: error }))
      },
    )
  })
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw sendAborted(signal)
}

/** Build the provider's stable cancellation error. */
function sendAborted(signal?: AbortSignal, fallback?: unknown): FeishuError {
  return new FeishuError('Feishu operation aborted', 'FEISHU_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** True for a fetch/`AbortSignal` abort. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * Mask an App ID for display: first and last four characters with the middle
 * redacted; short ids keep only their first and last characters.
 */
function maskAppId(appId: string): string {
  return appId.length > 8
    ? `${appId.slice(0, 4)}****${appId.slice(-4)}`
    : `${appId.slice(0, 1)}****${appId.slice(-1)}`
}

/** Normalize a sender type to the supported union, defaulting to `open_id`. */
function normalizeSenderIdType(raw: unknown): FeishuReceiveIdType {
  if (typeof raw === 'string' && (FEISHU_RECEIVE_ID_TYPES as readonly string[]).includes(raw)) {
    return raw as FeishuReceiveIdType
  }
  return 'open_id'
}

/**
 * Extract the sender id for the given type. Feishu v2 events put `sender_id` as an
 * object keyed by type; older payloads may carry the id as a plain string.
 */
function extractSenderId(raw: unknown, senderIdType: FeishuReceiveIdType): string {
  if (typeof raw === 'string') return raw
  if (raw !== null && typeof raw === 'object') {
    const value = (raw as Record<string, unknown>)[senderIdType]
    if (typeof value === 'string') return value
  }
  return ''
}

/**
 * Convert one `im.message.receive_v1` payload — the inner `message` / `sender`
 * shape delivered by the long-connection client — into a
 * {@link FeishuReceiveEvent}. Returns undefined for non-text or empty content,
 * which the caller drops.
 * @param message - the event's message body.
 * @param sender - the event's sender body.
 * @param raw - the raw event payload, attached to the emitted event.
 * @returns the receive event, or undefined when the payload should be dropped.
 */
function toReceiveEvent(message: unknown, sender: unknown, raw: unknown): FeishuReceiveEvent | undefined {
  const msg = message as Record<string, unknown> | undefined
  const snd = sender as Record<string, unknown> | undefined
  const senderIdType = normalizeSenderIdType(snd?.sender_type)
  const chatId = typeof msg?.chat_id === 'string' ? msg.chat_id : ''
  if ((msg?.message_type ?? msg?.msg_type) !== 'text') return undefined
  let content = ''
  try {
    const parsed = JSON.parse(typeof msg?.content === 'string' ? msg.content : '{}') as Record<string, unknown>
    content = typeof parsed.text === 'string' ? parsed.text : ''
  } catch {
    content = ''
  }
  if (content.length === 0) return undefined
  return {
    eventType: 'im.message.receive_v1',
    senderId: extractSenderId(snd?.sender_id, senderIdType),
    senderIdType,
    chatId,
    content,
    raw,
  }
}
