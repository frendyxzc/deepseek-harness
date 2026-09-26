---
description: "Approve protected tool calls from a Feishu (飞书) chat: Allow/Deny cards in the owning chat, one-time button nonces, fail-closed timeout, cancellation and teardown, and a fallback chat for sessions with no chat binding."
kind: "package-reference"
---

# @deepseek-ai/dsh-feishu-approval

English | [中文](README.zh.md)

## Summary

Approve a protected tool call from your phone. When an agent whose session lives in a Feishu chat — or a subagent under it — needs approval, this package sends an **Allow once** / **Deny** card into that chat and settles the ask from the tapped button. Each button carries a one-time nonce, so a forged value, a tap from another chat, or a replay is rejected without consuming it. Nothing fails open: an unanswered card is denied after `timeoutMs`, and an ended turn cancels the ask. `fallbackChatId` also covers Web GUI, headless, and ACP sessions.

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

Mount this package in the composition that already carries [`@deepseek-ai/dsh-feishu`](../feishu/README.md) and a provider that can receive card taps — in every shipped composition that is [`@deepseek-ai/dsh-feishu-bot`](../feishu-bot/README.md). The [`dsh.setup` Web profile patch](../../../scripts/setup-dsh/templates/profile-web/cordis.patch.yml) mounts it with a five-minute wait and a configured fallback chat.

### When to choose it

Add this package when the person who approves protected operations may be away from the browser and reachable in Feishu. It claims only the asks of sessions bound to a Feishu chat, plus the configured fallback chat, and delegates every other request through the waterfall unchanged, so it composes beside the browser approval surface instead of replacing it. Leave it out when nothing in the composition requires approval, or when a chat's operator must never be able to allow a tool call; then a chat agent's protected calls simply stay unanswered and fail closed.

### Minimal configuration

```yaml
- insert:
    - id: feishu
      name: '@deepseek-ai/dsh-feishu'
    - id: feishu-bot
      name: '@deepseek-ai/dsh-feishu-bot'
    - id: feishu-approval
      name: '@deepseek-ai/dsh-feishu-approval'
      config:
        timeoutMs: 300000
        fallbackChatId: <FEISHU_CHAT_ID>
```

| Field | Default | Meaning |
|---|---|---|
| `timeoutMs` | `60000` | How long one card waits for a tap before the ask is denied automatically; must be a positive finite number |
| `fallbackChatId` | unset | Chat that receives cards for sessions with no Feishu chat binding; must be non-empty when provided, and unset delegates those asks to the next answerer |

Both fields are validated at load: a non-positive or non-finite `timeoutMs`, or an empty `fallbackChatId`, throws and fails this plugin's fiber instead of waiting forever or sending to an unnamed chat. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-feishu-approval) is the exhaustive source for every accepted field.

### Which chat answers

A session belongs to a chat through the `feishu/chat-agent` announcement that [`dsh-feishu-receive`](../feishu-receive/README.md) emits for each per-chat agent, and a subagent inherits that binding from its `parentSession` at `agent/created`, so a whole delegation tree under one chat answers in that chat. A binding is released when its agent is disposed. An ask with no binding goes to `fallbackChatId` when one is configured, and a bound chat always wins over the fallback. The card itself names the tool, the asker's reason capped at 2000 characters, and the session, and it is sent as an `interactive` message to the chat id.

### What a tap does

Both buttons are minted with separate nonces while the card is built, and a tap is checked against its own nonce record — expected action, session id, and owning chat — before that nonce is consumed. A mismatch is rejected and logged, leaving a later legitimate tap intact; a tap after settlement is inert, so one card settles one approval exactly once. An Allow tap answers `allowed-once` and a Deny tap `rejected`. A timeout answers `rejected`, an aborted turn `cancelled`, and disposing this plugin withdraws every live card as `cancelled`. Each settlement replaces the card with its outcome note through the seam's `updateMessage`, and at most 256 cards are live at once, beyond which an ask delegates to the next answerer.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Three maps hold all of this package's state: session id → chat, nonce → pending card, with both buttons of one card pointing at the same record, and the live cards in mint order. None of it is persisted, which is why a restart leaves already-delivered cards inert instead of resuming them.

