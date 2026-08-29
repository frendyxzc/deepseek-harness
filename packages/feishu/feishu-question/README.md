# @deepseek-ai/dsh-feishu-question

English | [中文](README.zh.md)

Feishu question-card answerer for the DeepSeek Harness. Answers user-questions asks from Feishu chat agents through interactive form cards in the owning chat.

## Purpose

Answers the `user-questions/request` waterfall for every ask whose owner agent is bound to a Feishu chat — a per-chat agent announced by [`dsh-feishu-receive`](../feishu-receive/README.md) through the `feishu/chat-agent` event, or a subagent descendant of one, bound through its session's `parentSession` chain at `agent/created` — and renders it as an interactive form card: one question per section with a lark_md title, a dropdown for single-select questions, one checkbox per option for multi-select, and a free-text input on every question so the human can always type instead of choosing. Plan-mode reviews (`intent: plan-review`) ride the same flow with an orange "Plan review" header and the plan detail in the card body.

Each card carries a one-time nonce minted when the card is built, embedded in the submit button's `value`; a submission is validated against that nonce's own record — the echoed nonce, and the chat the card was sent to — BEFORE consumption, so a forged value, a tampered echo, or a tap from another chat is rejected without consuming the nonce. Free text wins over a selection on the same question; an empty submission consumes nothing and leaves the card open for another attempt. A valid submission resolves the ask with the parsed answers and repaints the card as a question → answer summary; everything else fails closed: an unanswered card rejects `ASK_TIMEOUT` after `timeoutMs`, a withdrawn turn rejects `ASK_ABORTED`, a new message from the same chat supersedes every pending card of that chat with `ASK_CANCELLED` (plan mode reads that as "the user spoke instead — stay in plan mode"), and a plugin disposal settles every pending card as `ASK_CANCELLED`. The pending registry is registered before the card is sent, so a callback that races delivery is never lost; at most 256 cards are live at once, beyond which the ask rejects `ASK_BUSY`. The answerer is consulted before any catch-all answerer (it registers its `user-questions/request` listener with `prepend: true`), so a Feishu-bound ask is claimed here and answered from the chat card; an ask this answerer does not accept — no Feishu binding for the owner agent — is delegated through `next()` unchanged, so non-Feishu sessions keep their existing UI without configuration.

The card tap channel and the message channel open on a registered Feishu provider. Sibling plugins load concurrently, so when no usable provider has registered yet, the plugin waits for `feishu/provider-added` and opens both channels then; a provider that registers but cannot receive card actions fails its registration loudly — answering is impossible without the tap channel.

### Configuration

| Field | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `timeoutMs` | `number` | `300000` | How long one question card waits for a submission before it is rejected automatically. Must be a positive finite number. |

## Dependencies

Requires `ctx.feishu` (the Feishu seam — sends the card, receives card actions and messages, repaints settled cards) and `ctx.userQuestions` (`@deepseek-ai/dsh-user-questions`, whose `user-questions/request` waterfall this plugin answers). Consumes the `feishu/chat-agent` event declared by `@deepseek-ai/dsh-feishu-receive` and the `agent/created` / `agent/disposed` announcements from `@deepseek-ai/dsh-agent`.

## Model Experience

Indirectly, through the parsed answers the answerer returns to `UserQuestionService.ask()`, which delivers them to the waiting `ask_user_question` tool call or plan-mode review exactly like any other answerer's answer.

#### KV Cache effect

None; the answerer appends nothing to any session log itself.

## Known Limitations and Deferred Work

- **Settled cards are repainted best-effort** — a failed `updateMessage` leaves the original card in place; the nonce is already consumed, so a late submission is still inert, but the chat may briefly show actionable-looking controls.
- **At most 256 live cards** — an ask beyond the cap rejects `ASK_BUSY`.
- **Group chats validate only chat + nonce** — anyone in the owning chat can answer a card; per-operator restrictions are deferred.
- **Pending cards do not survive a restart** — a process restart disposes the plugin, settling every pending card as `ASK_CANCELLED`; the Feishu cards become inert orphans.
- **Card taps ride the provider's receive channel** — a provider without `startReceivingCardActions` cannot host this plugin (a registering provider fails loud when the tap channel opens); the long-connection provider shares ONE connection between message and card-action subscribers.
