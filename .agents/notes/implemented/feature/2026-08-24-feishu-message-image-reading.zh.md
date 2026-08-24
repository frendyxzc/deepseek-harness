# Agent Note: 飞书消息图片读取

Status: implemented

[English](2026-08-24-feishu-message-image-reading.md) | 中文

## 问题

飞书消息中的图片此前只会以文本 `[图片]` 形式到达按聊天划分的 agent——而若该图片是经过 get-message API 读取的（被引用或回复的图片），还会附带飞书的「请升级至最新版本客户端，以查看内容」占位符。模型从未收到过图片字节，因此无法真正读取用户发送的内容。

## 决策

飞书能力 seam 现在端到端地提取并投递图片字节：

- `@deepseek-ai/dsh-feishu` 新增 `FeishuMessageImage`（`{ fileKey }`）与 `FeishuMessageResource`（`{ data }`），新增 `getMessageResource(messageId, fileKey, signal?)` 提供方方法，以及 `FEISHU_RESOURCE_UNSUPPORTED` seam 错误。
- `@deepseek-ai/dsh-feishu-bot` 从 `image`、`post` 与 `interactive` 内容中提取图片 key（即 `FeishuReceiveEvent` 与 `FeishuMessage` 上的 `images`），并通过 `GET /im/v1/messages/:message_id/resources/:file_key?type=image` 下载某张图片的字节。
- `@deepseek-ai/dsh-feishu-receive` 下载入站或被引用消息携带的图片，嗅探其光栅格式（jpeg/png/webp/gif）后逐张保存到 `ctx.attachments`，并把 image 内容块附加到文本之后。被删除或无法识别的图片会被跳过并记入日志——读取图片绝不阻塞投递，纯文本投递仍会带上 `[图片]` 标记。

## 备选方案

- **把 base64 data URI 直接内联进消息、绕过附件存储** —— 已否决：模型图片块承载的是持久的 `ImageAttachmentRef`，附件存储会归一化每张请求图片，并拥有按路由的像素/字节预算；内联会同时绕过两者。
- **只渲染图片 key（不取字节）** —— 已否决：模型仍无法读取图片。
- **通过 `/im/v1/images/:image_key` 下载** —— 已否决：该端点只下载 bot 自己上传的图片；用户消息内的资源应使用消息资源端点，且飞书在那里以 HTTP 400 + `code` 信封报告资源已删除。

## 后果

- 当挂载的附件存储接受该格式时，多模态飞书聊天现在会把用户图片传给模型；纯文本模型仍收到与之前一致的稳定 `[图片]` 标记。
- 图片可用性取决于飞书留存：在再次读取前已被删除的消息图片，会以记入日志的 `FEISHU_PROVIDER_ERROR`（code `14005`，"Resource Has Been Deleted"）呈现，并回退到文本标记。
- seam 的 `verify-type-equiv` 块与三个包的 README 记录了新增的 `images` 字段与 `getMessageResource`；覆盖范围是 `feishu`、`feishu-bot` 与 `feishu-receive` 的单元测试套件。