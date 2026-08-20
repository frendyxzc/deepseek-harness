# Agent Note: Feishu question cards — interactive answers and prompt feedback for Feishu chat agents

Status: implemented

English | [中文](2026-08-19-feishu-question-cards.zh.md)

## Problem

`dsh-feishu-receive` runs each Feishu chat as its own agent session with no local human at the terminal: `ask_user_question` asks (and plan-mode reviews, which ride the same seam) have no answerer that can reach the remote operator, so the ask falls through to whatever default provider the Web host registers — the wrong surface for a chat-only session. Separately, a chat user who messages the bot gets no feedback until the agent's first `feishu_send_message` lands, and a corrected reply costs a duplicate message instead of an edit. The spring-agent reference implementation solved both with Feishu form cards and reply-card updates; this note ports the mechanisms onto the harness's own seams, without its persistence-and-restart model.

## Decision

Two seam extensions plus one new consumer package, and two immediate-feedback behaviors:

- **Feishu seam (`dsh-feishu`)** gains `FeishuCardActionEvent.formValue` — the submitted form controls' values, present when the tapped action submitted a card form, attacker-controllable with the same validation obligation as `value`. `dsh-feishu-bot` passes `action.form_value` through when it is a plain object. Multi-select, free text, and multi-question submissions all ride one form submit.
- **User-questions seam (`dsh-user-questions`)** gains routed answerers: an optional `accepts(request)` predicate makes a provider a routed answerer; `ask()` offers a request to every routed answerer whose predicate accepts it and to the single default provider, and the first human answer wins — the remaining offers are withdrawn through a derived abort signal. Providers without a predicate keep competing for the one default slot (`DUPLICATE_PROVIDER` unchanged), so the Web apiproxy provider needed zero changes: a Feishu-bound ask reaches both the chat card and the Web UI, and either surface can settle it.
- **`dsh-feishu-question`** registers a routing provider that claims every ask whose owner agent is bound to a Feishu chat — a per-chat agent announced through `feishu/chat-agent`, or a subagent descendant bound through its session's `parentSession` chain at `agent/created` — and renders it as an interactive form card: single-select dropdowns, one checkbox per multi-select option, and a free-text input on every question. The pending entry is registered BEFORE the card is sent (a callback racing delivery is never lost); the submit button carries a one-time nonce, and a submission is validated against that nonce's own record — echoed nonce, owning chat — before consumption, so forged values, cross-chat taps, and replays are rejected without consuming. Free text wins over a selection; an empty submission keeps the card open. A valid submission resolves the ask and repaints the card as a question → answer summary; everything else fails closed: unanswered after `timeoutMs` (default 300 s) → `ASK_TIMEOUT`, withdrawn turn → `ASK_ABORTED`, a new message from the same chat supersedes every pending card of that chat with `ASK_CANCELLED` (plan mode reads that as "the user spoke instead — stay in plan mode"), plugin disposal → every pending card settles `ASK_CANCELLED`. An ask this router does not accept — no Feishu binding for the owner agent — reaches the default provider alone, so non-Feishu sessions keep their existing UI without configuration; a Feishu-bound ask races the default provider, so the human can answer from either the chat card or the Web UI. Element names derive from the nonce prefix so a re-ask never collides with Feishu's unique control-id constraint.
- **`dsh-feishu-receive` ack**: every incoming chat message gets a short acknowledgement ("已收到，正在处理…") before the per-chat agent starts; `ack` defaults to true and a failed send only logs — delivery never depends on it.
- **`dsh-tool-feishu` update tool**: `feishu_update_message(messageId, content)` wraps `ctx.feishu.updateMessage` (registered alongside `feishu_send_message`, `update` defaults to true), and its system-prompt section instructs the model to revise a previous reply by updating the original message instead of resending.

## Alternatives considered

**Port spring-agent's persistence + run-restart model.** Rejected: the harness keeps one live agent per chat in-process; the ask promise settles when the card callback arrives, so there is no pending question to persist or run to restart. Pending cards settle `ASK_CANCELLED` on disposal; a restart leaves inert orphan cards instead of resurrecting stale questions.

**One button per option (approval-card style).** Rejected: multi-select and free text need a form anyway, multi-question asks need one submit, and `form_value` delivers all of it in one callback; buttons cannot express a typed answer.

**A single default user-questions provider chosen per host.** Rejected: a Web host needs the apiproxy default AND the Feishu answerer at once — `accepts` admits both and `ask()` races them, with the default slot's uniqueness preserved.

**cardkit streaming reply cards.** Deferred: whole-card `updateMessage` replacement approximates the progress experience for v1; streaming cards are a later round.

## Consequences

- Unattended Feishu chats answer `ask_user_question` and plan-mode reviews remotely through form cards; absence, timeout, withdrawal, supersede, and delivery failure all fail closed, and an unbound session silently keeps its default provider.
- A session reachable from both Feishu and the Web UI shows each ask in both surfaces; the first human answer settles it, and the other offer is withdrawn through the derived abort signal.
- Chat users get immediate feedback on every message and see corrections land in place instead of as duplicate messages.
- Group chats validate only chat + nonce — anyone in the owning chat can answer; per-operator restrictions are deferred.
- The `formValue` seam field is generic: any future card consumer can build forms without another seam change.
