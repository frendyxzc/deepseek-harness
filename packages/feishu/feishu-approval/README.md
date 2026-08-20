# @deepseek-ai/dsh-feishu-approval

English | [中文](README.zh.md)

Feishu approval-card answerer for the DeepSeek Harness. Settles tool-approval requests from Feishu chat agents through interactive Allow/Deny cards in the owning chat.

## Purpose

Answers the `approval/request` waterfall for every agent bound to a Feishu chat — a per-chat agent announced by [`dsh-feishu-receive`](../feishu-receive/README.md) through the `feishu/chat-agent` event, or a subagent descendant of one, bound through its session's `parentSession` chain at `agent/created`. When an owned agent's tool call needs approval, the plugin sends an interactive card to the owning chat: the tool name, the asker's reason (capped at 2000 characters), and **Allow once** / **Deny** buttons. Each button carries a one-time nonce minted when the card is built; a tap is validated against that nonce's own record — button action, session id, and chat — BEFORE consumption, so a forged value, a tampered session, a tap from another chat, or a replayed nonce is rejected without consuming it. A valid Allow tap resolves the approval `allowed-once`; everything else fails closed: a Deny tap resolves `rejected`, an unanswered card resolves `rejected` after `timeoutMs`, a withdrawn turn resolves `cancelled`, and a plugin disposal withdraws every pending card as `cancelled`. When the card cannot be delivered at all, the ask delegates to the next composed answerer instead of failing here. Every settlement repaints the card with the outcome on a best-effort basis through the seam's `updateMessage`, and the plugin is consulted before any catch-all answerer (it registers `prepend: true`) while delegating every request it does not own through `next()`.

The card tap channel opens on a registered Feishu provider. Sibling plugins load concurrently, so when no usable provider has registered yet, the plugin waits for `feishu/provider-added` and opens the channel then; a provider that registers but cannot receive card actions fails its registration loudly — answering is impossible without the tap channel.

When `fallbackChatId` is configured, approval requests from sessions with no Feishu chat binding — sessions triggered from the Web GUI, headless, or ACP — are answered with a card in that chat too, so a remote operator can approve work that was not triggered through Feishu. A bound chat always wins over the fallback; the fallback card carries the same one-time nonces and settles only from taps inside the fallback chat. Without `fallbackChatId`, unbound approvals delegate to the next composed answerer.

### Configuration

| Field | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `timeoutMs` | `number` | `60000` | How long one approval card waits for a tap before it is denied automatically. Must be a positive finite number. |
| `fallbackChatId` | `string` | unset | Feishu chat that receives approval cards for sessions with no Feishu chat binding (Web GUI, headless, ACP). Omitted = unbound approvals delegate to the next answerer. Must be a non-empty chat id when provided. |

## Dependencies

Requires `ctx.feishu` (the Feishu seam — sends the card, receives card actions, repaints settled cards) and `ctx.approval` (`@deepseek-ai/dsh-user-approval`, whose `approval/request` waterfall this plugin answers). Consumes the `feishu/chat-agent` event declared by `@deepseek-ai/dsh-feishu-receive` and the `agent/created` / `agent/disposed` announcements from `@deepseek-ai/dsh-agent`.

## Model Experience

Indirectly, through `ApprovalService`, which owns the model-facing approval policy text and the durable `approval/asked` / `approval/decided` audit pair on the requesting session, while the answerer itself never adds model-visible content.

#### KV Cache effect

None; the answerer appends nothing to any session log itself.

## Known Limitations and Deferred Work

- **Settled cards are repainted best-effort** — a failed `updateMessage` leaves the original card in place; the nonces are already consumed, so a late tap is still inert, but the chat may briefly show actionable-looking buttons.
- **At most 256 live cards** — an approval ask beyond the cap delegates to the next answerer instead of minting a card.
- **Card taps ride the provider's receive channel** — a provider without `startReceivingCardActions` cannot host this plugin (a registering provider fails loud when the tap channel opens); the long-connection provider shares ONE connection between message and card-action subscribers.
