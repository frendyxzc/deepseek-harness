---
description: "Answer an agent's questions from a Feishu (飞书) chat: one interactive card per ask with one button per option, a one-time card nonce, plan-review cards, and fail-closed timeout, abort, supersede and delivery handling."
kind: "package-reference"
---

# @deepseek-ai/dsh-feishu-question

English | [中文](README.zh.md)

## Summary

Ask the person in a Feishu chat and wait. When an agent bound to a chat calls `ask_user_question` or submits a plan for review, this package sends an interactive card into that chat with one button per option, settles the ask once every question has been tapped, and repaints the card as a question → answer summary. Nothing fails open: an unanswered card rejects `ASK_TIMEOUT`, an ended turn `ASK_ABORTED`, and a new message in that chat `ASK_CANCELLED`. An ask with no Feishu binding delegates unchanged, so non-Feishu sessions keep their existing UI.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package in the composition that already carries [`@deepseek-ai/dsh-feishu`](../feishu/README.md) with a provider that can receive card taps — in every shipped composition that is [`@deepseek-ai/dsh-feishu-bot`](../feishu-bot/README.md) — plus [`@deepseek-ai/dsh-feishu-receive`](../feishu-receive/README.md), which is what binds each chat to an agent, and the `userQuestions` service that [`@deepseek-ai/dsh-user-questions`](../../interaction/user-questions/README.md) provides. The [`dsh.setup` Web profile patch](../../../scripts/setup-dsh/templates/profile-web/cordis.patch.yml) mounts this answerer with its default five-minute wait.

### When to choose it

Add this package when the person an agent must ask is reachable in Feishu rather than in the browser. It claims only asks whose owner agent is bound to a Feishu chat and delegates every other request through the waterfall unchanged, so it composes beside the Web answerer instead of replacing it. Plan reviews ride the same path: `exit_plan_mode` presents the plan through `ctx.userQuestions`, so one mount answers both questions and reviews. Leave it out when nothing in the composition asks the user; an `ask_user_question` call then reports that no answerer accepted the request.

### Minimal configuration

```yaml
- insert:
    - id: feishu
      name: '@deepseek-ai/dsh-feishu'
    - id: feishu-bot
      name: '@deepseek-ai/dsh-feishu-bot'
    - id: feishu-question
      name: '@deepseek-ai/dsh-feishu-question'
      config:
        timeoutMs: 300000
```

| Field | Default | Meaning |
|---|---|---|
| `timeoutMs` | `300000` | How long one card waits for the last required tap before the ask rejects `ASK_TIMEOUT`; must be a positive finite number |

`timeoutMs` is the only field, and it is validated at load: a non-positive or non-finite value throws and fails this plugin's fiber rather than waiting forever. Where the sibling approval answerer offers a `fallbackChatId`, this one deliberately has none — a question is worth asking only in the chat the agent is already talking to. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-feishu-question) is the exhaustive source for every accepted field.

### What the card shows

One card carries the whole ask. Its header reads `The agent has a question`, or `Plan review` in orange when any question carries the plan-review intent. A question's `detail` — the plan markdown itself for a review — renders above the questions capped at 8000 characters, and each question then shows its optional bolded header, its text, and one bullet per option with its description. Every option is a button and the first is styled primary; the v1 card schema has no free-text control, so a question with no options instead renders a note inviting the user to answer in the chat.

### How an ask settles

A card answers one question per tap. The tapped button's `value` echoes the card's nonce, the question id, and the option index, and the tap is checked against that nonce's own record — echoed nonce matched, owning chat, a question that exists on this card, an in-range index — before the answer is recorded. A rejected tap consumes nothing, and re-tapping replaces that question's answer rather than adding a second one, so the ask resolves only once every option-bearing question has an answer. Every other path fails closed: `ASK_TIMEOUT` when the budget expires, `ASK_ABORTED` when the turn's signal aborts, `ASK_CANCELLED` when a new message lands in that chat — plan review reads that code as the user taking the turn back to speak — or when this plugin is disposed, `ASK_UNDELIVERABLE` when the card cannot be sent, and `ASK_BUSY` beyond 256 live cards.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Two maps hold all of this package's state: session id → chat, and card nonce → the live card with the answers accumulated across its taps. None of it is persisted, which is why a restart leaves already-delivered cards inert instead of resuming them.

The card-tap channel and the message channel are the feature's precondition, and they open as a pair: `startReceivingCardActions()` then `startReceiving()`, with the first open rolled back if the second reports that no provider is registered yet. When no usable provider exists as this plugin activates — sibling plugins load concurrently — it logs and waits for `feishu/provider-added`; a provider that registers but cannot receive card actions fails its own registration loudly. When the channels' provider leaves, the effect closes and reopens on a remaining provider or starts waiting again, and that reopen never throws into the unloading fiber. The message channel is what keeps a stale card from outliving the conversation: any new message in a chat supersedes that chat's pending cards.

