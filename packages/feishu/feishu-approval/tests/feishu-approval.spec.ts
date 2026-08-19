/**
 * Consumer tests: the Feishu approval answerer sends one interactive card per
 * owned approval request, settles the `approval/request` waterfall exactly
 * once from one-time-nonce button taps, and fails closed on timeout, abort,
 * teardown, or any path that does not produce an explicit Allow.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import FeishuRuntime, { FeishuError, type FeishuCardActionEvent } from '@deepseek-ai/dsh-feishu'
import type {} from '@deepseek-ai/dsh-feishu-receive'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService, { type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import * as FeishuApproval from '@deepseek-ai/dsh-feishu-approval'
import Loader from '@deepseek-ai/cordis-plugin-loader'

interface SentMessage {
  receiveId: string
  receiveIdType?: string
  msgType?: string
  content: string
}

interface CardControls {
  failSend: boolean
}

interface Mounted {
  ctx: Context
  fiber: Awaited<ReturnType<Context['plugin']>>
  sent: SentMessage[]
  updates: Array<{ messageId: string; content: string }>
  tap: (event: Partial<FeishuCardActionEvent> & { value: unknown }) => void
  controls: CardControls
}

/**
 * Mount SessionStore + ApprovalService + the Feishu seam with a scripted
 * provider (records sends/updates, captures the card-action handler) + the
 * approval answerer under test.
 */
async function mountApproval(config: FeishuApproval.Config = {}): Promise<Mounted> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(FeishuRuntime, {})

  const sent: SentMessage[] = []
  const updates: Array<{ messageId: string; content: string }> = []
  const handlers: Array<(event: FeishuCardActionEvent) => void> = []
  const controls: CardControls = { failSend: false }
  let counter = 0
  ctx.feishu.registerProvider({
    id: 'scripted',
    available: () => true,
    sendMessage: async (request) => {
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
    startReceivingCardActions: (handler) => {
      handlers.push(handler)
      return () => {}
    },
    updateMessage: async (messageId, content) => {
      updates.push({ messageId, content })
    },
  })

  const fiber = await ctx.plugin(FeishuApproval, config)
  const tap = (event: Partial<FeishuCardActionEvent> & { value: unknown }): void => {
    for (const handler of handlers) {
      handler({
        operatorId: 'ou_operator',
        chatId: 'oc_1',
        messageId: 'om_1',
        raw: {},
        ...event,
      })
    }
  }
  return { ctx, fiber, sent, updates, tap, controls }
}

/**
 * Mount SessionStore + ApprovalService + the Feishu seam + the approval
 * answerer with NO provider registered yet, and a factory for registering
 * scripted providers later — the parallel-entry-load situation where the
 * provider plugin activates after the answerer.
 */
async function mountDeferred(
  config: FeishuApproval.Config = {},
  seamConfig: ConstructorParameters<typeof FeishuRuntime>[1] = {},
): Promise<{
  ctx: Context
  fiber: Awaited<ReturnType<Context['plugin']>>
  sent: SentMessage[]
  cardHandlers: Array<(event: FeishuCardActionEvent) => void>
  register: (id: string, opts?: { available?: () => boolean; cardActions?: boolean }) => () => void
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(FeishuRuntime, seamConfig)

  const sent: SentMessage[] = []
  const cardHandlers: Array<(event: FeishuCardActionEvent) => void> = []
  const register = (
    id: string,
    opts: { available?: () => boolean; cardActions?: boolean } = {},
  ): (() => void) => ctx.feishu.registerProvider({
    id,
    available: opts.available ?? (() => true),
    sendMessage: async (request) => {
      sent.push({
        receiveId: request.receiveId,
        ...(request.receiveIdType !== undefined ? { receiveIdType: request.receiveIdType } : {}),
        ...(request.msgType !== undefined ? { msgType: request.msgType } : {}),
        content: request.content,
      })
      return { messageId: 'om_1' }
    },
    ...(opts.cardActions === false ? {} : {
      startReceivingCardActions: (handler) => {
        cardHandlers.push(handler)
        return () => {}
      },
    }),
    updateMessage: async () => {},
  })

  const fiber = await ctx.plugin(FeishuApproval, config)
  return { ctx, fiber, sent, cardHandlers, register }
}

/** A live chat agent: a real session inside an open turn, faked Agent shape. */
function chatAgent(ctx: Context, id = 'feishu-chat-1'): Agent {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  return { session } as unknown as Agent
}

/** Bind one agent to one Feishu chat the way feishu-receive announces it. */
function bindChat(ctx: Context, agent: Agent, chatId: string): void {
  ctx.emit('feishu/chat-agent', { agent, chatId })
}

function requestOf(agent: Agent, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return { agent, toolName: 'bash', reason: 'needs the network', ...overrides }
}

interface ParsedCard {
  allowNonce: string
  denyNonce: string
  sessionId: string
}

