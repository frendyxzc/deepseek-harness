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

/** One message received from Feishu. */
export interface FeishuReceiveEvent {
  /** The event type (e.g. `im.message.receive_v1`). */
  readonly eventType: string
  /** The sender's id. */
  readonly senderId: string
  /** The sender id type. */
  readonly senderIdType: FeishuReceiveIdType
  /** The chat or user id where the message was received. */
  readonly chatId: string
  /** The message content as plain text (extracted from the event body). */
  readonly content: string
  /** The raw event payload for provider-specific handling. */
  readonly raw: unknown
}

/** Callback invoked when a message is received from Feishu. */
export type FeishuReceiveHandler = (event: FeishuReceiveEvent) => void

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
