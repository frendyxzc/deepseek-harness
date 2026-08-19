# Agent Note: Feishu approval fallback chat — answering approvals from non-Feishu-triggered sessions

Status: implemented

English | [中文](2026-08-19-feishu-approval-fallback-chat.zh.md)

## Problem

[The approval-cards decision](2026-08-18-feishu-approval-cards.md) ties answering to Feishu chat bindings: `dsh-feishu-approval` claims approval requests only from agents announced through `feishu/chat-agent` and their subagent descendants, delegating everything else through `next()`. Sessions triggered elsewhere — the Web GUI, headless runs, ACP automation — carry no binding, so their approvals reach only the local answerer. An operator working from a Feishu chat cannot approve them: a plugin installation triggered from the Web GUI raised permission approvals that never reached the Feishu chat the operator was watching.

## Decision

`dsh-feishu-approval` takes an optional `fallbackChatId` config field. Chat resolution per approval request is a fixed order: the agent session's bound chat wins; else the configured fallback chat; else no chat, and the ask delegates through `next()`. A fallback card is identical to an owning-chat card — same one-time nonces, same tap validation (the chat check binds taps to the fallback chat), same timeout, abort, disposal, and undeliverable-card delegation — so the routing change adds no settlement path. An empty `fallbackChatId` fails loud at load, matching the `timeoutMs` validation.

## Alternatives considered

**Broadcast to every chat the receive router has seen.** Rejected: the router knows only chats that sent a message — a fresh process knows none, exactly when approvals matter — and duplicated cards across chats multiply the tap surface for one decision.

**Forward unbound approvals from the Web GUI answerer.** Rejected: couples the Web host to Feishu transport; the answerer chain is the extension point, and routing config on the Feishu consumer keeps the seam provider-swappable.

**Bind non-Feishu sessions to a chat at creation.** Rejected: `chatBySession` describes where a session runs; binding a Web GUI or ACP session to a chat would misrepresent routing to every consumer of `feishu/chat-agent`.

## Consequences

- One config field routes every tool approval — Web GUI, headless, and ACP sessions included — to a Feishu chat; omitting it preserves delegation to the next answerer.
- Tap validation keeps its chat check: a fallback card settles only from taps inside the fallback chat.
- The fallback chat decides for sessions it did not trigger; the card's session id, tool name, and reason are the only context it receives.
