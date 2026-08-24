/**
 * Service Definition for the Feishu chat capability seam (`ctx.feishu`): provider registry and
 * selection for sending and receiving messages. Duplicate ids are rejected. At execution time, a
 * configured provider must exist and be usable; without one, exactly one usable provider is
 * required, so selection never depends on registration order.
 * @module @deepseek-ai/dsh-feishu
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  FeishuCardActionHandler,
  FeishuMessage,
  FeishuMessageResource,
  FeishuProvider,
  FeishuReceiveHandler,
  FeishuRuntimeStatus,
  FeishuSendRequest,
  FeishuSendResult,
} from './types.ts'
import { FeishuError } from './types.ts'

export {
  FEISHU_CONNECTION_STATES,
  FEISHU_MSG_TYPES,
  FEISHU_RECEIVE_ID_TYPES,
  FeishuError,
} from './types.ts'
export type {
  FeishuCardActionEvent,
  FeishuCardActionHandler,
  FeishuConnectionState,
  FeishuMessage,
  FeishuMessageImage,
  FeishuMessageResource,
  FeishuMsgType,
  FeishuProvider,
  FeishuProviderStatus,
  FeishuReceiveEvent,
  FeishuReceiveHandler,
  FeishuReceiveIdType,
  FeishuRuntimeStatus,
  FeishuSendRequest,
  FeishuSendResult,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    feishu: FeishuRuntime
  }

  interface Events {
    /**
     * A Feishu provider was registered with `ctx.feishu.registerProvider`.
     * Load-time consumers (receive channels) subscribe here so they open on
     * the registered provider regardless of parallel entry load order.
     * @param provider - the registered provider.
     * @mode emit
     */
    'feishu/provider-added'(provider: FeishuProvider): void
    /**
     * A Feishu provider left the registry (its registering fiber unloaded).
     * @param id - the provider id that no longer resolves.
     * @mode emit
     */
    'feishu/provider-removed'(id: string): void
  }
}

/** Selection inputs for execution-time provider resolution. */
interface Selection<P> {
  /** The configured provider id for this capability, if any. */
  readonly configuredId?: string
  /** Providers registered for this capability kind. */
  readonly providers: ReadonlyMap<string, P>
}

/**
 * Config for the Feishu seam. `provider` pins which provider wins; omitted
 * auto-selects when exactly one usable provider is registered.
 */
export interface FeishuRuntimeConfig {
  /** Explicit provider id. Omitted = auto-select when exactly one usable. */
  readonly provider?: string
}

/**
 * The Feishu chat service. Registered as `ctx.feishu` (one instance per context).
 *
 * Selection semantics (resolved at execution time, never order-dependent):
 * - A configured id that is registered and `available()` → that provider.
 * - A configured id not registered → `FEISHU_PROVIDER_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable →
 *   `FEISHU_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - No id configured, exactly one registered usable provider → that provider.
 * - No id configured, multiple usable providers → `FEISHU_PROVIDER_AMBIGUOUS`.
 * - No id configured, no usable provider → `FEISHU_PROVIDER_UNAVAILABLE`.
 */
export class FeishuRuntime extends Service {
  /**
   * Provider selection config. Operational env overrides feed the SAME fields:
   * `$DSH_FEISHU_PROVIDER` is equivalent to `provider` and is NOT a hidden
   * priority chain.
   */
  static Config: z<FeishuRuntimeConfig> = z.object({
    provider: z.string(),
  })

  private providers = new Map<string, FeishuProvider>()
  /** Last provider that delivered each chat id, so replies route back through the same app. */
  private readonly chatProvider = new Map<string, string>()
  private readonly providerId: string | undefined

  constructor(ctx: Context, config: FeishuRuntimeConfig = {}) {
    super(ctx, 'feishu')
    this.providerId = config.provider ?? process.env.DSH_FEISHU_PROVIDER
  }

  /**
   * Every registered provider, in registration order.
   * @returns the registered providers.
   */
  listProviders(): readonly FeishuProvider[] {
    return [...this.providers.values()]
  }

