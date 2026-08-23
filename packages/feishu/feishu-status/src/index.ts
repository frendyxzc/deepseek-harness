/** Read-only projection of the Feishu capability's effective connection status. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-feishu'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type { FeishuBotStatusView, FeishuStatusView } from './types.ts'

export type * from './types.ts'

/** Remote-only service exposing the Feishu seam's effective connection status. */
export class FeishuStatusGateway extends TypertRemoteService {
  static inject = ['feishu']

  constructor(ctx: Context) {
    super(ctx, 'feishuStatus')
  }

  /**
   * Project the seam's current status on every call, so the view reflects the
   * provider registry as it stands now.
   * @returns the effective status view.
   */
  @Remote('status')
  async status(): Promise<FeishuStatusView> {
    const status = await this.ctx.feishu.describeStatus()
    return {
      state: status.state,
      ...(status.providerId === undefined ? {} : { providerId: status.providerId }),
      ...(status.providerStatus === undefined ? {} : { provider: status.providerStatus }),
      ...(status.selectionError === undefined ? {} : { selectionError: status.selectionError }),
    }
  }

  /**
   * Project every registered bot's display-safe status, for the multi-bot
   * configuration surface.
   * @returns one entry per registered provider.
   */
  @Remote('list')
  async list(): Promise<FeishuBotStatusView[]> {
    return await Promise.all(this.ctx.feishu.listProviders().map(async (provider) => {
      let status
      try {
        status = provider.status === undefined ? undefined : await provider.status()
      } catch {
        status = undefined
      }
      return {
        id: provider.id,
        ...(status?.appIdMasked === undefined ? {} : { maskedAppId: status.appIdMasked }),
        state: status?.state ?? (provider.available() ? 'connected' : 'unavailable'),
        receiveActive: status?.receiveActive ?? false,
        ...(status?.lastError === undefined ? {} : { lastError: status.lastError }),
      }
    }))
  }
}

export default FeishuStatusGateway
