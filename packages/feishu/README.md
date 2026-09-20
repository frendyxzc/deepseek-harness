---
description: "The Feishu chat package group: provider-neutral chat seam, Bot API provider, per-chat agent routing, model-facing chat tools, approval and question cards, and status projection."
kind: "package-group"
---

# feishu/ — Feishu (飞书) chat capability family

English | [中文](README.zh.md)

## Summary

Mount these packages to work with the Harness through Feishu (飞书) chats: an agent reads and answers chat messages, a human approves protected tool calls and answers the agent's questions from a phone, and the Web Settings IM tab shows each bot's connection state. `feishu` owns the provider-neutral seam every other package here uses; `feishu-bot` is the only shipped provider. The rest route chats into agent sessions, expose chat tools to the model, settle approval and question asks, and project status for browser clients.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`feishu`](feishu/README.md) | Provider registry, execution-time provider selection, and the shared `FeishuError` codes |
| [`feishu-bot`](feishu-bot/README.md) | Bot API provider: sends, reads, and updates messages over the Open API, and receives chats and card taps over one long connection |
| [`feishu-receive`](feishu-receive/README.md) | Runs one agent session per chat and delivers its inbound messages, quoted text, and images |
| [`tool-feishu`](tool-feishu/README.md) | Gives the model `feishu_send_message` and `feishu_update_message` with their system-prompt guidance |
| [`feishu-approval`](feishu-approval/README.md) | Settles approval asks from chat agents with Allow/Deny cards in the owning chat |
| [`feishu-question`](feishu-question/README.md) | Answers an agent's questions and plan reviews with tap-to-answer cards in the owning chat |
| [`feishu-status`](feishu-status/README.md) | Projects the seam's connection state to browser clients through two Remote methods |

<a id="related-documentation"></a>
## Related documentation

- [Feishu subsystem](../../docs/subsystems/feishu.md) — the seam's request and result vocabulary, availability rules, and `FeishuError` codes.
- [Feishu capability seam](../../.agents/notes/implemented/feature/2026-08-18-feishu-capability-seam.md) — why chat operations sit behind one provider registry.
- [Long-connection receive](../../.agents/notes/implemented/feature/2026-08-18-feishu-long-connection-receive.md) — receiving inbound events without a public callback URL.
- [Per-chat receive routing](../../.agents/notes/implemented/feature/2026-08-19-feishu-per-chat-receive-routing.md) — one agent session per chat and what that costs.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Only `feishu-bot` speaks the Feishu Open API; every other package in this group reaches chat through `ctx.feishu`. The card answerers treat a tapped button `value` as attacker-controlled and validate it against their own pending records before a one-time nonce is consumed.

</details>