Ordering protects the decision against races. The pending record and the answer promise exist before the card is sent, and the returned promise carries an interim rejection guard, so an abort, supersede, or teardown during delivery still settles the promise this listener returns. A settlement that beats the send response records its final content and repaints as soon as the message id arrives. Each ask stamps the sole usable provider on the card, so a settling repaint still reaches the delivering app even when sibling fibers tear down in an order nobody guarantees. `questionCard()`, `answerSummaryCard()` and `noteCard()` are pure builders over the v1 schema, and `parseOptionAnswer()` maps an attacker-controllable option index to at most one `{ id, selected: [label] }` record, so a forged or out-of-range index answers nothing; all four are exported for tests.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config validation, chat bindings, card lifecycle, tap and message handling, and the waterfall listener |
| [`src/card.ts`](src/card.ts) | v1 question, answer-summary, and outcome-note card builders |
| [`src/answers.ts`](src/answers.ts) | Pure option-index parsing for one tapped button value |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion reserved for this package, empty with its reason documented |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Feishu subsystem](../../../docs/subsystems/feishu.md) — the provider contract, `FeishuCardActionEvent`, and the receive channels this consumer drives.
- [Question cards decision](../../../.agents/notes/implemented/feature/2026-08-19-feishu-question-cards.md) — why a chat card answers an ask; the Dev Note below flags the parts of that design the source has since replaced.
- [Provider lifecycle events](../../../.agents/notes/implemented/architecture/2026-08-19-feishu-provider-lifecycle-events.md) — the registration events this plugin waits on when no provider exists yet.
- [`@deepseek-ai/dsh-user-questions`](../../interaction/user-questions/README.md) — the service whose `user-questions/request` waterfall this plugin answers.
- [`@deepseek-ai/dsh-tool-ask-user`](../../interaction/tool-ask-user/README.md) — the model-facing tool that asks.
- [`@deepseek-ai/dsh-plan-mode`](../../plan/plan-mode/README.md) — the consumer that presents a plan for review through the same ask.
- [feishu-receive](../feishu-receive/README.md) — the consumer that announces the chat → agent binding.
- [feishu-approval](../feishu-approval/README.md) — the sibling answerer for protected tool calls in the same chat.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@deepseek-ai/dsh-user-questions`, whose `UserQuestionService.ask()` hands the parsed answers to the waiting `ask_user_question` call or plan review exactly as any other answerer's would, while this answerer registers no prompt, schema, or log row of its own.

#### KV Cache effect

None from this package: it appends nothing to any session log, and the answer the model reads is the same `{ id, selected }` record whichever surface collected it, so mounting or removing this answerer changes only where the human is asked.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Settled cards are repainted best-effort** — a failed `updateMessage` leaves the buttons on screen even though the ask has settled; the nonce is gone from the live table, so a late tap is inert but looks unanswered to the chat.
- **At most 256 live cards** — beyond that cap the ask rejects `ASK_BUSY` rather than queueing unbounded state; there is no per-chat or per-session quota behind the single global limit.
- **A tap answers for the whole chat** — validation covers the nonce echo, the owning chat, and the question id, so any member of a group chat who sees the card can settle the ask; per-operator restrictions are deferred.
- **Only taps answer, and only a complete set** — the v1 schema has no text control, so an optionless question cannot be answered from the card, and typing instead supersedes and cancels the ask rather than supplying a `custom` answer.
- **Nothing survives a restart** — the bindings and pending records are process memory, so disposal settles every live card as `ASK_CANCELLED` and a delivered card becomes an orphan.
- **The tap channel needs a receiving provider** — a provider without `startReceivingCardActions` cannot host this plugin, and the failure surfaces as that provider's registration failing at load rather than at the first ask.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This package reserves its invariant companion through `./invariant`, whose installer is empty: the nonce → pending-question relation is private operational state with no authoritative event stream of its own, and answered questions surface through `@deepseek-ai/dsh-user-questions` and the requesting session's tool results.

`MAX_PENDING_QUESTIONS` (256) and `MAX_DETAIL_CHARS` (8000) are fixed safety limits rather than `Config` fields, because raising either changes the failure mode documented above instead of expressing a deployment preference. The provider-removed reopen and the chat-binding tracking deliberately mirror [`feishu-approval`](../feishu-approval/README.md); each answerer keeps its own lifecycle inline until a third consumer earns a shared seam.

Two parts of the [original decision note](../../../.agents/notes/implemented/feature/2026-08-19-feishu-question-cards.md) no longer describe this package: the renderer is the v1 one-button-per-option card in [`src/card.ts`](src/card.ts) rather than a dropdown-and-checkbox form (so `formValue` is never read here), and `user-questions/request` is a plain waterfall in which a claimed ask stops the chain rather than racing the Web answerer. Read the source, not the note, for the card shape and for who answers a given ask.

</details>
