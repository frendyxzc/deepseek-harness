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
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { FeishuError } from '@deepseek-ai/dsh-feishu'
import type { FeishuReceiveEvent, FeishuReceiveIdType } from '@deepseek-ai/dsh-feishu'
import type {} from '@deepseek-ai/dsh-feishu'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tdai-memory'
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

/** Resolved reply target: where a reply to one inbound event must be sent. */
interface ReplyTarget {
  readonly receiveId: string
  readonly receiveIdType: FeishuReceiveIdType
}

/**
 * Resolve where to reply to an inbound event. Feishu accepts `chat_id` only for
 * group chats; a one-on-one (p2p) message must be replied to with the sender's
 * id (`open_id` by default), otherwise the send fails with `invalid receive_id`.
 * @param event - the inbound message event.
 * @returns the reply target for this event.
 */
function resolveReplyTarget(event: FeishuReceiveEvent): ReplyTarget {
  if (event.chatType === 'p2p' && event.senderId.length > 0) {
    return { receiveId: event.senderId, receiveIdType: event.senderIdType }
  }
  return { receiveId: event.chatId, receiveIdType: 'chat_id' }
}

/** Prefix marking content resolved from a quoted / replied-to message. */
const REFERENCED_LABEL = '[引用消息]'

/** Feishu client placeholder shown when a message's content needs a newer client than the reader has. */
const UNSUPPORTED_CONTENT_PLACEHOLDER = '请升级至最新版本客户端，以查看内容'

/** One image to download and attach, scoped to its owning message id. */
interface DownloadImage {
  readonly messageId: string
  readonly fileKey: string
}

/** Result of resolving the message an inbound event references. */
interface ReferencedResolution {
  /** Label-wrapped plain text of the referenced message, or '' when there is none. */
  readonly text: string
  /** Images in the referenced message, scoped to the referenced message id. */
  readonly images: readonly DownloadImage[]
}

/**
 * Remove Feishu's client-version placeholder from extracted text. The real
 * content is an image (or a newer format): once the image is attached, the
 * placeholder would be misleading, so only the image marker remains.
 * @param text - the extracted text that may carry the placeholder.
 * @returns the text without the placeholder.
 */
function stripUnsupportedPlaceholder(text: string): string {
  if (!text.includes(UNSUPPORTED_CONTENT_PLACEHOLDER)) return text
  return text.split(UNSUPPORTED_CONTENT_PLACEHOLDER).join('').trim()
}

/** Sniff one downloaded image's raster format from its magic bytes. */
function sniffImageMediaType(data: Uint8Array): ImageMediaType | undefined {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data.length >= 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'image/gif'
  return undefined
}

/**
 * Download and durably attach the given message images, returning their
 * model-facing image blocks. A deleted or unrecognized image is skipped and
 * logged — reading an image must never block message delivery, and a text-only
 * fallback still names the image marker from the extracted content.
 * @param ctx - the plugin context supplying the Feishu seam and attachment store.
 * @param images - images to fetch, each scoped to its owning message id.
 * @returns image blocks in input order for every successfully attached image.
 */
async function collectImageBlocks(ctx: Context, images: readonly DownloadImage[]): Promise<ContentBlock[]> {
  if (images.length === 0) return []
  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    ctx.logger.warn('feishu-receive: cannot attach images — no attachments service is mounted')
    return []
  }
  const blocks: ContentBlock[] = []
  for (const image of images) {
    try {
      const resource = await ctx.feishu.getMessageResource(image.messageId, image.fileKey)
      const mediaType = sniffImageMediaType(resource.data)
      if (mediaType === undefined) {
        ctx.logger.warn('feishu-receive: image %s has an unrecognized format; skipped', image.fileKey)
        continue
      }
      const ref = await attachments.saveImage({ data: resource.data, mediaType })
      blocks.push({ type: 'image', attachment: ref })
    } catch (error: unknown) {
      // A provider without getMessageResource is a capability gap, not a failure.
      if (error instanceof FeishuError && error.code === 'FEISHU_RESOURCE_UNSUPPORTED') continue
      ctx.logger.warn('feishu-receive: failed to read image %s from message %s: %s', image.fileKey, image.messageId, String(error))
    }
  }
  return blocks
}

/**
 * Resolve the message an inbound event references (its quoted / replied-to
 * parent) into readable text and its images, so the agent sees the full context
 * rather than just the reply. Returns empty text and no images when there is no
 * reference, the provider cannot read messages, or the referenced message has no
 * readable content; a fetch failure is logged and never blocks delivery.
 * @param ctx - the plugin context, supplying the Feishu seam and logger.
 * @param event - the inbound message event.
 * @returns the resolved referenced text and images.
 */
