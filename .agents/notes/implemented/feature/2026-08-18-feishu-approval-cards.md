# Agent Note: Feishu approval cards — remote tool approval for Feishu chat agents

Status: implemented

English | [中文](2026-08-18-feishu-approval-cards.zh.md)

## Problem

`dsh-feishu-receive` runs each Feishu chat as its own agent session, but those sessions have no local human at the terminal: when a tool call needs approval, the `approval/request` waterfall has no answerer that can reach the remote operator, so the request fails closed to `unavailable` and every protected tool blocks. The community reference [wz-heng/dsh-feishu-bridge](https://github.com/wz-heng/dsh-feishu-bridge) solved this with Feishu interactive cards; this note ports that mechanism onto the harness's own capability seams instead of an out-of-process bridge.

## Decision

The mechanism spans three existing seams plus one new consumer package:

- **Feishu seam (`dsh-feishu`)** gains a card-action face: `FeishuCardActionEvent` (operator open id, chat id, message id, and the tapped button's `value` — attacker-controllable card data passed through unvalidated), `ctx.feishu.startReceivingCardActions(handler)`, and `ctx.feishu.updateMessage(messageId, content, signal?)`. A provider without either capability raises `FEISHU_RECEIVE_UNSUPPORTED` / `FEISHU_UPDATE_UNSUPPORTED`.
- **The long-connection provider (`dsh-feishu-bot`)** registers `card.action.trigger` on the same `EventDispatcher` as `im.message.receive_v1`: message and card-action subscribers share ONE WS connection (first subscriber opens it, last disposer closes it), and `updateMessage` PATCHes `/im/v1/messages/:message_id`.
- **`dsh-feishu-receive`** emits the `feishu/chat-agent` event (`{ agent, chatId }`) whenever it publishes a per-chat agent, so consumers bind to the live chat ↔ agent routing without re-deriving it.
- **`dsh-feishu-approval`** answers `approval/request` with `prepend: true` for every bound agent — a per-chat agent from that event, or a subagent descendant bound through its session's `parentSession` chain at `agent/created`. It sends an interactive card (tool name, truncated reason, **Allow once** / **Deny** buttons) to the owning chat, mints one-time nonces per button, and validates a tap against that nonce's own record — button action, session id, chat — before consuming it, so forged values, tampered sessions, cross-chat taps, and replayed nonces are rejected without consuming. A valid Allow resolves `allowed-once`; everything else fails closed: Deny → `rejected`, unanswered after `timeoutMs` (default 60 s) → `rejected`, withdrawn turn → `cancelled`, plugin disposal → every pending card settles `cancelled`. An undeliverable card delegates to the next answerer via `next()` rather than failing. Settlement repaints the card best-effort through `updateMessage`. The plugin opens its tap channel when a usable provider registers and fails that registration loudly when the provider cannot receive card actions ([provider-lifecycle events](../architecture/2026-08-19-feishu-provider-lifecycle-events.md)). A configured `fallbackChatId` extends answering to sessions with no Feishu chat binding ([fallback chat](2026-08-19-feishu-approval-fallback-chat.md)).

## Alternatives considered

**Keep the out-of-process Python bridge.** Rejected: it duplicates transport, credentials, and agent routing outside the harness and cannot observe session lifecycle; the card-action channel rides the same long connection the receive router already opens.

**Approve by typed chat command (e.g. `approve`).** Rejected: plain-text commands race the conversation, need sender attribution the router does not carry, and offer no atomic one-tap semantics; card buttons carry their own nonce and settle in one callback.

**Durable pending-approval storage.** Rejected: a pending card is transient by nature — a restart cannot re-render a live card into a new chat state — and the durable audit pair (`approval/asked` / `approval/decided`) already belongs to `dsh-user-approval` on the requesting session.

**Let `dsh-feishu-receive` own approval itself.** Rejected: the receive router's job is chat ↔ agent routing; approval is a separate consumer that binds through the published `feishu/chat-agent` event, and the seam stays provider-swappable.

## Consequences

- Unattended Feishu chats can approve protected tools remotely with one tap; absence, timeout, withdrawal, and delivery failure all fail closed (deny or delegate), never allow.
- Card taps share the message long connection — no second connection, no public callback URL.
- Settlement repaints are best-effort: a failed `updateMessage` leaves the original card visible, but consumed nonces make late taps inert.
- Pending approvals live in memory and settle `cancelled` on disposal; a restart withdraws them rather than resurrecting stale cards.
