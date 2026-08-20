/**
 * Model-facing `feishu_send_message` and `feishu_update_message` tools over
 * `ctx.feishu`. This package owns the tool schemas, validation, prompt
 * guidance, and presentation, never concrete providers.
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

/** Plugin config: whether to register the tools and their timeout budget. */
export interface Config {
  /** Register `feishu_send_message`. Defaults to true. */
  send?: boolean
  /** Register `feishu_update_message`. Defaults to true. */
  update?: boolean
  /** Cooperative timeout budget (ms) for the Feishu tools. Defaults to 30000. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  send: z.boolean().default(true),
  update: z.boolean().default(true),
  timeoutMs: z.number().default(DEFAULT_FEISHU_TOOL_TIMEOUT_MS),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** Format the send result as model-facing text. */
function formatSendOutput(result: { messageId: string }): string {
  return `Message sent. Feishu message ID: ${result.messageId}`
}

/** Format the update result as model-facing text. */
function formatUpdateOutput(result: { messageId: string }): string {
  return `Message updated. Feishu message ID: ${result.messageId}`
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

/** Register the Feishu update-message tool and its system-prompt guidance. */
function applyFeishuUpdateTool(ctx: Context, timeoutMs: number): void {
  ctx.systemPrompt.section({
    name: 'tool:feishu_update_message',
    order: 421,
    text: 'Use the feishu_update_message tool to replace the content of a Feishu (飞书) message you sent earlier, identified by its message id. Prefer updating the original message over sending a new one when revising or correcting a previous reply — the user keeps one conversation thread instead of duplicates. Interactive card messages can also be replaced this way.',
  })

  ctx.tools.register(defineTool({
    name: 'feishu_update_message',
    description: 'Update the content of a Feishu (飞书) message sent earlier. Requires the message id returned by feishu_send_message and the replacement content.',
    parameters: {
      messageId: { type: 'string', required: true, description: 'The Feishu message id of the message to update, as returned by feishu_send_message.' },
      content: { type: 'string', required: true, description: 'The replacement content; same encoding as the message being replaced (plain text for text messages, a card JSON string for interactive ones).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatUpdateOutput(value) }],
    },
    timeoutMs,
    // Network sends are independent of parent-agent state.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.messageId.trim().length === 0) throw new Error('messageId must be a non-empty string')
      if (args.content.trim().length === 0) throw new Error('content must be a non-empty string')
      await ctx.feishu.updateMessage(args.messageId, args.content, exec.signal)
      return { messageId: args.messageId }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Update message ${args.messageId}`,
      kind: 'other',
      rawInput: args.content,
    }),
    presentResult: (args, result) => {
      if (result.isError) return undefined
      return {
        card: 'generic',
        kind: 'other',
        title: `Updated message ${args.messageId}`,
      }
    },
  }))
}

/**
 * Register the enabled Feishu tools. `send` and `update` default to true. Each
 * tool's cooperative timeout budget (`timeoutMs`, default 30000) is resolved
 * here and attached to the tool as `ToolDefinition.timeoutMs` for
 * `@deepseek-ai/dsh-tool-call-timeout-policy` to enforce.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  if (resolved.send) {
    applyFeishuSendTool(ctx, resolved.timeoutMs)
  }
  if (resolved.update) {
    applyFeishuUpdateTool(ctx, resolved.timeoutMs)
  }
}
