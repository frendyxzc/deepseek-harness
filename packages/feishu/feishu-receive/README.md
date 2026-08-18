# @deepseek-ai/dsh-feishu-receive

English | [中文](README.zh.md)

Feishu message receive consumer for the DeepSeek Harness. Routes incoming Feishu webhook events into the active agent session.

## Purpose

Starts the `ctx.feishu` receive channel and injects each received message as a user follow-up to the first root agent, so the agent can receive and respond to messages sent to the Feishu bot.

## Dependencies

Requires `ctx.feishu` (the Feishu seam), `ctx.agents` (the agent registry), and `ctx.webServer` (the web server the provider registers its webhook route on) to be present in the composition. The web-server dependency also orders startup: the receive channel starts only after the web server exists, and a composition without one fails activation instead of silently not receiving.

## Model Experience

Indirectly, through the user messages it injects into the session log. The consumer itself registers no prompt or schema content.

#### KV Cache effect

No direct invalidation; injected messages follow the session log's append-only semantics.

## Known Limitations and Deferred Work

- **Single-agent routing** — only the first root agent receives messages, via `followup` (delivery wakes an idle agent). Routing by chat or sender to a specific agent is deferred.
- **No message filtering** — all received text messages are injected; filtering by chat_id or sender is deferred.