async function resolveReferencedContent(ctx: Context, event: FeishuReceiveEvent): Promise<ReferencedResolution> {
  const referencedId = event.parentId ?? event.rootId
  if (referencedId === undefined || referencedId.length === 0) return { text: '', images: [] }
  try {
    const message = await ctx.feishu.getMessage(referencedId)
    const rawContent = message.content.trim()
    // console, not ctx.logger: the default logger buffers in memory, so the
    // read outcome must print here to be visible in dsh-web.log. Record the
    // fetched type and content length so an empty extraction is distinguishable
    // from a resolved reference.
    console.log(`feishu-receive: referenced ${referencedId} → msgType=${message.msgType} contentLen=${rawContent.length}`)
    if (rawContent.includes(UNSUPPORTED_CONTENT_PLACEHOLDER)) {
      // The referenced message resolved to Feishu's "client too old" placeholder;
      // dump the raw get-message item's msg_type and body.content so the
      // underlying type (media / merge_forward) remains identifiable even now
      // that the message's image keys are extracted and attached.
      const item = message.raw as { msg_type?: unknown; body?: { content?: unknown } } | null | undefined
      const rawMsgType = item !== null && item !== undefined && typeof item.msg_type === 'string' ? item.msg_type : ''
      const rawContentItem = item !== null && item !== undefined ? item.body?.content : undefined
      const renderedContent = typeof rawContentItem === 'string' ? rawContentItem : JSON.stringify(rawContentItem ?? null)
      console.log(
        `feishu-receive: referenced ${referencedId} placeholder → msg_type=${rawMsgType} body.content=${renderedContent}`,
      )
    }
    const content = stripUnsupportedPlaceholder(rawContent)
    const images = (message.images ?? []).map(image => ({ messageId: message.messageId, fileKey: image.fileKey }))
    if (content.length === 0 && images.length === 0) return { text: '', images: [] }
    return {
      text: content.length === 0 ? '' : `${REFERENCED_LABEL}\n${content}`,
      images,
    }
  } catch (error: unknown) {
    // A provider without getMessage is a capability gap, not a delivery
    // failure; any other failure is logged but must not block the reply.
    if (!(error instanceof FeishuError && error.code === 'FEISHU_GET_UNSUPPORTED')) {
      ctx.logger.warn('feishu-receive: failed to read referenced message %s: %s', referencedId, String(error))
    }
    console.log(`feishu-receive: referenced ${referencedId} read failed: ${String(error)}`)
    return { text: '', images: [] }
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

  const getOrCreate = (chatId: string, providerId: string | undefined, reply: ReplyTarget): Promise<AgentHandle> => {
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
    // Pin the session to the bot that received it so the LLM adapters resolve
    // this chat's per-bot team/agent identity on every request.
    if (providerId !== undefined && providerId.length > 0) {
      ctx.get('tdaiMemory')?.bindSession(String(sessionId), providerId)
    }

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
        text: `You are responding inside a Feishu (飞书) chat. The user's messages arrive from this chat, and your text responses are NOT visible to the user. To reply, you MUST call the feishu_send_message tool with receiveId set to "${reply.receiveId}", receiveIdType set to "${reply.receiveIdType}", and content set to your reply text. Without calling this tool, the user will not receive your response.`,
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
        if (ctx.feishu.listProviders().length === 0) return false
        disposeReceive = ctx.feishu.startReceivingAll((event) => {
          const chatId = event.chatId
          if (chatId.length === 0) {
            ctx.logger.warn('feishu-receive: event without a chat id; dropped')
            return
          }
          const reply = resolveReplyTarget(event)
          void (async () => {
            // Immediate feedback before the agent starts: the acknowledgement
            // is awaited so it lands ahead of any reply, and a failure only
            // logs — delivery must never depend on it.
            if (resolved.ack) {
              try {
                await ctx.feishu.sendMessage({ receiveId: reply.receiveId, receiveIdType: reply.receiveIdType, content: ACK_MESSAGE })
              } catch (error: unknown) {
                ctx.logger.warn('feishu-receive: failed to acknowledge chat %s: %s', chatId, String(error))
              }
            }
            const handle = await getOrCreate(chatId, event.providerId, reply)
            created.add(handle)
            const referenced = await resolveReferencedContent(ctx, event)
            const text = referenced.text.length > 0 ? `${referenced.text}\n\n${event.content}` : event.content
            const eventMessageId = event.messageId
            const eventImages: DownloadImage[] = eventMessageId !== undefined && event.images !== undefined
              ? event.images.map(image => ({ messageId: eventMessageId, fileKey: image.fileKey }))
              : []
            const imageBlocks = await collectImageBlocks(ctx, [...eventImages, ...referenced.images])
            // console, not ctx.logger: the default logger buffers in memory and is not
            // exported to the process log, so the delivery diagnostic must print here
            // to be visible in dsh-web.log. parent/root show whether the inbound event
            // carried a quoted / replied-to reference at all, so an absent `[引用消息]`
            // can be attributed to a missing reference rather than a failed read; the
            // delivered length replaces the raw payload so the line stays concise.
            console.log(
              `feishu-receive: ${summarizeRawMessage(event.raw)} parent=${event.parentId ?? '-'} `
              + `root=${event.rootId ?? '-'} → deliveredLen=${text.length} images=${imageBlocks.length}`,
            )
            const content: ContentBlock[] = []
            if (text.length > 0) content.push({ type: 'text', text })
            content.push(...imageBlocks)
            handle.agent.followup(createUserMessage({
              content,
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