/** Extract both button nonces and the embedded session id from a sent card. */
function parseCard(sent: SentMessage): ParsedCard {
  expect(sent.msgType).toBe('interactive')
  expect(sent.receiveIdType).toBe('chat_id')
  const card = JSON.parse(sent.content) as { elements: Array<Record<string, unknown>> }
  const actionElement = card.elements.find(element => element.tag === 'action') as
    { actions: Array<{ value: { action: string; session_id: string; nonce: string } }> }
  const allow = actionElement.actions.find(action => action.value.action === 'allow')!
  const deny = actionElement.actions.find(action => action.value.action === 'deny')!
  expect(allow.value.nonce).not.toBe(deny.value.nonce)
  return { allowNonce: allow.value.nonce, denyNonce: deny.value.nonce, sessionId: allow.value.session_id }
}

describe('feishu-approval', () => {
  it('keeps its namespace exports through the real Loader unwrap path', () => {
    expect('default' in FeishuApproval).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(FeishuApproval) as Record<string, unknown>
    expect(unwrapped).toBe(FeishuApproval)
    expect(unwrapped.name).toBe('feishu-approval')
    expect(unwrapped.inject).toEqual(['feishu', 'approval'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('sends an interactive card to the owning chat and allows on an Allow tap', async () => {
    const { ctx, fiber, sent, updates, tap } = await mountApproval()
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')

    const pending = ctx.approval.request(requestOf(agent))
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    expect(sent[0]!.receiveId).toBe('oc_1')
    expect(sent[0]!.content).toContain('Tool approval request')
    expect(sent[0]!.content).toContain('bash')
    const card = parseCard(sent[0]!)
    expect(card.sessionId).toBe(agent.session.id)

    tap({ value: { action: 'allow', session_id: card.sessionId, nonce: card.allowNonce } })
    await expect(pending).resolves.toBe('allowed-once')

    await vi.waitFor(() => { expect(updates).toHaveLength(1) })
    expect(updates[0]!.messageId).toBe('om_1')
    expect(updates[0]!.content).toContain('Allowed')
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects on a Deny tap', async () => {
    const { ctx, fiber, sent, updates, tap } = await mountApproval()
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')

    const pending = ctx.approval.request(requestOf(agent))
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    const card = parseCard(sent[0]!)

    tap({ value: { action: 'deny', session_id: card.sessionId, nonce: card.denyNonce } })
    await expect(pending).resolves.toBe('rejected')
    await vi.waitFor(() => { expect(updates).toHaveLength(1) })
    expect(updates[0]!.content).toContain('Denied')
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('fails closed to rejected when the card is not answered in time', async () => {
    const { ctx, fiber, sent, updates } = await mountApproval({ timeoutMs: 15 })
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')

    const pending = ctx.approval.request(requestOf(agent))
    await expect(pending).resolves.toBe('rejected')
    await vi.waitFor(() => { expect(updates).toHaveLength(1) })
    expect(updates[0]!.content).toContain('Timed out')
    expect(sent).toHaveLength(1)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('delegates unbound agents to the next answerer without sending a card', async () => {
    const { ctx, fiber, sent } = await mountApproval()
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    const stranger = chatAgent(ctx, 'not-feishu')

    await expect(ctx.approval.request(requestOf(stranger))).resolves.toBe('allowed-once')
    expect(sent).toHaveLength(0)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('delegates to the next answerer when card delivery fails', async () => {
    const { ctx, fiber, sent, controls } = await mountApproval()
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')
    controls.failSend = true

    await expect(ctx.approval.request(requestOf(agent))).resolves.toBe('allowed-once')
    expect(sent).toHaveLength(0)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('treats a duplicate tap as inert: one decision, one card update', async () => {
    const { ctx, fiber, sent, updates, tap } = await mountApproval()
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')

    const pending = ctx.approval.request(requestOf(agent))
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    const card = parseCard(sent[0]!)

    tap({ value: { action: 'allow', session_id: card.sessionId, nonce: card.allowNonce } })
    tap({ value: { action: 'allow', session_id: card.sessionId, nonce: card.allowNonce } })
    await expect(pending).resolves.toBe('allowed-once')
    await vi.waitFor(() => { expect(updates).toHaveLength(1) })
    // Give an erroneous second settle a chance to land; it must stay a single update.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(updates).toHaveLength(1)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects forged taps without consuming the nonce, so a later legitimate tap still works', async () => {
    const { ctx, fiber, sent, tap } = await mountApproval()
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')

    const pending = ctx.approval.request(requestOf(agent))
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    const card = parseCard(sent[0]!)

    // The allow nonce replayed as a deny action; a tampered session id; a tap
    // from another chat — all rejected without consuming the nonce.
    tap({ value: { action: 'deny', session_id: card.sessionId, nonce: card.allowNonce } })
    tap({ value: { action: 'allow', session_id: 'some-other-session', nonce: card.allowNonce } })
    tap({ chatId: 'oc_other', value: { action: 'allow', session_id: card.sessionId, nonce: card.allowNonce } })
    tap({ value: { nonce: 'not-a-minted-nonce' } })
    tap({ value: 'garbage' })

    tap({ value: { action: 'allow', session_id: card.sessionId, nonce: card.allowNonce } })
    await expect(pending).resolves.toBe('allowed-once')
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('withdraws the card as cancelled when the turn aborts', async () => {
    const { ctx, fiber, sent, updates } = await mountApproval()
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')
    const controller = new AbortController()

    const pending = ctx.approval.request(requestOf(agent, { signal: controller.signal }))
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    controller.abort()

    await expect(pending).resolves.toBe('cancelled')
    await vi.waitFor(() => { expect(updates).toHaveLength(1) })
    expect(updates[0]!.content).toContain('Cancelled')
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('binds subagent descendants through their parentSession chain', async () => {
    const { ctx, fiber, sent } = await mountApproval()
    const chat = chatAgent(ctx)
    bindChat(ctx, chat, 'oc_1')

    const child = ctx.sessions.create(SessionId('feishu-child'), { meta: { parentSession: chat.session.id } })
    child.append('turn/start', { turn: 1 })
    const childAgent = { session: child } as unknown as Agent
    ctx.emit('agent/created', { agent: childAgent })

    const pending = ctx.approval.request(requestOf(childAgent))
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    expect(sent[0]!.receiveId).toBe('oc_1')
    await fiber.dispose()
    await expect(pending).resolves.toBe('cancelled')
    await ctx.fiber.dispose()
  })

  it('releases a chat binding when its agent is disposed', async () => {
    const { ctx, fiber, sent } = await mountApproval()
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')
    ctx.emit('agent/disposed', { agent })

    await expect(ctx.approval.request(requestOf(agent))).resolves.toBe('allowed-once')
    expect(sent).toHaveLength(0)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('settles every pending card as cancelled on disposal', async () => {
    const { ctx, fiber, sent, updates } = await mountApproval()
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')

    const pending = ctx.approval.request(requestOf(agent))
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    await fiber.dispose()
    await expect(pending).resolves.toBe('cancelled')
    expect(updates.some(update => update.content.includes('approval channel closed'))).toBe(true)
    await ctx.fiber.dispose()
  })

  it('fails loud at load when the provider cannot receive card actions', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(ApprovalService)
    await ctx.plugin(FeishuRuntime, {})
    ctx.feishu.registerProvider({
      id: 'send-only',
      available: () => true,
      sendMessage: async () => ({ messageId: 'm' }),
    })
    await expect(ctx.plugin(FeishuApproval, {})).rejects.toThrow(
      expect.objectContaining({ code: 'FEISHU_RECEIVE_UNSUPPORTED' }),
    )
    await ctx.fiber.dispose()
  })

  it('loads without a registered provider and opens the tap channel when one registers', async () => {
    const { ctx, fiber, sent, cardHandlers, register } = await mountDeferred()
    expect(cardHandlers).toHaveLength(0)

    register('scripted')
    expect(cardHandlers).toHaveLength(1)

    // The deferred channel serves real approvals: one bound chat agent's ask
    // sends a card, and its Allow tap settles the waterfall.
    const agent = chatAgent(ctx)
    bindChat(ctx, agent, 'oc_1')
    const pending = ctx.approval.request(requestOf(agent))
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    const card = parseCard(sent[0]!)
    cardHandlers[0]!(({
      operatorId: 'ou_1',
      chatId: 'oc_1',
      messageId: 'om_1',
      raw: {},
      value: { action: 'allow', session_id: card.sessionId, nonce: card.allowNonce },
    }))
    await expect(pending).resolves.toBe('allowed-once')
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('fails the registration loudly when a later provider cannot receive card actions', async () => {
    const { ctx, fiber, register } = await mountDeferred()
    expect(() => register('send-only', { cardActions: false })).toThrow(
      expect.objectContaining({ code: 'FEISHU_RECEIVE_UNSUPPORTED' }),
    )
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

  it('reopens the tap channel on the remaining provider when another leaves', async () => {
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

  it('waits for the configured provider when it registers after load', async () => {
    const { ctx, fiber, cardHandlers, register } = await mountDeferred({}, { provider: 'pinned' })
    expect(cardHandlers).toHaveLength(0)

    register('pinned')
    expect(cardHandlers).toHaveLength(1)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('fails loud for a non-positive timeoutMs', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(ApprovalService)
    await ctx.plugin(FeishuRuntime, {})
    ctx.feishu.registerProvider({
      id: 'scripted',
      available: () => true,
      sendMessage: async () => ({ messageId: 'm' }),
      startReceivingCardActions: () => () => {},
    })
    await expect(ctx.plugin(FeishuApproval, { timeoutMs: 0 })).rejects.toThrow(/positive number/)
    await ctx.fiber.dispose()
  })
})
