import type { FeishuConnectionState, FeishuProviderStatus } from '@deepseek-ai/dsh-feishu'

/**
 * Point-in-time Feishu integration status returned by the status Remote.
 * Values are display-safe: the provider masks identifying values and reduces
 * secrets to booleans before they cross the wire.
 */
export interface FeishuStatusView {
  /** The effective connection state after the seam's selection rules. */
  readonly state: FeishuConnectionState
  /** The selected provider id, when selection produced one. */
  readonly providerId?: string
  /** The selected provider's display-safe status, when it reports one. */
  readonly provider?: FeishuProviderStatus
  /** Why the seam could not select a provider, when it could not. */
  readonly selectionError?: string
}

/**
 * One bot's display-safe status, for the multi-bot configuration surface.
 * Masked on purpose: the App ID is display-only and never enough to route, and
 * secrets stay booleans.
 */
export interface FeishuBotStatusView {
  /** The bot's registry id (the mapping key). */
  readonly id: string
  /** Display-safe App ID, when the provider knows one. */
  readonly maskedAppId?: string
  /** The bot's connection state. */
  readonly state: FeishuConnectionState
  /** Whether the provider can currently resolve this bot's App Secret. */
  readonly appSecretConfigured?: boolean
  /** Whether this bot currently has an open receive channel. */
  readonly receiveActive: boolean
  /** The most recent failure, when recorded. */
  readonly lastError?: string
}
