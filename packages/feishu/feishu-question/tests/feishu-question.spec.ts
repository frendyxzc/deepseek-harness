/**
 * Consumer tests: the Feishu question answerer claims user-questions asks of
 * Feishu-bound agents, answers them with interactive form cards, settles the
 * ask exactly once from one-time-nonce submissions, supersedes pending cards
 * on new chat messages, and fails closed on timeout, abort, or teardown.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import FeishuRuntime, {
  FeishuError,
  type FeishuCardActionEvent,
  type FeishuReceiveEvent,
} from '@deepseek-ai/dsh-feishu'
import type {} from '@deepseek-ai/dsh-feishu-receive'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import UserQuestionService, {
  type AskUserQuestionAnswer,
  type AskUserQuestionItem,
  type UserQuestionProvider,
} from '@deepseek-ai/dsh-user-questions'
import * as FeishuQuestion from '@deepseek-ai/dsh-feishu-question'
import Loader from '@deepseek-ai/cordis-plugin-loader'

interface SentMessage {
  receiveId: string
  receiveIdType?: string
  msgType?: string
  content: string
}

interface CardControls {
  failSend: boolean
  /** When set, every card repaint fails, exercising the best-effort catch. */
  failUpdate: boolean
  /** When set, each send awaits this promise first, so settlements can race the delivery. */
  delaySend?: Promise<unknown>
}

interface Mounted {
  ctx: Context
  fiber: Awaited<ReturnType<Context['plugin']>>
  sent: SentMessage[]
  updates: Array<{ messageId: string; content: string }>
  tap: (event: Partial<FeishuCardActionEvent> & { value: unknown }) => void
  message: (event: Partial<FeishuReceiveEvent> & { chatId: string }) => void
  controls: CardControls
}

/**
 * Mount SessionStore + AgentRegistry + UserQuestionService + the Feishu seam
 * with a scripted provider (records sends/updates, captures the card-action
 * and message handlers) + the question answerer under test.
 */
async function mountQuestion(config: FeishuQuestion.Config = {}): Promise<Mounted> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(FeishuRuntime, {})

  const sent: SentMessage[] = []
  const updates: Array<{ messageId: string; content: string }> = []
  const cardHandlers: Array<(event: FeishuCardActionEvent) => void> = []
  const messageHandlers: Array<(event: FeishuReceiveEvent) => void> = []
  const controls: CardControls = { failSend: false, failUpdate: false }
  let counter = 0
  ctx.feishu.registerProvider({
    id: 'scripted',
    available: () => true,
    sendMessage: async (request) => {
      if (controls.delaySend !== undefined) await controls.delaySend
      if (controls.failSend) throw new FeishuError('scripted send failure', 'FEISHU_PROVIDER_ERROR')
      sent.push({
        receiveId: request.receiveId,
        ...(request.receiveIdType !== undefined ? { receiveIdType: request.receiveIdType } : {}),
        ...(request.msgType !== undefined ? { msgType: request.msgType } : {}),
        content: request.content,
      })
      counter += 1
      return { messageId: `om_${counter}` }
    },
    startReceiving: (handler) => {
      messageHandlers.push(handler)
      return () => {}
    },
    startReceivingCardActions: (handler) => {
      cardHandlers.push(handler)
      return () => {}
    },
    updateMessage: async (messageId, content) => {
      if (controls.failUpdate) throw new FeishuError('scripted update failure', 'FEISHU_PROVIDER_ERROR')
      updates.push({ messageId, content })
    },
  })

  const fiber = await ctx.plugin(FeishuQuestion, config)
  const tap = (event: Partial<FeishuCardActionEvent> & { value: unknown }): void => {
    for (const handler of cardHandlers) {
      handler({
        operatorId: 'ou_operator',
        chatId: 'oc_1',
        messageId: 'om_1',
        raw: {},
        ...event,
      })
    }
  }
  const message = (event: Partial<FeishuReceiveEvent> & { chatId: string }): void => {
    for (const handler of messageHandlers) {
      handler({
        eventType: 'im.message.receive_v1',
        senderId: 'ou_user',
        senderIdType: 'open_id',
        content: 'a new message',
        raw: {},
        ...event,
      })
    }
  }
  return { ctx, fiber, sent, updates, tap, message, controls }
}

