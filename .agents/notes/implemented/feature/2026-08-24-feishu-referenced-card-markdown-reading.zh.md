# Agent Note：飞书被引用卡片的 markdown 读取

Status: implemented

[English](2026-08-24-feishu-referenced-card-markdown-reading.md) | 中文

## 问题

一条被引用或回复的飞书消息，实际是由 `tag: "markdown"` 组件构成的交互卡片，却只以图片占位（`[图片]请升级至最新版本客户端，以查看内容`）到达 agent。未带卡片内容提示调用 get-message API 时，这类卡片会被返回为扁平化预览——markdown 元素变成 `img` 元素加那段占位文本，且该 `img` 资源在拉取时上报 "Resource Has Been Deleted"。markdown 文本从未送达模型。

## 决策

`@deepseek-ai/dsh-feishu-bot` 的 `getMessage` 现请求 `GET /im/v1/messages/:message_id?card_msg_content_type=user_card_content`，使飞书返回卡片发送时的原始 JSON（1.0 或 2.0 版）而非扁平化预览。既有的卡片文本提取已遍历 `body.elements` 取 `tag: "markdown"` 组件，因此 markdown 卡片现按其文本读取；`{ title, elements: [[…]] }` 扁平化分支保留，作为仍以扁平形式到达内容的回退。

## 备选方案

- **解析占位图片** —— 拒绝：占位 `img` 资源已在服务端删除，没有图片可读。
- **传其他 `card_msg_content_type` 取值** —— 拒绝：`user_card_content` 是返回原始卡片 JSON 的文档化取值，其他取值回退到预览形式。

## 后果

- 被引用的 markdown 卡片现把 markdown 文本送达模型，而非 `[图片]`；原始文本保留 `<at>` 提及与 `<font>` 样式标签，因此模型读到的是创作 markup 而非解析后的提及名。
- 卡片消息内容现以原始卡片 JSON（1.0 或 2.0 版）返回。读取卡片的消费方需同时处理两种结构；共享的 `extractCardText` 遍历器已如此。
- 覆盖：`feishu-bot` 提供方测试套件断言 `card_msg_content_type=user_card_content` 查询及 schema 2.0 markdown 卡片解析为文本；包 README 与 `feishu` 子系统页记录了该行为。

## 相关

- [`2026-08-24-feishu-message-image-reading`](2026-08-24-feishu-message-image-reading.zh.md) —— 端到端读取真实消息图片；同一段占位文本推动了那项工作，但 markdown 卡片应通过 `user_card_content` 读作文本，而非当作图片。