The tap channel is the feature's precondition. This plugin opens it with `startReceivingCardActions()` as it activates; when no usable provider has registered yet — sibling plugins load concurrently — it logs and waits for `feishu/provider-added`, and a provider that registers but cannot receive card actions fails its own registration loudly. When the channel's provider leaves, the effect reopens on a remaining provider or starts waiting again, and that reopen never throws into the unloading fiber.

Delivery and settlement are ordered so no race loses a decision. The pending record and the answer promise exist before the card is sent, so an abort or teardown during delivery still settles the promise this listener returns; a send failure retires the record and delegates to the next answerer rather than failing the ask closed here. Settlement marks the record settled, frees both nonces, clears the timer and abort listener, resolves exactly once, and repaints the card on a best-effort basis — a failed repaint never reopens a closed decision. Each ask stamps the sole usable provider on the card, so a settling repaint still reaches the delivering app even when sibling fibers tear down in an order nobody guarantees. `approvalCard()` and `noteCard()` are pure builders, and `tappedNonce()` reads only the nonce out of an attacker-controllable value; all three are exported for tests.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config validation, chat bindings, nonce records, tap validation, card builders, and the waterfall listener |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Feishu subsystem](../../../docs/subsystems/feishu.md) — the provider contract, `FeishuCardActionEvent`, and the `FeishuError` codes this consumer drives.
- [Feishu approval cards decision](../../../.agents/notes/implemented/feature/2026-08-18-feishu-approval-cards.md) — why a card tap settles an approval, and what the nonces defend against.
- [Fallback chat decision](../../../.agents/notes/implemented/feature/2026-08-19-feishu-approval-fallback-chat.md) — why sessions with no chat binding can still be approved from Feishu.
- [Approval seam decision](../../../.agents/notes/implemented/feature/2026-07-06-approval-seam.md) — the `approval/request` waterfall and its outcomes.
- [Provider lifecycle events](../../../.agents/notes/implemented/architecture/2026-08-19-feishu-provider-lifecycle-events.md) — the registration events this plugin waits on when no provider exists yet.
- [`@deepseek-ai/dsh-user-approval`](../../interaction/user-approval/README.md) — the service that asks for approval and logs the `approval/asked` / `approval/decided` pair.
- [feishu-receive](../feishu-receive/README.md) — the consumer that announces the chat → agent binding.
- [feishu-question](../feishu-question/README.md) — the sibling answerer for the agent's questions in the same chat.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@deepseek-ai/dsh-user-approval`, whose `ApprovalService` owns the model-facing approval policy text and the `approval/asked` / `approval/decided` audit pair on the requesting session, while this answerer adds no prompt, schema, or log row of its own.

#### KV Cache effect

None from this package: it appends nothing to any session log, and the outcome the model reads comes from the approval service's own audit pair, whose text is the same whichever surface answered.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Settled cards are repainted best-effort** — a failed `updateMessage` leaves the original card in place; both nonces are already consumed, so a late tap stays inert, but the chat can briefly show actionable-looking buttons.
- **At most 256 live cards** — beyond that cap an ask delegates to the next answerer rather than queueing unbounded state; there is no per-chat or per-session quota behind the single global limit.
- **A tap answers for the whole chat** — validation covers the action, the session, and the owning chat, so any member of a group chat who sees the card can settle it; per-operator restrictions are deferred.
- **Nothing survives a restart** — the bindings and pending records are process memory, so disposal cancels every live card and a card already delivered becomes inert.
- **The tap channel needs a receiving provider** — a provider without `startReceivingCardActions` cannot host this plugin, and the failure surfaces as that provider's registration failing at load rather than at the first ask.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published: the nonce → decision relation is private operational state with no authoritative event stream of its own, and the durable `approval/asked` / `approval/decided` pair belongs to `@deepseek-ai/dsh-user-approval`, which asserts it there.

`MAX_PENDING_CARDS` (256) and `MAX_REASON_CHARS` (2000) are fixed safety limits rather than `Config` fields, because raising either changes the failure mode documented above instead of expressing a deployment preference. The provider-removed reopen and the chat-binding tracking deliberately mirror [`feishu-question`](../feishu-question/README.md); each answerer keeps its own lifecycle inline until a third consumer earns a shared seam.

</details>