/** A live chat agent: a real session inside an open turn, entered in the registry. */
function chatAgent(ctx: Context, id = 'feishu-chat-1'): Agent {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  const agent = { id, session } as unknown as Agent
  ctx.agents.enter(agent, undefined)
  return agent
}

/** Bind one agent to one Feishu chat the way feishu-receive announces it. */
function bindChat(ctx: Context, agent: Agent, chatId: string): void {
  ctx.emit('feishu/chat-agent', { agent, chatId })
}

/** One single-select question fixture. */
const singleSelect = (): AskUserQuestionItem => ({
  id: 'q1',
  question: 'Pick one',
  options: [{ label: 'Alpha', description: 'the first' }, { label: 'Beta' }],
})

/** Extract the send nonce from the first action button's value in a sent card. */
function parseQuestionCard(sent: SentMessage): string {
  expect(sent.msgType).toBe('interactive')
  expect(sent.receiveIdType).toBe('chat_id')
  const card = JSON.parse(sent.content) as { elements: Array<Record<string, unknown>> }
  for (const element of card.elements) {
    if (element.tag === 'action') {
      const actions = element.actions as Array<{ value: { nonce: string; pq: string } }>
      if (actions && actions.length > 0 && actions[0]?.value) {
        expect(actions[0].value.pq).toBe(actions[0].value.nonce)
        return actions[0].value.nonce
      }
    }
  }
  throw new Error('No action button found in card')
}

/**
 * Mount the answerer with no provider registered at all: both channels defer
 * until a provider registers. `register` adds one scripted provider and
 * returns its disposer, so churn (late, leaving, and incapable providers) is
 * scripted per test.
 */
async function mountDeferred(): Promise<{
  ctx: Context
  fiber: Awaited<ReturnType<Context['plugin']>>
  cardHandlers: Array<(event: FeishuCardActionEvent) => void>
  register: (id: string, opts?: {
    available?: () => boolean
    cardActions?: boolean
    messageReceive?: (handler: (event: FeishuReceiveEvent) => void) => () => void
  }) => () => void
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(FeishuRuntime, {})

  const cardHandlers: Array<(event: FeishuCardActionEvent) => void> = []
  const register = (
    id: string,
    opts: {
      available?: () => boolean
      cardActions?: boolean
      messageReceive?: (handler: (event: FeishuReceiveEvent) => void) => () => void
    } = {},
  ): (() => void) => ctx.feishu.registerProvider({
    id,
    available: opts.available ?? (() => true),
    sendMessage: async () => ({ messageId: 'om_1' }),
    startReceiving: opts.messageReceive ?? (() => () => {}),
    ...(opts.cardActions === false ? {} : {
      startReceivingCardActions: (handler) => {
        cardHandlers.push(handler)
        return () => {}
      },
    }),
    updateMessage: async () => {},
  })

  const fiber = await ctx.plugin(FeishuQuestion, {})
  return { ctx, fiber, cardHandlers, register }
}

