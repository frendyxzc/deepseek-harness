/**
 * `@deepseek-ai/dsh-feishu-approval`: the approval-card answerer for Feishu
 * chat agents. When a tool call in an agent bound to a Feishu chat — a
 * per-chat agent announced by `@deepseek-ai/dsh-feishu-receive`, or a
 * subagent descendant of one — raises an approval request, this plugin sends
 * an interactive Allow/Deny card to the owning chat and settles the
 * `approval/request` waterfall from the tapped button. One-time nonces
 * guarantee one card settles at most one approval exactly once, and every
 * path that does not produce an explicit Allow — a Deny tap, an unanswered
 * timeout, a withdrawn turn, an undeliverable card — fails closed.
 *
 * @module @deepseek-ai/dsh-feishu-approval
 */

import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-feishu'
import type { FeishuCardActionEvent } from '@deepseek-ai/dsh-feishu'
import type {} from '@deepseek-ai/dsh-feishu-receive'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'feishu-approval'

/**
 * Services required by the Feishu approval answerer: the Feishu seam to send
 * and settle cards and receive card actions, and the approval service whose
 * `approval/request` waterfall this plugin answers.
 */
export const inject = ['feishu', 'approval']

/** Default fail-closed wait budget (ms) for one approval card. */
export const DEFAULT_FEISHU_APPROVAL_TIMEOUT_MS = 60_000

/** Plugin config. */
export interface Config {
  /**
   * How long (ms) one approval card waits for a tap before it is denied
   * automatically. Defaults to 60000; must be a positive finite number.
   */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  timeoutMs: z.number().default(DEFAULT_FEISHU_APPROVAL_TIMEOUT_MS),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/**
 * Cap on live approval cards. Exceeding it settles the OLDEST card as an
 * explicit deny, so a runaway approval storm cannot grow memory without
 * bound and no card ever lingers past its own budget.
 */
const MAX_PENDING_CARDS = 256

/** A user-facing reason is capped before it is embedded in card markup. */
const MAX_REASON_CHARS = 2000

/** The button-action discriminator carried by the Allow button's value. */
const ALLOW_ACTION = 'allow'
/** The button-action discriminator carried by the Deny button's value. */
const DENY_ACTION = 'deny'

/** One delivered approval card and the decision it is waiting for. */
interface PendingCard {
  /** The nonce minted for the Allow button; also the entry's allow marker. */
  readonly allowNonce: string
  /** The nonce minted for the Deny button. */
  readonly denyNonce: string
  /** The Feishu chat the card was sent to; taps from other chats are rejected. */
  readonly chatId: string
  /** The session whose tool call the card decides; embedded in both buttons. */
  readonly sessionId: string
  /** The card message id once delivery succeeds; unset before then. */
  messageId: string | undefined
  /** Resolves the waterfall promise; assigned before the card is armed. */
  settle: ((outcome: ApprovalOutcome) => void) | undefined
  /** The timeout that denies an unanswered card. */
  timer: ReturnType<typeof setTimeout> | undefined
  /** The abort listener that withdraws a card with its turn. */
  onAbort: (() => void) | undefined
  /** The request signal the abort listener is attached to, when any. */
  signal: AbortSignal | undefined
  /** Settled cards are inert: later taps, timers, and aborts are no-ops. */
  settled: boolean
}

/**
 * Answer Feishu chat agents' approval requests with interactive cards. The
 * plugin fails loud at load when the selected Feishu provider cannot receive
 * card actions — answering is impossible without the tap channel.
 * @param ctx - Cordis context carrying the injected services.
 * @param config - plugin config; `timeoutMs` defaults to 60000.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  const timeoutMs = resolved.timeoutMs
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`feishu-approval: timeoutMs must be a positive number, got ${String(timeoutMs)}`)
  }

  /**
   * Chat bindings by session id. A chat session is bound by its
   * `feishu/chat-agent` announcement; a descendant session (subagent) is
   * bound through its `parentSession` at creation, so the whole delegation
   * tree under one chat answers in that chat. Bindings are released with
   * their agent.
   */
  const chatBySession = new Map<SessionId, string>()
  /** Live cards by either button nonce. */
  const nonceToCard = new Map<string, PendingCard>()
  /** Live cards in mint order (oldest first) for the eviction cap. */
  const pendingCards = new Set<PendingCard>()