  /**
   * Register a Feishu provider. Throws {@link FeishuError} `FEISHU_DUPLICATE_PROVIDER`
   * if its id is already registered. Returns a disposer; disposed with the calling fiber.
   * Emits `feishu/provider-added` once the registration commits (a throwing
   * listener rolls it back) and `feishu/provider-removed` when it is disposed.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerProvider(provider: FeishuProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new FeishuError(
        `a Feishu provider with id "${provider.id}" is already registered`,
        'FEISHU_DUPLICATE_PROVIDER',
      )
    }
    const store = this.providers
    const ctx = this.ctx
    const dispose = ctx.effect(function* () {
      store.set(provider.id, provider)
      yield () => {
        store.delete(provider.id)
        ctx.emit('feishu/provider-removed', provider.id)
      }
      // A throwing added-listener unwinds the yielded rollback, matching the
      // repository's fail-loud registration semantics.
      ctx.emit('feishu/provider-added', provider)
    }, 'feishu.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Send one message through the selected provider. Resolves the provider at call
   * time with the selection rules above; throws {@link FeishuError} when the
   * capability cannot run.
   * @param request - the target recipient and content.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the provider's send result.
   */
  async sendMessage(request: FeishuSendRequest, signal?: AbortSignal): Promise<FeishuSendResult> {
    const provider = this.routeProvider(request)
    return provider.sendMessage(request, signal)
  }

  /**
   * Start receiving messages through the selected provider. Resolves the
   * provider at call time with the selection rules above; throws
   * {@link FeishuError} `FEISHU_RECEIVE_UNSUPPORTED` when the provider has no
   * `startReceiving`, or the provider's own failure when it cannot set up its
   * receive channel (e.g. unmatched credentials).
   * @param handler - the callback for each received {@link FeishuReceiveEvent}.
   * @returns a disposer that stops the receive channel.
   */
  startReceiving(handler: FeishuReceiveHandler): () => void {
    const provider = this.resolveProvider()
    if (provider.startReceiving === undefined) {
      throw new FeishuError(
        `Feishu provider "${provider.id}" does not support receiving messages`,
        'FEISHU_RECEIVE_UNSUPPORTED',
      )
    }
    return provider.startReceiving(handler)
  }

  /**
   * Start receiving from every registered provider that can receive. Each
   * inbound event is stamped with its provider id and recorded against its chat
   * id, so a reply to that chat routes back through the same app. Returns a
   * combined disposer that closes every opened channel.
   * @param handler - the callback for each received {@link FeishuReceiveEvent}.
   * @returns a disposer that stops every channel this call opened.
   */
  startReceivingAll(handler: FeishuReceiveHandler): () => void {
    const usable = [...this.providers.values()].filter(provider => provider.available())
    const receivables = usable.filter(
      (provider): provider is FeishuProvider & { startReceiving: NonNullable<FeishuProvider['startReceiving']> } =>
        provider.startReceiving !== undefined,
    )
    const [unusable] = usable
    if (unusable !== undefined && receivables.length === 0) {
      throw new FeishuError(
        `Feishu provider "${unusable.id}" does not support receiving messages`,
        'FEISHU_RECEIVE_UNSUPPORTED',
      )
    }
    const disposers: Array<() => void> = []
    for (const provider of receivables) {
      const dispose = provider.startReceiving((event) => {
        if (event.providerId !== undefined && event.chatId.length > 0) {
          this.chatProvider.set(event.chatId, event.providerId)
        }
        handler(event)
      })
      disposers.push(dispose)
    }
    return () => {
      for (const dispose of disposers) dispose()
    }
  }