describe('feishu-question', () => {
  it('keeps its namespace exports through the real Loader unwrap path', () => {
    expect('default' in FeishuQuestion).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(FeishuQuestion) as Record<string, unknown>
    expect(unwrapped).toBe(FeishuQuestion)
    expect(unwrapped.name).toBe('feishu-question')
    expect(unwrapped.inject).toEqual(['feishu', 'userQuestions'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('sends a form card to the owning chat and resolves the ask on a single-select submission', async () => {
    const { ctx, fiber, sent, updates, tap } = await mountQuestion()
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')

    const pending = ctx.userQuestions.ask({ questions: [singleSelect()], agent })
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    expect(sent[0]!.receiveId).toBe('oc_1')
    expect(sent[0]!.content).toContain('The agent has a question')
    expect(sent[0]!.content).toContain('Pick one')
    expect(sent[0]!.content).toContain('Alpha')
    const card = parseQuestionCard(sent[0]!)

    tap({ value: { nonce: card, pq: card, qid: 'q1', sel: '1' } })
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['Beta'] }] })

    await vi.waitFor(() => { expect(updates).toHaveLength(1) })
    expect(updates[0]!.messageId).toBe('om_1')
    expect(updates[0]!.content).toContain('Answered')
    expect(updates[0]!.content).toContain('Beta')
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects forged taps without consuming the nonce, so a later legitimate submission still works', async () => {
    const { ctx, fiber, sent, tap } = await mountQuestion()
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')

    const pending = ctx.userQuestions.ask({ questions: [singleSelect()], agent })
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    const nonce = parseQuestionCard(sent[0]!)

    // A tampered pq; a tap from another chat; an unknown nonce; garbage — all
    // rejected without consuming the nonce.
    tap({ value: { nonce, pq: 'forged', qid: 'q1', sel: '0' } })
    tap({ chatId: 'oc_other', value: { nonce, pq: nonce, qid: 'q1', sel: '0' } })
    tap({ value: { nonce: 'not-a-minted-nonce', pq: 'not-a-minted-nonce', qid: 'q1', sel: '0' } })
    tap({ value: 'garbage' })
    // A well-formed tap with a valid nonce and pq; false qid is rejected silently.
    tap({ value: { nonce, pq: nonce, qid: 'unknown', sel: '0' } })

    tap({ value: { nonce, pq: nonce, qid: 'q1', sel: '0' } })
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['Alpha'] }] })
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('treats a duplicate submission as inert: one answer, one card update', async () => {
    const { ctx, fiber, sent, updates, tap } = await mountQuestion()
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')

    const pending = ctx.userQuestions.ask({ questions: [singleSelect()], agent })
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    const nonce = parseQuestionCard(sent[0]!)

    tap({ value: { nonce, pq: nonce, qid: 'q1', sel: '0' } })
    tap({ value: { nonce, pq: nonce, qid: 'q1', sel: '0' } })
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['Alpha'] }] })
    await vi.waitFor(() => { expect(updates).toHaveLength(1) })
    // Give an erroneous second settle a chance to land; it must stay a single update.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(updates).toHaveLength(1)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('supersedes every pending card of a chat when the user sends a new message', async () => {
    const { ctx, fiber, sent, updates, message } = await mountQuestion()
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')

    const pending = ctx.userQuestions.ask({ questions: [singleSelect()], agent })
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })

    message({ chatId: 'oc_1', content: 'never mind, do this instead' })
    await expect(pending).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_CANCELLED' })
    await vi.waitFor(() => { expect(updates).toHaveLength(1) })
    expect(updates[0]!.content).toContain('Superseded')
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('leaves pending cards of other chats untouched by a new message', async () => {
    const { ctx, fiber, sent, tap, message } = await mountQuestion()
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')

    const pending = ctx.userQuestions.ask({ questions: [singleSelect()], agent })
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    const nonce = parseQuestionCard(sent[0]!)

    message({ chatId: '' })
    message({ chatId: 'oc_other' })
    // Still answerable: the other chat's message did not supersede it.
    tap({ value: { nonce, pq: nonce, qid: 'q1', sel: '0' } })
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['Alpha'] }] })
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('fails closed to ASK_TIMEOUT when the card is not answered in time', async () => {
    const { ctx, fiber, sent, updates } = await mountQuestion({ timeoutMs: 15 })
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')

    const pending = ctx.userQuestions.ask({ questions: [singleSelect()], agent })
    await expect(pending).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_TIMEOUT' })
    await vi.waitFor(() => { expect(updates).toHaveLength(1) })
    expect(updates[0]!.content).toContain('Timed out')
    expect(sent).toHaveLength(1)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('withdraws the card as ASK_ABORTED when the turn aborts', async () => {
    const { ctx, fiber, sent, updates } = await mountQuestion()
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')
    const controller = new AbortController()

    const pending = ctx.userQuestions.ask({ questions: [singleSelect()], agent, signal: controller.signal })
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
    await vi.waitFor(() => { expect(updates).toHaveLength(1) })
    expect(updates[0]!.content).toContain('Cancelled')
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('withdraws an undelivered card as ASK_ABORTED when the turn aborts before the send lands', async () => {
    const { ctx, fiber, controls } = await mountQuestion()
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')
    const controller = new AbortController()
    controls.failSend = true
    controller.abort()

    await expect(ctx.userQuestions.ask({ questions: [singleSelect()], agent, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('repaints a superseded card whose settlement raced the in-flight delivery', async () => {
    let releaseSend: () => void = () => {}
    const gate = new Promise<void>((resolve) => { releaseSend = resolve })
    const { ctx, fiber, sent, updates, message, controls } = await mountQuestion()
    controls.delaySend = gate
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')

    const pending = ctx.userQuestions.ask({ questions: [singleSelect()], agent })
    // The superseding message settles the ask while the card is still in flight.
    message({ chatId: 'oc_1' })
    expect(updates).toHaveLength(0)

    // The ask promise adopts the settlement only once the send completes.
    releaseSend()
    await expect(pending).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_CANCELLED' })
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    await vi.waitFor(() => { expect(updates).toHaveLength(1) })
    expect(updates[0]!.messageId).toBe('om_1')
    expect(updates[0]!.content).toContain('Superseded')
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('withdraws a delivered card through the abort listener when the abort lands after the send', async () => {
    let releaseSend: () => void = () => {}
    const gate = new Promise<void>((resolve) => { releaseSend = resolve })
    const { ctx, fiber, sent, updates, controls } = await mountQuestion()
    controls.delaySend = gate
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')
    const controller = new AbortController()

    const pending = ctx.userQuestions.ask({ questions: [singleSelect()], agent, signal: controller.signal })
    releaseSend()
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    // Let the delivery continuation register its abort listener before the
    // abort lands, so the withdrawal goes through the listener path.
    await new Promise(resolve => setTimeout(resolve, 20))
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
    await vi.waitFor(() => { expect(updates).toHaveLength(1) })
    expect(updates[0]!.content).toContain('Cancelled')
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('fails closed to ASK_ABORTED when a delivery failure lands after an in-flight abort', async () => {
    let releaseSend: () => void = () => {}
    const gate = new Promise<void>((resolve) => { releaseSend = resolve })
    const { ctx, fiber, sent, controls } = await mountQuestion()
    controls.delaySend = gate
    controls.failSend = true
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')
    const controller = new AbortController()

    const pending = ctx.userQuestions.ask({ questions: [singleSelect()], agent, signal: controller.signal })
    // The abort lands while the send is still in flight, before any listener
    // exists; the delivery failure that follows must report the abort.
    controller.abort()
    releaseSend()

    await expect(pending).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
    expect(sent).toHaveLength(0)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps the settlement when the settling repaint fails', async () => {
    const { ctx, fiber, sent, updates, tap, controls } = await mountQuestion()
    controls.failUpdate = true
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')

    const pending = ctx.userQuestions.ask({ questions: [singleSelect()], agent })
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    const nonce = parseQuestionCard(sent[0]!)
    tap({ value: { nonce, pq: nonce, qid: 'q1', sel: '0' } })
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['Alpha'] }] })
    // The best-effort repaint failed; nothing reached the wire and the
    // settlement stands.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(updates).toHaveLength(0)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('settles every pending card as cancelled on disposal', async () => {
    const { ctx, fiber, sent, updates } = await mountQuestion()
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')

    const pending = ctx.userQuestions.ask({ questions: [singleSelect()], agent })
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    await fiber.dispose()
    await expect(pending).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_CANCELLED' })
    expect(updates.some(update => update.content.includes('question channel closed'))).toBe(true)
    await ctx.fiber.dispose()
  })

  it('leaves asks of unbound agents to the default provider without sending a card', async () => {
    const { ctx, fiber, sent } = await mountQuestion()
    const seen: AskUserQuestionAnswer[] = []
    const fallback: UserQuestionProvider = {
      ask: async (request) => {
        const answer = { answers: request.questions.map(question => ({ id: question.id, selected: ['from-web'] })) }
        seen.push(answer)
        return answer
      },
    }
    ctx.userQuestions.registerProvider(fallback)
    const stranger = chatAgent(ctx, 'web-gui-session')

    const result = await ctx.userQuestions.ask({ questions: [singleSelect()], agent: stranger })
    expect(result.answers[0]?.selected).toEqual(['from-web'])
    expect(seen).toHaveLength(1)
    expect(sent).toHaveLength(0)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects ASK_UNDELIVERABLE when the card cannot be delivered', async () => {
    const { ctx, fiber, controls } = await mountQuestion()
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')
    controls.failSend = true

    await expect(ctx.userQuestions.ask({ questions: [singleSelect()], agent }))
      .rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_UNDELIVERABLE' })
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects ASK_BUSY beyond the pending-card cap', async () => {
    const { ctx, fiber, sent } = await mountQuestion()
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')

    const pendings: Array<Promise<AskUserQuestionAnswer>> = []
    for (let index = 0; index < 256; index += 1) {
      pendings.push(ctx.userQuestions.ask({ questions: [singleSelect()], agent }))
    }
    await vi.waitFor(() => { expect(sent).toHaveLength(256) })

    await expect(ctx.userQuestions.ask({ questions: [singleSelect()], agent }))
      .rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_BUSY' })

    await fiber.dispose()
    for (const pending of pendings) {
      await expect(pending).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    }
    await ctx.fiber.dispose()
  })

  it('binds subagent descendants through their parentSession chain', async () => {
    const { ctx, fiber, sent } = await mountQuestion()
    const chat = chatAgent(ctx)
    bindChat(ctx, chat, 'oc_1')

    const child = ctx.sessions.create(SessionId('feishu-child'), { meta: { parentSession: chat.session.id } })
    child.append('turn/start', { turn: 1 })
    const childAgent = { id: 'feishu-child', session: child } as unknown as Agent
    ctx.agents.enter(childAgent, undefined)
    ctx.emit('agent/created', { agent: childAgent })

    const pending = ctx.userQuestions.ask({ questions: [singleSelect()], agent: childAgent })
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    expect(sent[0]!.receiveId).toBe('oc_1')
    await fiber.dispose()
    await expect(pending).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    await ctx.fiber.dispose()
  })

  it('only inherits chat bindings from bound parent sessions', async () => {
    const { ctx, fiber } = await mountQuestion()
    // A created agent without any parent session: nothing to inherit.
    const orphan = chatAgent(ctx, 'feishu-orphan')
    ctx.emit('agent/created', { agent: orphan })

    // A created agent whose parent is not bound to a chat either.
    const unboundParent = ctx.sessions.create(SessionId('feishu-unbound'))
    const stranger = ctx.sessions.create(SessionId('feishu-stranger'), { meta: { parentSession: unboundParent.id } })
    stranger.append('turn/start', { turn: 1 })
    const strangerAgent = { id: 'feishu-stranger', session: stranger } as unknown as Agent
    ctx.agents.enter(strangerAgent, undefined)
    ctx.emit('agent/created', { agent: strangerAgent })

    await expect(ctx.userQuestions.ask({ questions: [singleSelect()], agent: strangerAgent }))
      .rejects.toMatchObject({ name: 'UserQuestionError', code: 'NO_PROVIDER' })
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('releases a chat binding when its agent is disposed', async () => {
    const { ctx, fiber, sent } = await mountQuestion()
    const fallback: UserQuestionProvider = {
      ask: async request => ({ answers: request.questions.map(question => ({ id: question.id, selected: ['from-web'] })) }),
    }
    ctx.userQuestions.registerProvider(fallback)
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')
    ctx.emit('agent/disposed', { agent })

    const result = await ctx.userQuestions.ask({ questions: [singleSelect()], agent })
    expect(result.answers[0]?.selected).toEqual(['from-web'])
    expect(sent).toHaveLength(0)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('fails loud at load when the provider cannot receive card actions', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(FeishuRuntime, {})
    ctx.feishu.registerProvider({
      id: 'send-only',
      available: () => true,
      sendMessage: async () => ({ messageId: 'm' }),
    })
    await expect(ctx.plugin(FeishuQuestion, {})).rejects.toThrow(
      expect.objectContaining({ code: 'FEISHU_RECEIVE_UNSUPPORTED' }),
    )
    await ctx.fiber.dispose()
  })

  it('loads without a registered provider and opens the channels when one registers', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(FeishuRuntime, {})
    const fiber = await ctx.plugin(FeishuQuestion, {})

    const sent: SentMessage[] = []
    const cardHandlers: Array<(event: FeishuCardActionEvent) => void> = []
    ctx.feishu.registerProvider({
      id: 'scripted',
      available: () => true,
      sendMessage: async (request) => {
        sent.push({
          receiveId: request.receiveId,
          ...(request.receiveIdType !== undefined ? { receiveIdType: request.receiveIdType } : {}),
          ...(request.msgType !== undefined ? { msgType: request.msgType } : {}),
          content: request.content,
        })
        return { messageId: 'om_1' }
      },
      startReceiving: () => () => {},
      startReceivingCardActions: (handler) => {
        cardHandlers.push(handler)
        return () => {}
      },
      updateMessage: async () => {},
    })
    expect(cardHandlers).toHaveLength(1)

    // The deferred channel serves real asks: one bound chat agent's ask sends
    // a card, and its submission settles the ask.
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')
    const pending = ctx.userQuestions.ask({ questions: [singleSelect()], agent })
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    const nonce = parseQuestionCard(sent[0]!)
    cardHandlers[0]!({
      operatorId: 'ou_1',
      chatId: 'oc_1',
      messageId: 'om_1',
      raw: {},
      value: { nonce, pq: nonce, qid: 'q1', sel: '0' },
    })
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['Alpha'] }] })
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('fails the registration loudly when a later provider cannot receive card actions', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(FeishuRuntime, {})
    const fiber = await ctx.plugin(FeishuQuestion, {})

    expect(() => ctx.feishu.registerProvider({
      id: 'send-only',
      available: () => true,
      sendMessage: async () => ({ messageId: 'm' }),
    })).toThrow(expect.objectContaining({ code: 'FEISHU_RECEIVE_UNSUPPORTED' }))
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps waiting through registrations that cannot host the channel', async () => {
    const { ctx, fiber, cardHandlers, register } = await mountDeferred()
    const disposeCold = register('cold', { available: () => false })
    expect(cardHandlers).toHaveLength(0)
    disposeCold()
    expect(cardHandlers).toHaveLength(0)

    register('scripted')
    expect(cardHandlers).toHaveLength(1)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('reopens the card channel on the remaining provider when another leaves', async () => {
    const { ctx, fiber, cardHandlers, register } = await mountDeferred()
    const disposeA = register('bot-a')
    expect(cardHandlers).toHaveLength(1)
    const disposeB = register('bot-b')
    expect(cardHandlers).toHaveLength(1)

    disposeB()
    expect(cardHandlers).toHaveLength(2)
    disposeA()
    expect(cardHandlers).toHaveLength(2)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('falls back to waiting when the remaining provider cannot host the channel', async () => {
    const { ctx, fiber, cardHandlers, register } = await mountDeferred()
    const disposeGood = register('good')
    expect(cardHandlers).toHaveLength(1)
    const disposeSendOnly = register('send-only', { cardActions: false })
    expect(cardHandlers).toHaveLength(1)

    disposeGood()
    expect(cardHandlers).toHaveLength(1)
    disposeSendOnly()
    register('good-2')
    expect(cardHandlers).toHaveLength(2)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('rolls the card channel back when the message channel cannot open', async () => {
    const { ctx, fiber, cardHandlers, register } = await mountDeferred()
    // Card actions open, but the message channel reports no provider: the
    // half-opened pair must roll back and the answerer keeps waiting.
    const disposeFlaky = register('flaky', {
      messageReceive: () => { throw new FeishuError('scripted receive failure', 'FEISHU_PROVIDER_UNAVAILABLE') },
    })
    expect(cardHandlers).toHaveLength(1)

    disposeFlaky()
    register('scripted')
    expect(cardHandlers).toHaveLength(2)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('fails loud for a non-positive timeoutMs', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(FeishuRuntime, {})
    ctx.feishu.registerProvider({
      id: 'scripted',
      available: () => true,
      sendMessage: async () => ({ messageId: 'm' }),
      startReceiving: () => () => {},
      startReceivingCardActions: () => () => {},
    })
    await expect(ctx.plugin(FeishuQuestion, { timeoutMs: 0 })).rejects.toThrow(/positive number/)
    await ctx.fiber.dispose()
  })
})

describe('feishu-question card builders', () => {
  it('builds a plan-review card with the plan detail and an orange header', () => {
    const card = FeishuQuestion.questionCard([{
      id: 'plan-review',
      question: 'Approve this plan?',
      detail: '# The plan',
      options: [{ label: 'Approve' }, { label: 'Keep planning' }],
      intent: { kind: 'plan-review', approve: 'Approve' },
    }], 'nonce-1')
    const header = card.header as { title: { content: string }; template: string }
    expect(header.title.content).toBe('Plan review')
    expect(header.template).toBe('orange')
    const elements = card.elements as Array<Record<string, unknown>>
    const detail = elements[0] as { text: { content: string } }
    expect(detail.text.content).toBe('# The plan')
  })

  it('caps an oversized detail in the card body', () => {
    const card = FeishuQuestion.questionCard([{
      id: 'plan-review',
      question: 'Approve?',
      detail: 'x'.repeat(8002),
      options: [{ label: 'Approve' }],
      intent: { kind: 'plan-review', approve: 'Approve' },
    }], 'nonce-1')
    const elements = card.elements as Array<{ text: { content: string } }>
    expect(elements[0]!.text.content).toHaveLength(8001)
    expect(elements[0]!.text.content.endsWith('…')).toBe(true)
  })

  it('bolds a non-empty header in the question heading and drops a blank one', () => {
    const headingOf = (card: Record<string, unknown>): string => {
      const elements = card.elements as Array<Record<string, unknown>>
      const heading = elements.find(element => element.tag === 'div') as { text: { content: string } }
      return heading.text.content
    }

    const withHeader = FeishuQuestion.questionCard([{
      id: 'q1',
      header: 'Deploy',
      question: 'Pick one',
      options: [{ label: 'Alpha' }],
    }], 'nonce-1')
    expect(headingOf(withHeader)).toContain('**Deploy** Pick one')

    const blankHeader = FeishuQuestion.questionCard([{
      id: 'q1',
      header: '',
      question: 'Pick one',
      options: [{ label: 'Alpha' }],
    }], 'nonce-1')
    const plain = headingOf(blankHeader)
    expect(plain.startsWith('Pick one')).toBe(true)
    expect(plain.startsWith('**')).toBe(false)
  })

  it('summarizes questions and answers in the settled card', () => {
    const summary = JSON.parse(FeishuQuestion.answerSummaryCard(
      [{ id: 'q1', question: 'Pick one' }, { id: 'q2', question: 'Anything else?' }],
      [{ id: 'q1', selected: ['Alpha'] }, { id: 'q2', selected: [], custom: 'typed' }],
    )) as { elements: Array<{ text: { content: string } }> }
    const content = summary.elements[0]!.text.content
    expect(content).toContain('Answered')
    expect(content).toContain('Pick one')
    expect(content).toContain('Alpha')
    expect(content).toContain('typed')
  })

  it('marks unanswered questions in the settled card', () => {
    const summary = JSON.parse(FeishuQuestion.answerSummaryCard(
      [{ id: 'q1', question: 'Pick one' }, { id: 'q2', question: 'And another?' }],
      [{ id: 'q1', selected: [] }],
    )) as { elements: Array<{ text: { content: string } }> }
    // An empty selection and a question with no answer record at all both
    // render as unanswered.
    const content = summary.elements[0]!.text.content
    expect(content.match(/\(no answer\)/g)).toHaveLength(2)
  })
})
