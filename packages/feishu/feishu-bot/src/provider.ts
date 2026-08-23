/**
 * Feishu Bot API provider for `ctx.feishu`: authenticates with App ID and App Secret
 * to obtain a tenant access token, sends and updates messages through the Feishu
 * Open API, and receives `im.message.receive_v1` events plus `card.action.trigger`
 * card callbacks through ONE shared official long-connection client. Token caching
 * and expiry are handled internally.
 *
 * Credentials are resolved through `ctx.credentials` (the `FEISHU_APP_ID` and
 * `FEISHU_APP_SECRET` environment variables), or supplied as literal config values.
 * @module @deepseek-ai/dsh-feishu-bot/provider
 */

import { FEISHU_RECEIVE_ID_TYPES, FeishuError } from '@deepseek-ai/dsh-feishu'
import type {
  FeishuCardActionEvent,
  FeishuCardActionHandler,
  FeishuMessage,
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

/** Response shape from the update message endpoint. */
interface UpdateMessageResponse {
  code: number
  msg?: string
}

/** One message item from the get-message endpoint's `data.items`. */
interface GetMessageItem {
  message_id?: string
  parent_id?: string
  root_id?: string
  msg_type?: string
  body?: {
    content?: string
  }
}

/** Response shape from the get message endpoint. */
interface GetMessageResponse {
  code: number
  msg?: string
  data?: {
    items?: GetMessageItem[]
  }
}

/**
 * The shared long-connection receive channel: one WS client fanned out to
 * every message and card-action subscriber. `controller` aborts the in-flight
 * setup when the last subscriber disposes before setup completes.
 */
interface ReceiveState {
  readonly controller: AbortController
  readonly messageHandlers: Set<FeishuReceiveHandler>
  readonly cardActionHandlers: Set<FeishuCardActionHandler>
  wsClient: FeishuWsClient | undefined
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
  readonly id: string

  private cachedToken: string | undefined
  private tokenExpiresAt = 0
  /** The most recent recorded operation failure; cleared by a successful send. */
  private lastError: string | undefined
  /** The App ID resolved by the most recent successful authentication. */
  private lastResolvedAppId: string | undefined
  /** Whether a receive channel is currently open. */
  private receiveActive = false
  /** The live shared receive channel, when at least one subscriber is attached. */
  private receive: ReceiveState | undefined

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted
   * once at each operation's entry so one send never mixes two credential sections.
   * @param id - stable registry id for this provider (unique within the seam).
   */
  constructor(
    private readonly resolveOptions: () => FeishuBotProviderOptions,
    id: string = FEISHU_BOT_PROVIDER_ID,
  ) {
    this.id = id
  }

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
   * Subscribe to Feishu messages on the shared long-connection receive
   * channel. The official SDK dials OUT to Feishu, so no public callback URL
   * is required. The first subscriber opens the connection; the returned
   * disposer removes this handler and closes the connection when it is the
   * last one. Setup and connection are asynchronous: failures surface through
   * `lastError` and the logger.
   */
  startReceiving(handler: FeishuReceiveHandler): () => void {
    return this.subscribeReceive('message', handler)
  }

  /**
   * Subscribe to Feishu card button actions on the SAME shared long
   * connection as {@link startReceiving} — never a second connection. The
   * first subscriber opens the connection; the returned disposer removes this
   * handler and closes the connection when it is the last one.
   */
  startReceivingCardActions(handler: FeishuCardActionHandler): () => void {
    return this.subscribeReceive('cardAction', handler)
  }

  /**
   * Replace the content of a message this provider sent earlier — e.g.
   * settling an interactive approval card after its buttons were consumed.
   * Uses the Feishu `/im/v1/messages/:message_id` update endpoint.
   * @param messageId - the message id returned by an earlier send.
   * @param content - the replacement content (card JSON string for cards).
   * @param signal - abort signal for the surrounding operation.
   */
  async updateMessage(messageId: string, content: string, signal?: AbortSignal): Promise<void> {
    const options = this.resolveOptions()
    throwIfAborted(signal)

    const token = await this.getAccessToken(options, signal)
    throwIfAborted(signal)

    const url = `${options.baseURL}/im/v1/messages/${encodeURIComponent(messageId)}`

    let response: Response
    try {
      response = await fetch(url, {
        method: 'PATCH',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({ content }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw sendAborted(signal, error)
      throw this.fail(
        `Feishu update message request failed: ${String(error)}`,
        'FEISHU_PROVIDER_ERROR',
        error,
      )
    }

    const body = await response.json() as UpdateMessageResponse
    if (body.code !== 0) {
      throw this.fail(
        `Feishu API error (code ${body.code}): ${body.msg ?? 'unknown error'}`,
        'FEISHU_PROVIDER_ERROR',
      )
    }
    this.lastError = undefined
  }

  /**
   * Fetch one message by id from the Feishu `/im/v1/messages/:message_id`
   * endpoint and extract its content as plain text. Used to read a quoted or
   * replied-to message so a reply's full context is available.
   * @param messageId - the Feishu message id.
   * @param signal - abort signal for the surrounding operation.
   */
  async getMessage(messageId: string, signal?: AbortSignal): Promise<FeishuMessage> {
    const options = this.resolveOptions()
    throwIfAborted(signal)

    const token = await this.getAccessToken(options, signal)
    throwIfAborted(signal)

    const url = `${options.baseURL}/im/v1/messages/${encodeURIComponent(messageId)}`

    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
          'user-agent': USER_AGENT,
        },
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw sendAborted(signal, error)
      throw this.fail(
        `Feishu get message request failed: ${String(error)}`,
        'FEISHU_PROVIDER_ERROR',
        error,
      )
    }

    const body = await response.json() as GetMessageResponse
    if (body.code !== 0) {
      throw this.fail(
        `Feishu API error (code ${body.code}): ${body.msg ?? 'unknown error'}`,
        'FEISHU_PROVIDER_ERROR',
      )
    }

    const item = body.data?.items?.[0]
    if (item === undefined) {
      throw this.fail(
        'Feishu get message returned no message',
        'FEISHU_PROVIDER_ERROR',
      )
    }

    const msgType = typeof item.msg_type === 'string' ? item.msg_type : ''
    this.lastError = undefined
    return {
      messageId: typeof item.message_id === 'string' ? item.message_id : messageId,
      msgType,
      content: extractMessageContent(msgType, item.body?.content),
      ...(typeof item.parent_id === 'string' ? { parentId: item.parent_id } : {}),
      ...(typeof item.root_id === 'string' ? { rootId: item.root_id } : {}),
      raw: item,
    }
  }

  /**
   * Add one handler to the shared receive channel, opening the long
   * connection on the first subscriber. The disposer removes the handler and
   * closes the connection once no subscriber remains; it is idempotent and
   * never touches a later replacement connection.
   */
  private subscribeReceive(kind: 'message', handler: FeishuReceiveHandler): () => void
  private subscribeReceive(kind: 'cardAction', handler: FeishuCardActionHandler): () => void
  private subscribeReceive(kind: 'message' | 'cardAction', handler: FeishuReceiveHandler | FeishuCardActionHandler): () => void {
    let state = this.receive
    if (state === undefined) {
      state = {
        controller: new AbortController(),
        messageHandlers: new Set(),
        cardActionHandlers: new Set(),
        wsClient: undefined,
      }
      this.receive = state
      this.receiveActive = true
      void this.beginReceiveConnection(state)
    }
    if (kind === 'message') state.messageHandlers.add(handler as FeishuReceiveHandler)
    else state.cardActionHandlers.add(handler as FeishuCardActionHandler)

    const owned = state
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      // A disposed-and-reopened channel is a NEW state object; never close it
      // on behalf of this stale subscription.
      if (this.receive !== owned) return
      if (kind === 'message') owned.messageHandlers.delete(handler as FeishuReceiveHandler)
      else owned.cardActionHandlers.delete(handler as FeishuCardActionHandler)
      if (owned.messageHandlers.size === 0 && owned.cardActionHandlers.size === 0) {
        owned.controller.abort()
        this.receive = undefined
        this.receiveActive = false
        owned.wsClient?.close({ force: true })
      }
    }
  }

  /**
   * Open the shared long connection for one receive state: resolve
   * credentials, build the event dispatcher for both message and card-action
   * events, and start the WS client. Failures record `lastError` and log;
   * they never throw out of the subscription path.
   */
  private async beginReceiveConnection(state: ReceiveState): Promise<void> {
    const options = this.resolveOptions()
    const logger = options.logger
    try {
      const appId = await this.resolveCredential(
        options.appId, options.resolveAppId, options.appIdEnv ?? 'FEISHU_APP_ID',
        'App ID', state.controller.signal,
      )
      const appSecret = await this.resolveCredential(
        options.appSecret, options.resolveAppSecret, options.appSecretEnv ?? 'FEISHU_APP_SECRET',
        'App Secret', state.controller.signal,
      )
      const sdk = await import('@larksuiteoapi/node-sdk')
      if (state.controller.signal.aborted) return

      const dispatcher = new sdk.EventDispatcher({ loggerLevel: sdk.LoggerLevel.warn })
      dispatcher.register({
        'im.message.receive_v1': (data: unknown): void => {
          const inner = data as { message?: unknown; sender?: unknown } | null | undefined
          const received = toReceiveEvent(inner?.message, inner?.sender, data, appId, this.id)
          if (received === undefined) return
          for (const messageHandler of state.messageHandlers) messageHandler(received)
        },
        'card.action.trigger': (data: unknown): void => {
          if (state.cardActionHandlers.size === 0) return
          const action = toCardActionEvent(data)
          for (const cardHandler of state.cardActionHandlers) cardHandler(action)
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
      state.wsClient = client

      void client.start({ eventDispatcher: dispatcher }).catch((error: unknown) => {
        if (state.controller.signal.aborted) return
        this.lastError = `Feishu long connection start failed: ${String(error)}`
        logger?.error(`feishu long connection start failed: ${String(error)}`)
      })
    } catch (error: unknown) {
      if (state.controller.signal.aborted) return
      if (this.receive === state) this.receiveActive = false
      this.lastError = `Feishu long connection setup failed: ${String(error)}`
      logger?.error(`feishu long connection setup failed: ${String(error)}`)
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

  /** Record one provider operation failure and return its stable-code error for the caller to throw. */
  private fail(message: string, code: string, cause?: unknown): FeishuError {
    this.lastError = message
    return new FeishuError(message, code, cause === undefined ? {} : { cause })
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
 * {@link FeishuReceiveEvent}. Returns undefined for unsupported or empty
 * content, which the caller drops. Text, rich-text (`post`), and interactive
 * card (`interactive`) messages are all reduced to their plain-text reading;
 * the received message id and any quoted / replied-to parent or thread root
 * ids ride along so consumers can resolve the referenced message.
 * @param message - the event's message body.
 * @param sender - the event's sender body.
 * @param raw - the raw event payload, attached to the emitted event.
 * @param appId - this provider's resolved Feishu App ID, stamped onto the event.
 * @param providerId - this provider's registry id, stamped for reply routing.
 * @returns the receive event, or undefined when the payload should be dropped.
 */
function toReceiveEvent(
  message: unknown,
  sender: unknown,
  raw: unknown,
  appId: string | undefined,
  providerId: string | undefined,
): FeishuReceiveEvent | undefined {
  const msg = message as Record<string, unknown> | undefined
  const snd = sender as Record<string, unknown> | undefined
  const senderIdType = normalizeSenderIdType(snd?.sender_type)
  const chatId = typeof msg?.chat_id === 'string' ? msg.chat_id : ''
  const rawMsgType = msg === undefined ? undefined : (msg.message_type ?? msg.msg_type)
  const msgType = typeof rawMsgType === 'string' ? rawMsgType : ''
  const content = extractMessageContent(msgType, msg?.content)
  if (content.length === 0) return undefined
  return {
    eventType: 'im.message.receive_v1',
    ...(appId === undefined ? {} : { appId }),
    ...(providerId === undefined ? {} : { providerId }),
    senderId: extractSenderId(snd?.sender_id, senderIdType),
    senderIdType,
    chatId,
    ...(typeof msg?.message_id === 'string' ? { messageId: msg.message_id } : {}),
    ...(typeof msg?.parent_id === 'string' ? { parentId: msg.parent_id } : {}),
    ...(typeof msg?.root_id === 'string' ? { rootId: msg.root_id } : {}),
    content,
    raw,
  }
}

/** Message content types the receive path reduces to plain text. */
const SUPPORTED_RECEIVE_TYPES = new Set(['text', 'post', 'interactive'])

/**
 * Reduce one Feishu message content string to its plain-text reading for the
 * given message type. Returns '' for unsupported types or unparsable content.
 * @param msgType - the Feishu message content type.
 * @param rawContent - the `content` JSON string from the message body.
 * @returns the extracted text, or '' when nothing readable was found.
 */
function extractMessageContent(msgType: string, rawContent: unknown): string {
  if (!SUPPORTED_RECEIVE_TYPES.has(msgType)) return ''
  const parsed = safeParseJson(typeof rawContent === 'string' ? rawContent : undefined)
  if (parsed === undefined) return ''
  switch (msgType) {
    case 'text':
      return typeof parsed.text === 'string' ? parsed.text : ''
    case 'post':
      return extractPostText(parsed)
    case 'interactive':
      return extractCardText(parsed)
    default:
      return ''
  }
}

/** Parse a JSON string into a record view, tolerating malformed input. */
function safeParseJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined
  try {
    const value = JSON.parse(raw) as unknown
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Locale keys a `post` body may be wrapped in, in resolution priority. */
const POST_LOCALE_PRIORITY = ['zh_cn', 'en_us', 'ja_jp'] as const

/**
 * Resolve the actual `{ title, content }` body of a `post`, unwrapping the
 * locale wrapper Feishu uses when the post declares per-locale variants.
 */
function unwrapPostLocale(parsed: Record<string, unknown>): Record<string, unknown> | undefined {
  if ('title' in parsed || 'content' in parsed) return parsed
  for (const locale of POST_LOCALE_PRIORITY) {
    const hit = parsed[locale]
    if (isRecord(hit)) return hit
  }
  for (const value of Object.values(parsed)) {
    if (isRecord(value)) return value
  }
  return undefined
}

/**
 * Extract plain text from a Feishu `post` (rich-text) content body: the title
 * line followed by each paragraph, with inline links, @-mentions, and images
 * rendered as readable text.
 */
function extractPostText(parsed: Record<string, unknown>): string {
  const body = unwrapPostLocale(parsed)
  if (body === undefined) return ''
  const title = typeof body.title === 'string' ? body.title : ''
  const paragraphs = Array.isArray(body.content) ? body.content : []
  return renderPostBody(title, paragraphs)
}

/**
 * Render a post-shaped body — a title line followed by an array of paragraphs,
 * each an array of inline `text` / `a` / `at` / `img` elements — as plain text.
 * Shared by native `post` messages and by interactive cards, which the
 * get-message endpoint returns in this same flattened form under `elements`.
 */
function renderPostBody(title: string, paragraphs: unknown[]): string {
  const lines: string[] = []
  if (title.length > 0) lines.push(title)
  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) continue
    const parts: string[] = []
    for (const el of paragraph) {
      if (isRecord(el)) parts.push(renderPostElement(el))
    }
    const line = parts.join('')
    if (line.length > 0) lines.push(line)
  }
  return lines.join('\n')
}

/** Render one inline `post` element (text, link, mention, image) as readable text. */
function renderPostElement(element: Record<string, unknown>): string {
  const tag = typeof element.tag === 'string' ? element.tag : ''
  switch (tag) {
    case 'text':
      return typeof element.text === 'string' ? element.text : ''
    case 'a': {
      const href = typeof element.href === 'string' ? element.href : ''
      const label = typeof element.text === 'string' && element.text.length > 0 ? element.text : href
      return href.length > 0 ? `[${label}](${href})` : label
    }
    case 'at': {
      const userId = typeof element.user_id === 'string' ? element.user_id : ''
      if (userId === 'all' || userId === 'all_members') return '@all'
      const name = typeof element.user_name === 'string' ? element.user_name : ''
      return name.length > 0 ? `@${name}` : (userId.length > 0 ? `@${userId}` : '')
    }
    case 'img':
      return typeof element.image_key === 'string' && element.image_key.length > 0 ? '[图片]' : ''
    default:
      return typeof element.text === 'string' ? element.text : ''
  }
}

/**
 * Extract human-readable text from a Feishu interactive card, walking header
 * titles and subtitles, plain-text / markdown elements, button labels, notes,
 * form labels, image captions, and nested containers. Adjacent duplicate pieces
 * are collapsed preserving order.
 */
function extractCardText(parsed: Record<string, unknown>): string {
  // The get-message endpoint returns interactive cards in post-shaped form —
  // `{ title, elements: [[{tag: "text"|"a"|"at"|"img", …}, …], …] }` — instead
  // of the card-authoring schema. Route that body through the post renderer so
  // a referenced card resolves to readable text rather than ''.
  if (Array.isArray(parsed.elements) && parsed.elements.every(paragraph => Array.isArray(paragraph))) {
    return renderPostBody(typeof parsed.title === 'string' ? parsed.title : '', parsed.elements)
  }
  const pieces: string[] = []
  visitCard(parsed, pieces)
  const seen = new Set<string>()
  const out: string[] = []
  for (const piece of pieces) {
    if (typeof piece !== 'string') continue
    const trimmed = piece.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out.join('\n')
}

/** Recursively collect readable text strings from a card node tree. */
function visitCard(node: unknown, out: string[]): void {
  if (node === null || node === undefined) return
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    for (const child of node) visitCard(child, out)
    return
  }
  if (typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  const tag = typeof obj.tag === 'string' ? obj.tag : ''
  if (tag === 'plain_text' || tag === 'lark_md' || tag === 'markdown') {
    if (typeof obj.content === 'string') out.push(obj.content)
    return
  }
  if (tag === 'img') {
    if (obj.alt !== undefined) visitCard(obj.alt, out)
    if (obj.title !== undefined) visitCard(obj.title, out)
    if (obj.alt === undefined && obj.title === undefined) out.push('[图片]')
    return
  }
  if (isRecord(obj.header)) {
    visitCard(obj.header.title, out)
    visitCard(obj.header.subtitle, out)
  }
  for (const key of ['text', 'label', 'placeholder'] as const) {
    if (obj[key] !== undefined) visitCard(obj[key], out)
  }
  for (const key of ['options', 'elements', 'fields', 'actions', 'columns'] as const) {
    if (Array.isArray(obj[key])) visitCard(obj[key], out)
  }
  if (obj.body !== undefined) visitCard(obj.body, out)
}

/** True for a plain object (not null, not an array) used as a record view. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Read the first string among candidates, in priority order. */
function firstString(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string') return candidate
  }
  return ''
}

/**
 * Convert one `card.action.trigger` payload into a {@link FeishuCardActionEvent}.
 * The current event shape nests the message/chat ids under `context`; older
 * or alternate surfaces may deliver them at the top level, so both are read.
 * The `value` payload is passed through UNVALIDATED — it is attacker-controllable
 * card data, and consumers validate it against their own trusted state.
 * @param raw - the raw card-action payload delivered by the long-connection client.
 * @returns the normalized card-action event.
 */
function toCardActionEvent(raw: unknown): FeishuCardActionEvent {
  const event = isRecord(raw) ? raw : undefined
  const context = isRecord(event?.context) ? event.context : undefined
  const operator = isRecord(event?.operator) ? event.operator : undefined
  const action = isRecord(event?.action) ? event.action : undefined
  const formValue = isRecord(action?.form_value) ? action.form_value : undefined
  return {
    operatorId: firstString(operator?.open_id),
    chatId: firstString(context?.open_chat_id, event?.open_chat_id),
    messageId: firstString(context?.open_message_id, event?.open_message_id),
    value: action?.value,
    ...(formValue === undefined ? {} : { formValue }),
    raw,
  }
}
