/**
 * `@deepseek-ai/dsh-feishu-receive`: a consumer plugin that routes each Feishu
 * chat into its own agent session. It starts the seam's long-connection receive
 * channel and, on the first message from a `chatId`, lazily creates a dedicated
 * root agent running the live session's preset, then delivers every message from
 * that chat to that agent. The chat → session pin is cached in memory for the
 * plugin's lifetime, so the same chat reuses one conversation; each session id
 * is a fresh UUID, so a restart never collides with a persisted log and simply
 * starts each chat anew. Each published per-chat agent is announced with the
 * `feishu/chat-agent` event so other Feishu consumers (e.g. the approval-card
 * answerer) can bind to it without re-deriving the routing.
 *
 * @module @deepseek-ai/dsh-feishu-receive
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { FeishuError } from '@deepseek-ai/dsh-feishu'
import type { FeishuReceiveEvent } from '@deepseek-ai/dsh-feishu'
import type {} from '@deepseek-ai/dsh-feishu'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A per-chat agent was published for one Feishu chat: the routing pin is
     * live and every message from that chat now reaches this agent. Emitted
     * once per chat per process, after `agent/created`, by
     * `@deepseek-ai/dsh-feishu-receive`; consumers that need the chat ↔ agent
     * binding (approval cards, per-chat surfaces) subscribe here instead of
     * re-deriving the routing.
     * @param payload.agent - the published per-chat agent.
     * @param payload.chatId - the Feishu chat whose messages this agent serves.
     * @mode emit
     */
    'feishu/chat-agent'(payload: { agent: Agent; chatId: string }): void
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'feishu-receive'

/**
 * Services required by the Feishu receive consumer: the Feishu seam to receive
 * from, the agent registry to create and deliver to each per-chat agent, the
 * preset roster to assemble those agents with the same world as the live
 * session, and the system-prompt service to register per-chat reply guidance.
 */
export const inject = ['feishu', 'agents', 'agentPresets', 'systemPrompt']

/** Plugin config: the working directory used when no live root agent is available to inherit one from. */
export interface Config {
  /**
   * Fallback working directory for per-chat agents when the live root session
   * has no cwd (or no root agent exists yet). Without this, the first
   * message from any chat is rejected until a live root with a cwd appears.
   */
  cwd?: string
  /**
   * Reply to every incoming chat message with a short acknowledgement before
   * the per-chat agent starts working, so the user gets immediate feedback
   * that the message arrived. Defaults to true; a failed acknowledgement is
   * logged and never blocks delivery.
   */
  ack?: boolean
}

export const Config: z<Config> = z.object({
  cwd: z.string(),
  ack: z.boolean().default(true),
})

/** Config after schemastery applies field defaults. */
interface ResolvedConfig extends Config {
  ack: boolean
}

/** The acknowledgement text sent back to the chat before the agent starts. */
const ACK_MESSAGE = '已收到，正在处理…'

/** Prefix marking content resolved from a quoted / replied-to message. */
const REFERENCED_LABEL = '[引用消息]'

/**
 * Resolve the message an inbound event references (its quoted / replied-to
 * parent) into readable text, so the agent sees the full context rather than
 * just the reply. Returns '' when there is no reference, the provider cannot
 * read messages, or the referenced message has no readable content; a fetch
 * failure is logged and never blocks delivery.
 * @param ctx - the plugin context, supplying the Feishu seam and logger.
 * @param event - the inbound message event.
 * @returns the label-wrapped referenced content, or ''.
 */
async function resolveReferencedContent(ctx: Context, event: FeishuReceiveEvent): Promise<string> {
  const referencedId = event.parentId ?? event.rootId
  if (referencedId === undefined || referencedId.length === 0) return ''
  try {
    const message = await ctx.feishu.getMessage(referencedId)
    const content = message.content.trim()
    // console, not ctx.logger: the default logger buffers in memory, so the
    // read outcome must print here to be visible in dsh-web.log. Record the
    // fetched type and content length so an empty extraction is distinguishable
    // from a resolved reference.
    console.log(`feishu-receive: referenced ${referencedId} → msgType=${message.msgType} contentLen=${content.length}`)
    if (content.length === 0) return ''
    return `${REFERENCED_LABEL}\n${content}`
  } catch (error: unknown) {
    // A provider without getMessage is a capability gap, not a delivery
    // failure; any other failure is logged but must not block the reply.
    if (!(error instanceof FeishuError && error.code === 'FEISHU_GET_UNSUPPORTED')) {
      ctx.logger.warn('feishu-receive: failed to read referenced message %s: %s', referencedId, String(error))
    }
    console.log(`feishu-receive: referenced ${referencedId} read failed: ${String(error)}`)
    return ''
  }
}

