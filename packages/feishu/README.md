# feishu/ — Feishu chat capability family

English | [中文](README.zh.md)

This family provides provider-neutral Feishu (飞书/Lark) chat operations plus the model-facing tools that consume them.

| Package | Role | ctx key |
|---|---|---|
| [`feishu/`](feishu/README.md) | Defines Feishu provider registration, selection, and shared errors | `ctx.feishu` |
| [`feishu-bot/`](feishu-bot/README.md) | Provides Feishu Bot API message sending and webhook receiving | registers on `ctx.feishu` |
| [`tool-feishu/`](tool-feishu/README.md) | Exposes `feishu_send_message` to the model | registers on `ctx.tools` |
| [`feishu-receive/`](feishu-receive/README.md) | Routes incoming Feishu messages to the active agent session | registers on `ctx.feishu` |

The subsystem reference — send-message request/result vocabulary, availability, `FeishuError` — is [docs/subsystems/feishu.md](../../docs/subsystems/feishu.md).