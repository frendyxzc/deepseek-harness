/**
 * `@deepseek-ai/dsh-feishu-question`: the question-card answerer for Feishu
 * chat agents. It registers a routing `ctx.userQuestions` provider that
 * claims every ask whose owner agent is bound to a Feishu chat — a per-chat
 * agent announced by `@deepseek-ai/dsh-feishu-receive`, or a subagent
 * descendant of one — and answers it with an interactive v1 card in the
 * owning chat: one button per option, settled by tapping. A shared one-time
 * nonce correlates every tap with its ask and settles it exactly once when
 * every option-bearing question is answered; a question without options
 * invites a chat reply, and a timeout, an abort, a superseding chat message,
 * or a plugin teardown rejects the ask fail-closed. The user-questions seam
 * races every accepting provider for the first answer, so a Feishu-bound ask
 * is also offered to the default provider (the Web UI) and either surface can
 * answer it; asks with no Feishu binding reach the default provider alone.
 *
 * @module @deepseek-ai/dsh-feishu-question
 */

import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-feishu'
import { FeishuError, type FeishuCardActionEvent, type FeishuReceiveEvent } from '@deepseek-ai/dsh-feishu'
import type {} from '@deepseek-ai/dsh-feishu-receive'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionAnswerItem,
  type AskUserQuestionItem,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-user-questions'
import z from '@deepseek-ai/schemastery'
import { parseOptionAnswer } from './answers.ts'
import { answerSummaryCard, noteCard, questionCard } from './card.ts'

export { parseOptionAnswer } from './answers.ts'
export { answerSummaryCard, noteCard, questionCard } from './card.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'feishu-question'

/**
 * Services required by the Feishu question answerer: the Feishu seam to send
 * and settle cards and receive card actions and messages, and the
 * user-questions service whose asks this plugin routes and answers.
 */
export const inject = ['feishu', 'userQuestions']

/** Default wait budget (ms) for one question card. */
export const DEFAULT_FEISHU_QUESTION_TIMEOUT_MS = 300_000

/** Plugin config. */
export interface Config {
  /**
   * How long (ms) one question card waits for a submission before it is
   * rejected automatically. Defaults to 300000; must be a positive finite
   * number.
   */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  timeoutMs: z.number().default(DEFAULT_FEISHU_QUESTION_TIMEOUT_MS),
})

/** Config after schemastery applies field defaults. */
interface ResolvedConfig extends Config {
  timeoutMs: number
}

/**
 * Cap on live question cards. Exceeding it rejects the ask with `ASK_BUSY`,
 * so a runaway question storm cannot grow memory without bound and no card
 * ever lingers past its own budget.
 */
const MAX_PENDING_QUESTIONS = 256

/** One delivered question card and the answer it is waiting for. */
interface PendingQuestion {
  /** The nonce minted for the option buttons; also the entry's key. */
  readonly nonce: string
  /** The answers accumulated across this card's taps, keyed by question order. */
  readonly answers: AskUserQuestionAnswerItem[]
  /** The Feishu chat the card was sent to; taps from other chats are rejected. */
  readonly chatId: string
  /** The questions the card asks; a tap maps back to one of these. */
  readonly questions: AskUserQuestionItem[]
  /** The card message id once delivery succeeds; unset before then. */
  messageId: string | undefined
  /** Resolves the ask promise; assigned before the card is armed. */
  resolve: ((answer: AskUserQuestionAnswer) => void) | undefined
  /** Rejects the ask promise; assigned before the card is armed. */
  reject: ((error: UserQuestionError) => void) | undefined
  /** The timeout that rejects an unanswered card. */
  timer: ReturnType<typeof setTimeout> | undefined
  /** The abort listener that withdraws a card with its turn. */
  onAbort: (() => void) | undefined
  /** The request signal the abort listener is attached to, when any. */
  signal: AbortSignal | undefined
  /**
   * The settled card's final content when the settlement raced the in-flight
   * delivery: repainted as soon as the message id arrives.
   */
  finalContent: string | undefined
  /** Settled cards are inert: later taps, timers, and aborts are no-ops. */
  settled: boolean
}

