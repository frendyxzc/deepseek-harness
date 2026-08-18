/**
 * `@deepseek-ai/dsh-feishu-receive`: a consumer plugin that routes incoming Feishu
 * messages into the active agent session. It starts the seam's long-connection
 * receive channel and delivers each message as a user follow-up to the first root agent.
 *
 * @module @deepseek-ai/dsh-feishu-receive
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-feishu'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'feishu-receive'

/**
 * Services required by the Feishu receive consumer: the Feishu seam to start
 * receiving from, and the agent registry the received messages are delivered into.
 */
export const inject = ['feishu', 'agents']

/**
 * Start receiving Feishu messages through the long-connection channel and deliver
 * each to the first root agent. A start failure (a send-only provider) is a
 * configuration error that fails this plugin's fiber.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.feishu.startReceiving((event) => {
    const agent = ctx.agents.roots()[0]
    if (agent === undefined) {
      ctx.logger.warn('feishu-receive: no root agent to receive a message; dropped')
      return
    }
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: event.content }],
      source: { kind: 'user' },
    }))
    ctx.logger.info('feishu-receive: delivered a message to agent %s', agent.id)
  }), 'feishu-receive.startReceiving()')
}
