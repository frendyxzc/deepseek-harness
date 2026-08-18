# Agent Note：飞书接收路由 —— 每个聊天一个 agent 会话

Status: implemented

[English](2026-08-19-feishu-per-chat-receive-routing.md) | 中文

## 问题

`dsh-feishu-receive` 把每条收到的飞书消息都投递给 `agents.roots()[0]` —— 第一个 root agent —— 因此所有聊天的消息共享同一段对话与历史。多聊天 bot 需要隔离：每个聊天的线程必须映射到各自的会话，且同一个聊天必须始终回到同一个会话。

## 决策

`dsh-feishu-receive` 维护一份内存中 chat_id → 会话映射。某个聊天首次发来消息时，创建一个专属 root agent，运行活跃会话的 preset —— 其中包含 `dsh-tool-feishu`，因此该 agent 能在自己的聊天里回复 —— 并继承活跃会话的模型路由与 `cwd`，使循环注册的 `{{model}}`/`{{provider}}`/`{{cwd}}` 提示词变量在其 persona 组装时都能解析。每个聊天的会话 id 都是全新的 `feishu-<uuid>`；聊天 → 会话的对应关系只存在于内存映射里，因此同一个聊天在进程内复用同一段会话，重启后则重新开始（不做跨重启恢复）。同一聊天的后续消息复用缓存的 agent；同时缓存创建中的 promise，从而并发到达的首条消息不会铸造重复的 agent。每个创建的 agent 都随消费方的 fiber 一并销毁。

## 备选方案

**保持单 agent 扇入到 `roots()[0]`。** 否决：所有聊天在同一会话里交织，无法按聊天隔离。

**静态 `chatSessions` 配置映射。** 否决：要求运维手工罗列每个聊天后才能路由；自动创建更贴合「建立 chat_id → session 映射」的意图，无需手工清单。

**在既有 root agent 之间轮询。** 否决：丢失了让某个聊天历史保持连贯的稳定聊天 → 会话身份。

**确定性 `feishu:<chatId>` id + 跨重启恢复（`ctx.agents.resume`）。** 否决：恢复进程内创建的会话不是稳定契约 —— 恢复出的 agent 被报告为活跃但不再处理新的 follow-up，导致重启后对话停滞。每次进程都用全新会话 id 可避开 id 碰撞，且与 `dsh-feishu-bridge` 参考实现的模型一致（粘性内存映射、不做跨重启恢复）。

## 后果

- 每个飞书聊天运行各自的 agent 会话与历史，且该 agent 的回复通过 `dsh-tool-feishu` 返回同一个聊天。
- 聊天 → 会话的对应关系是进程本地的，且每个会话 id 都是全新 UUID，因此重启 harness 后每个聊天都会以新的会话开始（历史不跨重启保留）。
- 注入的消息只携带文本内容；不标注是哪位群成员发送的（按发送者归属被推迟）。