  /** The Feishu chat an approval request belongs to, when one is bound. */
  const resolveChat = (agent: Agent): string | undefined => chatBySession.get(agent.session.id)

  /** Mint a one-time nonce: enough entropy that guessing is not a channel. */
  const mintNonce = (): string => randomBytes(12).toString('base64url')

  /**
   * Settle one card: resolve its approval exactly once, retire both nonces,
   * stop its timer and abort listener, and repaint the card with the outcome
   * on a best-effort basis — a failed repaint never reopens the decision.
   */
  const settleCard = (card: PendingCard, outcome: ApprovalOutcome, note: string): void => {
    if (card.settled) return
    card.settled = true
    nonceToCard.delete(card.allowNonce)
    nonceToCard.delete(card.denyNonce)
    pendingCards.delete(card)
    if (card.timer !== undefined) clearTimeout(card.timer)
    if (card.onAbort !== undefined) card.signal?.removeEventListener('abort', card.onAbort)
    card.settle?.(outcome)
    if (card.messageId !== undefined) {
      void ctx.feishu.updateMessage(card.messageId, noteCard(note)).catch((error: unknown) => {
        ctx.logger.warn('feishu-approval: settling card %s failed: %s', card.messageId, String(error))
      })
    }
  }

  /**
   * Handle one card button tap. Settles synchronously — Feishu expects the
   * callback acknowledged promptly — and validates the tap against the
   * nonce's own record BEFORE consuming it: the card `value` is
   * attacker-controllable, so a forged action, a tampered session id, a tap
   * from another chat, or a replayed nonce is rejected WITHOUT consuming the
   * nonce, leaving a later legitimate tap intact.
   */
  const onCardAction = (event: FeishuCardActionEvent): void => {
    const value = event.value
    const nonce = tappedNonce(value)
    const card = nonce !== undefined ? nonceToCard.get(nonce) : undefined
    if (nonce === undefined || card === undefined) {
      // Missing or already-consumed nonce: a stale or duplicate tap. This is
      // the one-time-use guarantee — a second click is inert.
      return
    }
    const record = value as Record<string, unknown>
    const expectedAction = nonce === card.allowNonce ? ALLOW_ACTION : DENY_ACTION
    if (record.action !== expectedAction || record.session_id !== card.sessionId || event.chatId !== card.chatId) {
      ctx.logger.warn('feishu-approval: rejecting a card action that does not match its nonce record (chat %s)', event.chatId)
      return
    }
    const operator = event.operatorId.length > 0 ? event.operatorId : 'an unknown operator'
    settleCard(
      card,
      expectedAction === ALLOW_ACTION ? 'allowed-once' : 'rejected',
      expectedAction === ALLOW_ACTION ? `✅ Allowed by ${operator}` : `❌ Denied by ${operator}`,
    )
  }

  ctx.effect(() => {
    // The tap channel is the feature's precondition: a provider that cannot
    // receive card actions fails loud here, at load, not at the first ask.
    const disposeCardReceive = ctx.feishu.startReceivingCardActions(onCardAction)

    const offChatAgent = ctx.on('feishu/chat-agent', ({ agent, chatId }) => {
      chatBySession.set(agent.session.id, chatId)
    })
    const offCreated = ctx.on('agent/created', ({ agent }) => {
      const parent = agent.session.header.parentSession
      if (parent === undefined) return
      const chatId = chatBySession.get(parent)
      if (chatId !== undefined) chatBySession.set(agent.session.id, chatId)
    })
    const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
      chatBySession.delete(agent.session.id)
    })

