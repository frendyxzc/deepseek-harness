/**
 * Vocabulary for the Feishu chat capability seam (`ctx.feishu`). Request/result types are
 * provider-neutral; the seam owns selection, cancellation, and the error taxonomy.
 * @module @deepseek-ai/dsh-feishu/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Recipient id types recognised by the Feishu IM API. */
export const FEISHU_RECEIVE_ID_TYPES = ['open_id', 'user_id', 'union_id', 'email', 'chat_id'] as const
/** A recipient id type recognised by the Feishu IM API. */
export type FeishuReceiveIdType = (typeof FEISHU_RECEIVE_ID_TYPES)[number]

/** Message content types the seam supports. */
export const FEISHU_MSG_TYPES = ['text', 'interactive'] as const
/** A message content type the seam supports. */
export type FeishuMsgType = (typeof FEISHU_MSG_TYPES)[number]

/**
 * Target of a send-message operation. The provider resolves the concrete Feishu
 * recipient type (open_id, user_id, chat_id, etc.) from the target kind.
 */
export interface FeishuSendRequest {
  /** The target recipient id. */
  readonly receiveId: string
  /** The recipient id type; defaults to `open_id` when omitted. */
  readonly receiveIdType?: FeishuReceiveIdType
  /** Explicit provider id to route through; omitted uses the seam's selection (and per-chat routing). */
  readonly providerId?: string
  /** Message content as a plain text string. */
  readonly content: string
  /**
   * Message type. Card (`interactive`) content must be a JSON string per the
   * Feishu card schema; defaults to `text` when omitted.
   */
  readonly msgType?: FeishuMsgType
}

/** Outcome of a successful send-message operation. */
export interface FeishuSendResult {
  /** The Feishu-assigned message id. */
  readonly messageId: string
}

/**
 * One image discovered in Feishu message content. The enclosing message's id
 * is the download scope: a consumer combines this `fileKey` with the event or
 * fetched message's `messageId` to fetch the image bytes.
 */
export interface FeishuMessageImage {
  /** The Feishu image key used as the download file key. */
  readonly fileKey: string
}

/** One binary image resource fetched from a Feishu/Lark message. */
export interface FeishuMessageResource {
  /** Raw image bytes. */
  readonly data: Uint8Array
}

/** One message received from Feishu. */
export interface FeishuReceiveEvent {
  /** The event type (e.g. `im.message.receive_v1`). */
  readonly eventType: string
  /** The Feishu App ID that received this event, when the provider knows it. */
  readonly appId?: string
  /** The provider registry id that received this event, when the provider knows it. */
  readonly providerId?: string
  /** The sender's id. */
  readonly senderId: string
  /** The sender id type. */
  readonly senderIdType: FeishuReceiveIdType
  /** The chat or user id where the message was received. */
  readonly chatId: string
  /** The received message's id, when the event carries one. */
  readonly messageId?: string
  /** The immediately referenced (quoted / replied-to) message id, when present. */
  readonly parentId?: string
  /** The thread root message id, when the message is part of a reply thread. */
  readonly rootId?: string
  /** The message content as plain text (extracted from the event body). */
  readonly content: string
  /** Images discovered in the message content, scoped to this event's message id. */
  readonly images?: readonly FeishuMessageImage[]
  /** The raw event payload for provider-specific handling. */
  readonly raw: unknown
}

/** One message fetched by id from a Feishu/Lark backend. */
export interface FeishuMessage {
  /** The message's id. */
  readonly messageId: string
  /** The message content type (e.g. `text`, `post`, `interactive`). */
  readonly msgType: string
  /** The readable plain text extracted from the message content. */
  readonly content: string
  /** Images discovered in the message content, scoped to this message's id. */
  readonly images?: readonly FeishuMessageImage[]
  /** The immediately referenced (quoted / replied-to) message id, when present. */
  readonly parentId?: string
  /** The thread root message id, when the message is part of a reply thread. */
  readonly rootId?: string
  /** The raw payload for provider-specific handling. */
  readonly raw: unknown
}

/** Callback invoked when a message is received from Feishu. */
export type FeishuReceiveHandler = (event: FeishuReceiveEvent) => void

/**
 * One card button action received from Feishu — an operator tapped a button on
 * an interactive card message delivered over the same channel as messages.
 */
export interface FeishuCardActionEvent {
  /** The open id of the operator who tapped the button. */
  readonly operatorId: string
  /** The chat the card message lives in. */
  readonly chatId: string
  /** The message id of the tapped card message. */
  readonly messageId: string
  /**
   * The tapped button's value payload. Attacker-controllable card data:
   * consumers must validate it against trusted state (e.g. a nonce they
   * minted when the card was built) before acting on it.
   */
  readonly value: unknown
  /**
   * The submitted form controls' values, present when the tapped action
   * submitted a card form (a submit button inside a form container). Keys
   * are the control names the card builder chose; values are
   * control-shaped (selected indices, checked booleans, typed text).
   * Attacker-controllable card data with the same validation obligation
   * as {@link value}; absent for plain button taps that submit no form.
   */
  readonly formValue?: Record<string, unknown>
  /** The raw event payload for provider-specific handling. */
  readonly raw: unknown
}