/**
 * Summarize an inbound event's raw payload for diagnostics: the source message
 * type (text / post / interactive) and its raw `content` length, before any
 * text extraction. The length — not the raw content itself — keeps the
 * delivery log readable while still distinguishing a rich payload from an
 * empty one.
 * @param raw - the raw receive event payload.
 * @returns a single-line `msgType=… contentLen=…` summary.
 */
function summarizeRawMessage(raw: unknown): string {
  const inner = raw as { message?: Record<string, unknown> } | null | undefined
  const rawMsgType = inner?.message?.message_type ?? inner?.message?.msg_type
  const msgType = typeof rawMsgType === 'string' ? rawMsgType : '?'
  const content = typeof inner?.message?.content === 'string' ? inner.message.content : ''
  return `msgType=${msgType} contentLen=${content.length}`
}

/**
 * Prefix of each per-chat agent's session id. The suffix is a fresh UUID so a
 * restart never collides with a previous run's persisted log — the chat →
 * session pin lives in the in-memory map, not in the session id, so the same
 * chat keeps one agent per process without any cross-restart resume contract.
 */
const SESSION_ID_PREFIX = 'feishu-'

/**
 * Start receiving Feishu messages and route each chat to its own agent session.
 * The first message from a chat creates that chat's agent; later messages reuse
 * it. Every created agent is disposed together with this plugin's fiber.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = config as ResolvedConfig
  const handles = new Map<string, Promise<AgentHandle>>()
  const created = new Set<AgentHandle>()
  let presetId: string | undefined
  let agentOptions: AgentOptions | undefined
  let cwd: string | undefined
  let templateResolved = false

  // Capture the live session's template once, before any per-chat agent exists:
  // its preset (tools/persona) plus the model route and cwd the loop's `{{model}}`,
  // `{{provider}}`, and `{{cwd}}` prompt variables read back, so each chat agent
  // assembles against values that exist.
  //
  // The cwd is required so `{{cwd}}` resolves and each chat agent inherits the
  // live session's working directory; a session without one would persist under
  // `_no-cwd/`. The live root's cwd is preferred; `config.cwd` is the fallback
  // for when no root agent exists yet.
  const resolveTemplate = (): { presetId: string; agentOptions?: AgentOptions; cwd: string } => {
    if (!templateResolved) {
      const root = ctx.agents.roots()[0]
      presetId = root === undefined
        ? ctx.agentPresets.defaultId
        : (ctx.agentPresets.composedPreset(root.ctx) ?? ctx.agentPresets.defaultId)
      agentOptions = root === undefined ? undefined : { ...root.options }
      cwd = root?.session.header.cwd ?? config.cwd
      if (cwd === undefined) {
        throw new Error(
          'feishu-receive: no working directory — the live session has no cwd '
          + 'and no fallback `cwd` is configured. Either start the receive '
          + 'channel after the live root session has a cwd, or set `cwd` in the '
          + 'feishu-receive plugin config in cordis.patch.yml.',
        )
      }
      // Only cache once every field — including the required cwd — resolves.
      // An earlier failure must retry on the next message so a live root that
      // arrives after the first message is picked up.
      templateResolved = true
    }
    return {
      presetId: presetId as string,
      ...(agentOptions === undefined ? {} : { agentOptions }),
      cwd: cwd as string,
    }
  }

  const getOrCreate = (chatId: string): Promise<AgentHandle> => {
    const existing = handles.get(chatId)
    if (existing !== undefined) return existing
    let template: { presetId: string; agentOptions?: AgentOptions; cwd: string }
    try {
      template = resolveTemplate()
    } catch (error: unknown) {
      // Preserve resolveTemplate's exact failure value; the caller owns this
      // rejection and inspects it, and the template closure may throw
      // arbitrary values.
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors
      return Promise.reject(error)
    }
    const { presetId: preset, agentOptions: options, cwd: workingDir } = template
    const sessionId = SessionId(`${SESSION_ID_PREFIX}${randomUUID()}`)

    const setup = async (agentCtx: Context): Promise<void> => {
      await ctx.agentPresets.mount(agentCtx, preset)
      // Register a per-chat system-prompt context so the agent knows its
      // Feishu chat id and that text responses are invisible to the user
      // unless sent through feishu_send_message. Without this, the agent
      // answers only in the session log and the user never sees the reply.
      // Order 130: after sandbox:policy (110) and approval:policy (115),
      // before tool-specific sections (420).
      agentCtx.systemPrompt.context({
        name: 'feishu:chat-context',
        order: 130,
        text: `You are responding inside a Feishu (飞书) chat. The user's messages arrive from this chat, and your text responses are NOT visible to the user. To reply, you MUST call the feishu_send_message tool with receiveId set to "${chatId}", receiveIdType set to "chat_id", and content set to your reply text. Without calling this tool, the user will not receive your response.`,
      })
    }

    const creating = ctx.agents.create({
      sessionId,
      meta: {
        agentPreset: preset,
        cwd: workingDir,
      },
      ...(options === undefined ? {} : { agentOptions: options }),
      setup,
    }).then((handle) => {
      // Announce the live binding once the agent is published; approval and
      // other per-chat consumers subscribe here instead of re-deriving it.
      ctx.emit('feishu/chat-agent', { agent: handle.agent, chatId })
      return handle
    })

    // Cache the in-flight creation so messages from the same chat arriving before
    // setup settles do not mint duplicate agents. Drop the entry on failure so a
    // later message retries.
    handles.set(chatId, creating)
    creating.catch(() => { handles.delete(chatId) })
    return creating
  }

  ctx.effect(() => {
    // Sibling entry fibers load in parallel, so a provider plugin may still
    // be activating when this effect runs; the seam's registration events
    // open the channel then instead of failing the boot over load order.
    let disposeReceive: (() => void) | undefined
    /** Whether the channel waits for a usable provider to register. */
    let waitingForProvider = false

    /** Open the receive channel; false when no usable provider is registered yet. */
    const openReceiveChannel = (): boolean => {
      try {
        disposeReceive = ctx.feishu.startReceiving((event) => {
          const chatId = event.chatId
          if (chatId.length === 0) {
            ctx.logger.warn('feishu-receive: event without a chat id; dropped')
            return
          }
          void (async () => {
            // Immediate feedback before the agent starts: the acknowledgement
            // is awaited so it lands ahead of any reply, and a failure only
            // logs — delivery must never depend on it.
            if (resolved.ack) {
              try {
                await ctx.feishu.sendMessage({ receiveId: chatId, receiveIdType: 'chat_id', content: ACK_MESSAGE })
              } catch (error: unknown) {
                ctx.logger.warn('feishu-receive: failed to acknowledge chat %s: %s', chatId, String(error))
              }
            }
            const handle = await getOrCreate(chatId)
            created.add(handle)
            const referenced = await resolveReferencedContent(ctx, event)
            const text = referenced.length > 0 ? `${referenced}\n\n${event.content}` : event.content
            // console, not ctx.logger: the default logger buffers in memory and is not
            // exported to the process log, so the delivery diagnostic must print here
            // to be visible in dsh-web.log. parent/root show whether the inbound event
            // carried a quoted / replied-to reference at all, so an absent `[引用消息]`
            // can be attributed to a missing reference rather than a failed read; the
            // delivered length replaces the raw payload so the line stays concise.
            console.log(
              `feishu-receive: ${summarizeRawMessage(event.raw)} parent=${event.parentId ?? '-'} `
              + `root=${event.rootId ?? '-'} → deliveredLen=${text.length}`,
            )
            handle.agent.followup(createUserMessage({
              content: [{ type: 'text', text }],
              source: { kind: 'user' },
            }))
            ctx.logger.info('feishu-receive: delivered a message to agent %s (chat %s)', handle.agent.id, chatId)
          })().catch((error: unknown) => {
            ctx.logger.error('feishu-receive: failed to create the per-chat agent for chat %s: %s', chatId, String(error))
          })
        })
        return true
      } catch (error: unknown) {
        // Not registered (yet) — a provider fiber may still be loading.
        if (error instanceof FeishuError
          && (error.code === 'FEISHU_PROVIDER_UNAVAILABLE' || error.code === 'FEISHU_PROVIDER_CONFIGURED_MISSING')) {
          return false
        }
        throw error
      }
    }
    const closeReceiveChannel = (): void => {
      disposeReceive?.()
      disposeReceive = undefined
    }

    waitingForProvider = !openReceiveChannel()
    if (waitingForProvider) {
      ctx.logger.warn('feishu-receive: no usable Feishu provider is registered yet; the receive channel opens when one registers')
    }

    const offProviderAdded = ctx.on('feishu/provider-added', () => {
      if (!waitingForProvider) return
      // A registered provider that cannot receive is a real misconfiguration:
      // the throw unwinds the provider's registration and fails its fiber
      // loudly.
      waitingForProvider = !openReceiveChannel()
    })
    const offProviderRemoved = ctx.on('feishu/provider-removed', () => {
      if (waitingForProvider) return
      // The channel's provider is gone: re-open on a remaining provider, or
      // wait for the next registration. This path never throws — a teardown
      // reaction must not fail the unloading fiber.
      closeReceiveChannel()
      try {
        waitingForProvider = !openReceiveChannel()
      } catch (error: unknown) {
        waitingForProvider = true
        ctx.logger.warn('feishu-receive: receive channel closed and cannot reopen: %s', String(error))
      }
    })

    return () => {
      closeReceiveChannel()
      offProviderAdded()
      offProviderRemoved()
      for (const handle of created) void handle.dispose()
    }
  }, 'feishu-receive.startReceiving()')
}