    // Prepend so this answerer is consulted BEFORE any catch-all answerer
    // (the Web host answers every ask it can claim): owned requests are
    // claimed here; everything else delegates through next().
    const offApproval = ctx.on('approval/request', async (req, next) => {
      const chatId = resolveChat(req.agent)
      if (chatId === undefined) return next()
      if (req.signal?.aborted === true) return 'cancelled'
      // The live-card table is bounded: an ask beyond the cap delegates to
      // the next answerer instead of queueing unbounded state.
      if (pendingCards.size >= MAX_PENDING_CARDS) {
        ctx.logger.warn('feishu-approval: too many pending approval cards; delegating to the next answerer')
        return next()
      }

      const card: PendingCard = {
        allowNonce: mintNonce(),
        denyNonce: mintNonce(),
        chatId,
        sessionId: req.agent.session.id,
        messageId: undefined,
        settle: undefined,
        timer: undefined,
        onAbort: undefined,
        signal: req.signal,
        settled: false,
      }
      nonceToCard.set(card.allowNonce, card)
      nonceToCard.set(card.denyNonce, card)
      pendingCards.add(card)

      // The decision promise exists BEFORE the send: any settlement racing
      // the in-flight delivery (an abort, a teardown) still resolves the
      // promise this handler returns.
      const decision = new Promise<ApprovalOutcome>((resolvePromise) => {
        card.settle = resolvePromise
      })

      try {
        const sent = await ctx.feishu.sendMessage({
          receiveId: chatId,
          receiveIdType: 'chat_id',
          msgType: 'interactive',
          content: JSON.stringify(approvalCard(req, card)),
        }, req.signal)
        card.messageId = sent.messageId
      } catch (error: unknown) {
        // The card never reached the chat: retire it and delegate to the
        // next answerer rather than failing this ask closed ourselves.
        if (!card.settled) {
          card.settled = true
          nonceToCard.delete(card.allowNonce)
          nonceToCard.delete(card.denyNonce)
          pendingCards.delete(card)
        }
        ctx.logger.warn('feishu-approval: approval card delivery failed; delegating to the next answerer: %s', String(error))
        return next()
      }

      card.timer = setTimeout(() => {
        settleCard(card, 'rejected', '⏱️ Timed out — denied automatically.')
      }, timeoutMs)
      if (req.signal !== undefined) {
        card.onAbort = () => {
          settleCard(card, 'cancelled', 'Cancelled — the turn ended before a decision.')
        }
        req.signal.addEventListener('abort', card.onAbort, { once: true })
      }
      return decision
    }, { prepend: true })

    return () => {
      disposeCardReceive()
      offChatAgent()
      offCreated()
      offDisposed()
      offApproval()
      // Teardown parity with the Web host's approval registry: withdraw every
      // still-pending card as cancelled so no ask promise dangles past this
      // plugin's lifetime.
      for (const card of [...pendingCards]) settleCard(card, 'cancelled', 'Cancelled — the approval channel closed.')
    }
  }, 'feishu-approval.answerer')
}

/** A plain-object view for card values and tapped payloads. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Cap a user-facing reason before embedding it in card markup. */
function truncateReason(reason: string): string {
  return reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS)}…` : reason
}

/**
 * Build the interactive approval card for one request: the tool, the asker's
 * reason, and Allow/Deny buttons whose values carry one-time nonces bound to
 * this exact action + session. Pure function of the request and the minted
 * card record.
 * @param req - the approval request the card decides.
 * @param card - the minted record whose nonces bind both buttons.
 * @returns the Feishu interactive-card object.
 */
export function approvalCard(
  req: ApprovalRequest,
  card: { allowNonce: string; denyNonce: string; sessionId: string },
): Record<string, unknown> {
  const reasonLine = req.reason !== undefined && req.reason.length > 0
    ? `\n**Reason:** ${truncateReason(req.reason)}`
    : ''
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Tool approval request' },
      template: 'orange',
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `**Tool:** \`${req.toolName}\`${reasonLine}` },
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: `Session: ${card.sessionId}` }],
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Allow once' },
            type: 'primary',
            value: { action: ALLOW_ACTION, session_id: card.sessionId, nonce: card.allowNonce },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Deny' },
            type: 'danger',
            value: { action: DENY_ACTION, session_id: card.sessionId, nonce: card.denyNonce },
          },
        ],
      },
    ],
  }
}

/**
 * Build the settled note card that replaces an approval card once its
 * decision is final. Pure function of the outcome note.
 * @param note - the user-facing outcome line.
 * @returns the Feishu interactive-card JSON string ready for `updateMessage`.
 */
export function noteCard(note: string): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: note } },
    ],
  })
}

/**
 * Extract the tapped nonce from a card-action value without trusting any
 * other field. Exported for tests; consumers validate against nonce records.
 * @param value - the tapped button's value payload.
 * @returns the nonce string, or undefined when absent or malformed.
 */
export function tappedNonce(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  return typeof value.nonce === 'string' ? value.nonce : undefined
}