/** Callback invoked when a card button action is received from Feishu. */
export type FeishuCardActionHandler = (event: FeishuCardActionEvent) => void

/** Connection states a Feishu provider or the capability as a whole reports. */
export const FEISHU_CONNECTION_STATES = ['unavailable', 'unconfigured', 'connected', 'error'] as const
/** A connection state reported by a Feishu provider or the capability as a whole. */
export type FeishuConnectionState = (typeof FEISHU_CONNECTION_STATES)[number]

/**
 * Display-safe status projection of one Feishu provider for status surfaces.
 * Values that identify the application are masked; secrets are reduced to
 * booleans, so a status surface never receives raw credentials.
 */
export interface FeishuProviderStatus {
  /** The provider's current connection state. */
  readonly state: FeishuConnectionState
  /** Display-safe rendering of the configured App ID, when one is known. */
  readonly appIdMasked?: string
  /** Whether the provider can currently resolve an App Secret. */
  readonly appSecretConfigured: boolean
  /** Feishu Open API base URL the provider resolves operations against. */
  readonly baseURL?: string
  /** Whether the provider currently has an open receive channel. */
  readonly receiveActive: boolean
  /** The most recent recorded failure or configuration problem, when one exists. */
  readonly lastError?: string
}

/**
 * Effective status of the Feishu capability after applying the seam's
 * selection rules.
 */
export interface FeishuRuntimeStatus {
  /** The effective connection state. */
  readonly state: FeishuConnectionState
  /** The selected provider id, when selection produced one. */
  readonly providerId?: string
  /** The selected provider's own status projection, when it reports one. */
  readonly providerStatus?: FeishuProviderStatus
  /** Why the seam could not select a provider, when it could not. */
  readonly selectionError?: string
}

/**
 * A Feishu-capable backend. Registered with `ctx.feishu.registerProvider`.
 * `id` is a stable string, unique within the Feishu capability.
 */
export interface FeishuProvider {
  readonly id: string
  /** Cheap local usability check; must not make network calls. */
  available(): boolean
  /** Send one message; honor `signal` for cancellation. */
  sendMessage(request: FeishuSendRequest, signal?: AbortSignal): Promise<FeishuSendResult>
  /**
   * Start receiving messages from Feishu through a long connection. The
   * provider dials out to Feishu and calls `handler` for each received event.
   * Returns a disposer that stops receiving.
   * @param handler - the callback for each received event.
   * @returns a disposer that stops the receive channel.
   */
  startReceiving?(handler: FeishuReceiveHandler): () => void
  /**
   * Start receiving card button actions from Feishu through the provider's
   * receive channel — the same long connection a `startReceiving` subscriber
   * opens, never a second one. The provider calls `handler` for each tapped
   * card action. Handlers must settle fast (Feishu expects the callback
   * acknowledged promptly); anything slow belongs behind the handler.
   * Returns a disposer that stops this subscription; the underlying channel
   * closes when its last subscriber disposes.
   * @param handler - the callback for each received card action.
   * @returns a disposer that stops this card-action subscription.
   */
  startReceivingCardActions?(handler: FeishuCardActionHandler): () => void
  /**
   * Replace the content of a message sent earlier through this provider —
   * e.g. settling an interactive card after its buttons were consumed.
   * `content` carries the same encoding as {@link FeishuSendRequest.content}
   * for the message's existing type. Honor `signal` for cancellation.
   * @param messageId - the provider message id returned by an earlier send.
   * @param content - the replacement content.
   * @param signal - optional cancellation signal.
   */
  updateMessage?(messageId: string, content: string, signal?: AbortSignal): Promise<void>
  /**
   * Fetch one message by id from the backend — e.g. to read a quoted or
   * replied-to message so a reply's full context is available. Honor
   * `signal` for cancellation.
   * @param messageId - the Feishu message id.
   * @param signal - optional cancellation signal.
   * @returns the fetched message with its content extracted as plain text.
   */
  getMessage?(messageId: string, signal?: AbortSignal): Promise<FeishuMessage>
  /**
   * Fetch one binary image attached to a message — e.g. the image a user
   * posted, so a multimodal model can read it. `fileKey` is the image key
   * from the message content (an {@link FeishuMessageImage.fileKey}). Honor
   * `signal` for cancellation.
   * @param messageId - the Feishu message id the image belongs to.
   * @param fileKey - the image's file key from the message content.
   * @param signal - optional cancellation signal.
   * @returns the raw image bytes.
   */
  getMessageResource?(messageId: string, fileKey: string, signal?: AbortSignal): Promise<FeishuMessageResource>
  /**
   * Project this provider's connection state and display-safe configuration
   * for status surfaces. May resolve credentials; must not throw. Providers
   * without this method project from `available()`.
   * @returns the provider's current status projection.
   */
  status?(): Promise<FeishuProviderStatus>
}

/**
 * Typed Feishu error with a machine-routable, open-string `code` and chained `cause`.
 * Consumers must tolerate provider-specific codes. Shared codes cover unavailable,
 * missing, or unusable providers, cancellation, authentication failure, and provider errors.
 */
export class FeishuError extends HarnessError {}
