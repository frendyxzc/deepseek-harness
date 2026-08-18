/**
 * `@deepseek-ai/dsh-feishu-receive`: a consumer plugin that routes each Feishu
 * chat into its own agent session. It starts the seam's long-connection receive
 * channel and, on the first message from a `chatId`, lazily creates a dedicated
 * root agent running the live session's preset, then delivers every message from
 * that chat to that agent. The chat → session pin is cached in memory for the
 * plugin's lifetime, so the same chat reuses one conversation; each session id
 * is a fresh UUID, so a restart never collides with a persisted log and simply
 * starts each chat anew.
 *
 * @module @deepseek-ai/dsh-feishu-receive
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-feishu'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'

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
}

export const Config: z<Config> = z.object({
  cwd: z.string(),
})

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
    })

    // Cache the in-flight creation so messages from the same chat arriving before
    // setup settles do not mint duplicate agents. Drop the entry on failure so a
    // later message retries.
    handles.set(chatId, creating)
    creating.catch(() => { handles.delete(chatId) })
    return creating
  }

  ctx.effect(() => {
    const disposeReceive = ctx.feishu.startReceiving((event) => {
      const chatId = event.chatId
      if (chatId.length === 0) {
        ctx.logger.warn('feishu-receive: event without a chat id; dropped')
        return
      }
      void getOrCreate(chatId).then((handle) => {
        created.add(handle)
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: event.content }],
          source: { kind: 'user' },
        }))
        ctx.logger.info('feishu-receive: delivered a message to agent %s (chat %s)', handle.agent.id, chatId)
      }, (error: unknown) => {
        ctx.logger.error('feishu-receive: failed to create the per-chat agent for chat %s: %s', chatId, String(error))
      })
    })
    return () => {
      disposeReceive()
      for (const handle of created) void handle.dispose()
    }
  }, 'feishu-receive.startReceiving()')
}