  /**
   * Start receiving card button actions through the selected provider.
   * Resolves the provider at call time with the selection rules above;
   * throws {@link FeishuError} `FEISHU_RECEIVE_UNSUPPORTED` when the
   * provider has no `startReceivingCardActions`. Card actions share the
   * provider's receive channel with {@link startReceiving} subscribers.
   * @param handler - the callback for each received {@link FeishuCardActionEvent}.
   * @returns a disposer that stops this card-action subscription.
   */
  startReceivingCardActions(handler: FeishuCardActionHandler): () => void {
    const provider = this.resolveProvider()
    if (provider.startReceivingCardActions === undefined) {
      throw new FeishuError(
        `Feishu provider "${provider.id}" does not support receiving card actions`,
        'FEISHU_RECEIVE_UNSUPPORTED',
      )
    }
    return provider.startReceivingCardActions(handler)
  }

  /**
   * Replace the content of a message sent earlier through the selected
   * provider. Resolves the provider at call time with the selection rules
   * above; throws {@link FeishuError} `FEISHU_UPDATE_UNSUPPORTED` when the
   * provider has no `updateMessage`, or the provider's own failure when the
   * update does not succeed.
   * @param messageId - the provider message id returned by an earlier send.
   * @param content - the replacement content.
   * @param signal - optional cancellation signal forwarded to the provider.
   */
  async updateMessage(messageId: string, content: string, signal?: AbortSignal): Promise<void> {
    const provider = this.resolveProvider()
    if (provider.updateMessage === undefined) {
      throw new FeishuError(
        `Feishu provider "${provider.id}" does not support updating messages`,
        'FEISHU_UPDATE_UNSUPPORTED',
      )
    }
    return provider.updateMessage(messageId, content, signal)
  }

  /**
   * Fetch one message by id through the selected provider — e.g. to read a
   * quoted or replied-to message referenced by an inbound event. Resolves the
   * provider at call time with the selection rules above; throws
   * {@link FeishuError} `FEISHU_GET_UNSUPPORTED` when the provider has no
   * `getMessage`, or the provider's own failure when the fetch does not
   * succeed.
   * @param messageId - the Feishu message id.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the fetched message with its content extracted as plain text.
   */
  async getMessage(messageId: string, signal?: AbortSignal): Promise<FeishuMessage> {
    const provider = this.resolveProvider()
    if (provider.getMessage === undefined) {
      throw new FeishuError(
        `Feishu provider "${provider.id}" does not support reading messages`,
        'FEISHU_GET_UNSUPPORTED',
      )
    }
    return provider.getMessage(messageId, signal)
  }

  /**
   * Fetch one binary image attached to a message through the selected provider —
   * e.g. the image a user posted so a multimodal model can read it. Resolves
   * the provider at call time with the selection rules above; throws
   * {@link FeishuError} `FEISHU_RESOURCE_UNSUPPORTED` when the provider has no
   * `getMessageResource`, or the provider's own failure when the fetch does not
   * succeed.
   * @param messageId - the Feishu message id the image belongs to.
   * @param fileKey - the image's file key from the message content.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the raw image bytes.
   */
  async getMessageResource(messageId: string, fileKey: string, signal?: AbortSignal): Promise<FeishuMessageResource> {
    const provider = this.resolveProvider()
    if (provider.getMessageResource === undefined) {
      throw new FeishuError(
        `Feishu provider "${provider.id}" does not support reading message resources`,
        'FEISHU_RESOURCE_UNSUPPORTED',
      )
    }
    return provider.getMessageResource(messageId, fileKey, signal)
  }

  /**
   * Project the effective connection state of this capability for status
   * surfaces. Applies the same selection rules as {@link sendMessage} without
   * throwing; selection failures surface as `state: 'error'` with
   * {@link FeishuRuntimeStatus.selectionError}. Providers without a `status`
   * method project from `available()`.
   * @returns the effective status view.
   */
  async describeStatus(): Promise<FeishuRuntimeStatus> {
    const result = selectProvider({
      providers: this.providers,
      ...this.providerId !== undefined ? { configuredId: this.providerId } : {},
    })
    switch (result.kind) {
      case 'selected':
        return await projectProvider(result.provider)
      case 'configured-missing':
        return {
          state: 'error',
          providerId: result.configuredId,
          selectionError: `configured Feishu provider "${result.configuredId}" is not registered`,
        }
      case 'configured-unavailable':
        return await projectProvider(result.provider)
      case 'ambiguous':
        return {
          state: 'error',
          selectionError: `multiple usable Feishu providers are registered (${result.ids.join(', ')}); configure one explicitly`,
        }
      case 'unavailable':
        return { state: 'unavailable' }
    }
  }