/**
 * Answer Feishu chat agents' user-questions asks with interactive form
 * cards. The card tap channel and the message channel open on a registered
 * Feishu provider; sibling plugins load concurrently, so both channels wait
 * for `feishu/provider-added` when no usable provider has registered yet,
 * and a provider that cannot receive card actions fails its registration
 * loudly — answering is impossible without the tap channel.
 * @param ctx - Cordis context carrying the injected services.
 * @param config - plugin config; `timeoutMs` defaults to 300000.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  const timeoutMs = resolved.timeoutMs
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`feishu-question: timeoutMs must be a positive number, got ${String(timeoutMs)}`)
  }

  /**
   * Chat bindings by session id. A chat session is bound by its
   * `feishu/chat-agent` announcement; a descendant session (subagent) is
   * bound through its `parentSession` at creation, so the whole delegation
   * tree under one chat answers in that chat. Bindings are released with
   * their agent.
   */
  const chatBySession = new Map<SessionId, string>()
  /** Live question cards by submit nonce. */
  const nonceToPending = new Map<string, PendingQuestion>()

  /** Mint a one-time nonce: enough entropy that guessing is not a channel. */
  const mintNonce = (): string => randomBytes(12).toString('base64url')

  /**
   * Repaint one card best-effort — a failed repaint never reopens the
   * settlement that triggered it.
   */
  const repaint = (messageId: string, content: string): void => {
    void ctx.feishu.updateMessage(messageId, content).catch((error: unknown) => {
      ctx.logger.warn('feishu-question: settling card %s failed: %s', messageId, String(error))
    })
  }

  /**
   * Deliver one settled card's final content. A settlement can race the
   * in-flight delivery — a tap, a superseding message, or a teardown can
   * land before the send response carries the message id back — so when the
   * id is not known yet the content is recorded on the pending record and
   * repainted as soon as the send completes.
   */
  const repaintSettled = (pending: PendingQuestion, content: string): void => {
    if (pending.messageId === undefined) pending.finalContent = content
    else repaint(pending.messageId, content)
  }

  /**
   * Retire one pending question exactly once: mark it settled, free its
   * nonce, and stop its timer and abort listener. False means the question
   * already settled, so callers act at most once.
   */
  const retire = (pending: PendingQuestion): boolean => {
    /* v8 ignore next -- defensive at-most-once guard: every settlement path
       retires through the nonce table, so a second settle cannot reach here */
    if (pending.settled) return false
    pending.settled = true
    nonceToPending.delete(pending.nonce)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    if (pending.onAbort !== undefined) pending.signal?.removeEventListener('abort', pending.onAbort)
    return true
  }

  /**
   * Reject one pending question exactly once and repaint the card with the
   * outcome note.
   */
  const settleQuestion = (pending: PendingQuestion, error: UserQuestionError, note: string): void => {
    /* v8 ignore next -- unreachable: retire() filters the double settle */
    if (!retire(pending)) return
    pending.reject?.(error)
    repaintSettled(pending, noteCard(note))
  }

  /**
   * Resolve one pending question exactly once with a parsed submission and
   * repaint the card with the question → answer summary.
   */
  const resolveQuestion = (pending: PendingQuestion, answers: AskUserQuestionAnswer['answers']): void => {
    /* v8 ignore next -- unreachable: retire() filters the double settle */
    if (!retire(pending)) return
    pending.resolve?.({ answers })
    repaintSettled(pending, answerSummaryCard(pending.questions, answers))
  }

  /**
   * Handle one option-button tap. Settles synchronously — Feishu expects the
   * callback acknowledged promptly — and validates the tap against the
   * nonce's own record BEFORE consuming it: the card `value` is
   * attacker-controllable, so a forged action or a tap from another chat is
   * rejected WITHOUT consuming the nonce, leaving a later legitimate tap
   * intact. A partial answer is likewise not consumed: the ask settles only
   * once every option-bearing question has an answer.
   */
  const onCardAction = (event: FeishuCardActionEvent): void => {
    const value = event.value
    const nonce = isRecord(value) && typeof value.nonce === 'string' ? value.nonce : undefined
    const pending = nonce !== undefined ? nonceToPending.get(nonce) : undefined
    if (nonce === undefined || pending === undefined) {
      // Missing or already-consumed nonce: a stale or duplicate tap. This is
      // the one-time-use guarantee — a second click after settlement is inert.
      return
    }
    if ((value as Record<string, unknown>).pq !== nonce || event.chatId !== pending.chatId) {
      ctx.logger.warn('feishu-question: rejecting a card action that does not match its nonce record (chat %s)', event.chatId)
      return
    }
    const qid = (value as Record<string, unknown>).qid
    const question = pending.questions.find(candidate => candidate.id === qid)
    if (question === undefined) {
      ctx.logger.warn('feishu-question: rejecting a card action for an unknown question (chat %s)', event.chatId)
      return
    }
    const answer = parseOptionAnswer(question, (value as Record<string, unknown>).sel)
    if (answer === undefined) {
      ctx.logger.info('feishu-question: option tap mapped to no option; the card stays open (chat %s)', event.chatId)
      return
    }
    // Upsert this question's answer, then settle once every option-bearing
    // question is answered. A partial answer keeps the card open for the rest.
    const answeredIndex = pending.answers.findIndex(record => record.id === question.id)
    if (answeredIndex >= 0) pending.answers[answeredIndex] = answer
    else pending.answers.push(answer)
    const answeredIds = new Set(pending.answers.map(record => record.id))
    const complete = pending.questions
      .filter(candidate => (candidate.options ?? []).length > 0)
      .every(candidate => answeredIds.has(candidate.id))
    if (complete) resolveQuestion(pending, [...pending.answers])
  }

  /**
   * Handle one incoming chat message. Whatever the message says, it is the
   * user's answer to anything the agent was still waiting on in that chat:
   * every pending question there is superseded with `ASK_CANCELLED`, which
   * plan review interprets as "the user turned to speaking instead".
   */
  const onMessage = (event: FeishuReceiveEvent): void => {
    const chatId = event.chatId
    if (chatId.length === 0) return
    for (const pending of [...nonceToPending.values()]) {
      if (pending.chatId !== chatId) continue
      settleQuestion(
        pending,
        new UserQuestionError('the user sent a new message before answering the question card', 'ASK_CANCELLED'),
        'Superseded — you sent a new message before answering.',
      )
    }
  }

  /** Claim asks whose owner agent is bound to a Feishu chat. */
  const accepts = (request: AskUserQuestionRequest): boolean =>
    request.agent !== undefined && chatBySession.has(request.agent.session.id)

  /**
   * Answer one claimed ask with an interactive form card. The pending record
   * is registered BEFORE the send — a submission can never arrive for a card
   * whose record does not exist — and every path that produces no answer
   * rejects fail-closed.
   */
  const ask = async (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => {
    // `accepts` ran synchronously immediately before this call, so this
    // re-check normally just re-reads the binding it already saw; a miss
    // means the binding was released in between, and the ask fails closed.
    const agent = request.agent as Agent
    const chatId = chatBySession.get(agent.session.id)
    /* v8 ignore next 3 -- unreachable: accepts() re-checked this binding
       synchronously immediately before this call */
    if (chatId === undefined) {
      throw new UserQuestionError('the Feishu chat binding was released before the ask', 'NO_PROVIDER')
    }
    // The live-card table is bounded: an ask beyond the cap fails with its
    // own code instead of queueing unbounded state.
    if (nonceToPending.size >= MAX_PENDING_QUESTIONS) {
      throw new UserQuestionError('too many pending Feishu question cards', 'ASK_BUSY')
    }

    const nonce = mintNonce()
    const pending: PendingQuestion = {
      nonce,
      answers: [],
      chatId,
      questions: request.questions,
      messageId: undefined,
      resolve: undefined,
      reject: undefined,
      timer: undefined,
      onAbort: undefined,
      signal: request.signal,
      finalContent: undefined,
      settled: false,
    }
    // The answer promise exists BEFORE the send: any settlement racing the
    // in-flight delivery (an abort, a teardown) still settles the promise
    // this function returns.
    const answer = new Promise<AskUserQuestionAnswer>((resolvePromise, rejectPromise) => {
      pending.resolve = resolvePromise
      pending.reject = rejectPromise
    })
    // A settlement can reject `answer` before this function returns it — a
    // superseding chat message or an abort racing the in-flight send — so a
    // guard keeps the interim rejection from surfacing as an unhandled
    // rejection; the returned promise still rejects for the caller.
    void answer.catch(() => {})
    nonceToPending.set(nonce, pending)

    try {
      const sent = await ctx.feishu.sendMessage({
        receiveId: chatId,
        receiveIdType: 'chat_id',
        msgType: 'interactive',
        content: JSON.stringify(questionCard(request.questions, nonce)),
      }, request.signal)
      // The id is recorded even when a settlement raced the delivery, so the
      // recorded final content can still repaint the delivered card.
      pending.messageId = sent.messageId
      if (pending.finalContent !== undefined) repaint(pending.messageId, pending.finalContent)
      if (pending.settled) return await answer
    } catch (error: unknown) {
      if (!pending.settled) {
        pending.settled = true
        nonceToPending.delete(nonce)
        if (request.signal?.aborted === true) {
          throw new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED', { cause: error })
        }
        throw new UserQuestionError('the Feishu question card could not be delivered', 'ASK_UNDELIVERABLE', { cause: error })
      }
      return answer
    }

    pending.timer = setTimeout(() => {
      settleQuestion(
        pending,
        new UserQuestionError('the Feishu question card was not answered in time', 'ASK_TIMEOUT'),
        '⏱️ Timed out without an answer.',
      )
    }, timeoutMs)
    if (request.signal !== undefined) {
      pending.onAbort = () => {
        settleQuestion(
          pending,
          new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED'),
          'Cancelled — the turn ended before an answer.',
        )
      }
      // An abort can land while the send is still in flight, before this
      // listener exists; a listener added to an already-aborted signal never
      // fires, so an abort already observed is settled directly.
      if (request.signal.aborted) pending.onAbort()
      else request.signal.addEventListener('abort', pending.onAbort, { once: true })
    }
    return answer
  }

  ctx.effect(() => {
    // Both channels are the feature's precondition: a provider that cannot
    // receive card actions fails loud here, at load, not at the first ask.
    // Entry fibers load in parallel, so a provider plugin may still be
    // activating when this effect runs; the seam's registration events open
    // the channels then instead of failing the boot over load order.
    let disposeCardReceive: (() => void) | undefined
    let disposeMessageReceive: (() => void) | undefined
    /** Whether the channels wait for a usable provider to register. */
    let waitingForProvider = false

    /** Open both channels; false when no usable provider is registered yet. */
    const openChannels = (): boolean => {
      let openedCard = false
      try {
        disposeCardReceive = ctx.feishu.startReceivingCardActions(onCardAction)
        openedCard = true
        disposeMessageReceive = ctx.feishu.startReceiving(onMessage)
        return true
      } catch (error: unknown) {
        // A half-opened pair must not leak when the second open throws or
        // reports no provider yet.
        if (openedCard) {
          disposeCardReceive?.()
          disposeCardReceive = undefined
        }
        // Not registered (yet) — a provider fiber may still be loading.
        if (error instanceof FeishuError
          && (error.code === 'FEISHU_PROVIDER_UNAVAILABLE' || error.code === 'FEISHU_PROVIDER_CONFIGURED_MISSING')) {
          return false
        }
        throw error
      }
    }
    const closeChannels = (): void => {
      disposeCardReceive?.()
      disposeCardReceive = undefined
      disposeMessageReceive?.()
      disposeMessageReceive = undefined
    }

    waitingForProvider = !openChannels()
    if (waitingForProvider) {
      ctx.logger.warn('feishu-question: no usable Feishu provider is registered yet; the card channels open when one registers')
    }

    const offProviderAdded = ctx.on('feishu/provider-added', () => {
      if (!waitingForProvider) return
      // A registered provider that cannot receive card actions is a real
      // misconfiguration: the throw unwinds the provider's registration and
      // fails its fiber loudly.
      waitingForProvider = !openChannels()
    })
    /* jscpd:ignore-start -- the provider-removed reopen and the chat-ownership
       tracking deliberately mirror feishu-approval; each answerer keeps its own
       lifecycle inline until a third consumer earns a shared seam */
    const offProviderRemoved = ctx.on('feishu/provider-removed', () => {
      if (waitingForProvider) return
      // The channels' provider is gone: re-open on a remaining provider, or
      // wait for the next registration. This path never throws — a teardown
      // reaction must not fail the unloading fiber.
      closeChannels()
      try {
        waitingForProvider = !openChannels()
      } catch (error: unknown) {
        waitingForProvider = true
        ctx.logger.warn('feishu-question: card channels closed and cannot reopen: %s', String(error))
      }
    })

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
    /* jscpd:ignore-end */

    // Routing provider: claims Feishu-bound asks via `accepts`; every other
    // ask falls through to the default provider unchanged.
    const disposeProvider = ctx.userQuestions.registerProvider({ accepts, ask })

    return () => {
      disposeProvider()
      closeChannels()
      offProviderAdded()
      offProviderRemoved()
      offChatAgent()
      offCreated()
      offDisposed()
      // Teardown parity with the approval answerer: withdraw every
      // still-pending card as cancelled so no ask promise dangles past this
      // plugin's lifetime.
      for (const pending of [...nonceToPending.values()]) {
        settleQuestion(
          pending,
          new UserQuestionError('the Feishu question channel closed before an answer arrived', 'ASK_CANCELLED'),
          'Cancelled — the question channel closed.',
        )
      }
    }
  }, 'feishu-question.answerer')
}

/** A plain-object view for card values and tapped payloads. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
