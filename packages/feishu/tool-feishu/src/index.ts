/**
 * Model-facing `feishu_send_message` tool over `ctx.feishu`. This package owns the
 * tool schema, validation, prompt guidance, and presentation, never concrete providers.
 * @module @deepseek-ai/dsh-tool-feishu
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FEISHU_MSG_TYPES, FEISHU_RECEIVE_ID_TYPES } from '@deepseek-ai/dsh-feishu'
import type {} from '@deepseek-ai/dsh-feishu'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-feishu'

/** Services required by the Feishu tool. */
export const inject = ['tools', 'feishu', 'systemPrompt']

/** Default cooperative tool-call timeout budget (ms) for the Feishu tool. */
export const DEFAULT_FEISHU_TOOL_TIMEOUT_MS = 30_000

/** Plugin config: whether to register the tool and its timeout budget. */
export interface Config {
  /** Register `feishu_send_message`. Defaults to true. */
  send?: boolean
  /** Cooperative timeout budget (ms) for `feishu_send_message`. Defaults to 30000. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  send: z.boolean().default(true),
  timeoutMs: z.number().default(DEFAULT_FEISHU_TOOL_TIMEOUT_MS),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** Format the send result as model-facing text. */
function formatSendOutput(result: { messageId: string }): string {
  return `Message sent. Feishu message ID: ${result.messageId}`
}

/** Register the Feishu tool and its system-prompt guidance. */
function applyFeishuSendTool(ctx: Context, timeoutMs: number): void {
  ctx.systemPrompt.section({
    name: 'tool:feishu_send_message',
    order: 420,
    text: 'Use the feishu_send_message tool to send messages through Feishu (飞书) chat. Provide the recipient\'s open_id, user_id, or chat_id, and the message content. Use this to notify users, report results, or communicate with team members.',
  })

  ctx.tools.register(defineTool({
    name: 'feishu_send_message',
    description: 'Send a message through Feishu (飞书) chat. Requires a valid recipient id (open_id, user_id, or chat_id) and the message content.',
    parameters: {
      receiveId: { type: 'string', required: true, description: 'The recipient id: open_id, user_id, union_id, email, or chat_id.' },
      content: { type: 'string', required: true, description: 'The plain text message content to send.' },
      receiveIdType: { type: 'string', enum: [...FEISHU_RECEIVE_ID_TYPES], description: 'The recipient id type. Defaults to open_id.' },
      msgType: { type: 'string', enum: [...FEISHU_MSG_TYPES], description: 'Message type. Defaults to text.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatSendOutput(value) }],
    },
    timeoutMs,
    // Network sends are independent of parent-agent state.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.receiveId.trim().length === 0) throw new Error('receiveId must be a non-empty string')
      if (args.content.trim().length === 0) throw new Error('content must be a non-empty string')
      const result = await ctx.feishu.sendMessage(
        {
          receiveId: args.receiveId,
          content: args.content,
          ...args.receiveIdType !== undefined ? { receiveIdType: args.receiveIdType } : {},
          ...args.msgType !== undefined ? { msgType: args.msgType } : {},
        },
        exec.signal,
      )
      return { messageId: result.messageId }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Send to ${args.receiveId}`,
      kind: 'other',
      rawInput: args.content,
    }),
    presentResult: (args, result) => {
      if (result.isError) return undefined
      return {
        card: 'generic',
        kind: 'other',
        title: `Sent to ${args.receiveId}`,
      }
    },
  }))
}

/**
 * Register the enabled Feishu tools. `send` defaults to true. The tool's
 * cooperative timeout budget (`timeoutMs`, default 30000) is resolved here and
 * attached to the tool as `ToolDefinition.timeoutMs` for
 * `@deepseek-ai/dsh-tool-call-timeout-policy` to enforce.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  if (resolved.send) {
    applyFeishuSendTool(ctx, resolved.timeoutMs)
  }
}