  /** Resolve the selected provider with the seam's selection rules. */
  private resolveProvider(): FeishuProvider {
    return resolveProvider({
      providers: this.providers,
      ...this.providerId !== undefined ? { configuredId: this.providerId } : {},
    })
  }

  /**
   * Resolve the provider for one send: an explicit request provider id first,
   * then the provider that last delivered the target chat, then the seam's
   * default selection rules.
   * @param request - the send request carrying the optional route hint.
   * @returns the provider the send must use.
   */
  private routeProvider(request: FeishuSendRequest): FeishuProvider {
    const id = request.providerId ?? this.chatProvider.get(request.receiveId)
    if (id !== undefined) {
      const provider = this.providers.get(id)
      if (provider === undefined) {
        throw new FeishuError(`Feishu provider "${id}" is not registered`, 'FEISHU_PROVIDER_CONFIGURED_MISSING')
      }
      return provider
    }
    return this.resolveProvider()
  }
}

interface ResolvableProvider {
  readonly id: string
  available(): boolean
}

/** Terminal outcome of provider selection; one variant per possible state. */
type SelectionResult<P> =
  | { readonly kind: 'selected'; readonly provider: P }
  | { readonly kind: 'configured-missing'; readonly configuredId: string }
  | { readonly kind: 'configured-unavailable'; readonly provider: P }
  | { readonly kind: 'ambiguous'; readonly ids: readonly string[] }
  | { readonly kind: 'unavailable' }

/** Select a provider without throwing; one variant per terminal state. */
function selectProvider<P extends ResolvableProvider>(selection: Selection<P>): SelectionResult<P> {
  const { configuredId, providers } = selection
  if (configuredId !== undefined) {
    const provider = providers.get(configuredId)
    if (provider === undefined) return { kind: 'configured-missing', configuredId }
    if (!provider.available()) return { kind: 'configured-unavailable', provider }
    return { kind: 'selected', provider }
  }
  const usable = [...providers.values()].filter(provider => provider.available())
  const [single] = usable
  if (single === undefined) return { kind: 'unavailable' }
  if (usable.length > 1) return { kind: 'ambiguous', ids: usable.map(provider => provider.id) }
  return { kind: 'selected', provider: single }
}

/** Resolve the selected provider or throw the matching {@link FeishuError}. */
function resolveProvider<P extends ResolvableProvider>(selection: Selection<P>): P {
  const result = selectProvider(selection)
  switch (result.kind) {
    case 'selected':
      return result.provider
    case 'configured-missing':
      throw new FeishuError(
        `configured Feishu provider "${result.configuredId}" is not registered`,
        'FEISHU_PROVIDER_CONFIGURED_MISSING',
      )
    case 'configured-unavailable':
      throw new FeishuError(
        `configured Feishu provider "${result.provider.id}" is registered but unavailable`,
        'FEISHU_PROVIDER_CONFIGURED_UNAVAILABLE',
      )
    case 'ambiguous':
      throw new FeishuError(
        `multiple usable Feishu providers are registered (${result.ids.join(', ')}); configure one explicitly`,
        'FEISHU_PROVIDER_AMBIGUOUS',
      )
    case 'unavailable':
      throw new FeishuError('no usable Feishu provider is registered', 'FEISHU_PROVIDER_UNAVAILABLE')
  }
}

/**
 * Project one provider's status view. Providers without a `status` method
 * fall back to `available()`.
 */
async function projectProvider(provider: FeishuProvider): Promise<FeishuRuntimeStatus> {
  if (provider.status === undefined) {
    return {
      state: provider.available() ? 'connected' : 'unavailable',
      providerId: provider.id,
    }
  }
  const providerStatus = await provider.status()
  return {
    state: providerStatus.state,
    providerId: provider.id,
    providerStatus,
  }
}

export default FeishuRuntime
