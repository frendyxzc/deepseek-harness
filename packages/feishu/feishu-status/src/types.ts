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
