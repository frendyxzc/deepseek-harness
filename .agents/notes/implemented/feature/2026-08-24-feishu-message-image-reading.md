# Agent Note: Feishu message image reading

Status: implemented

English | [中文](2026-08-24-feishu-message-image-reading.zh.md)

## Problem

An image in a Feishu message reached the per-chat agent only as the text `[图片]` — and, when the image was read through the get-message API (a quoted or replied-to image), as Feishu's `请升级至最新版本客户端，以查看内容` placeholder beside it. The model never received the image bytes, so it could not read what the user sent.

## Decision

The Feishu capability seam now extracts and delivers image bytes end to end:

- `@deepseek-ai/dsh-feishu` adds `FeishuMessageImage` (`{ fileKey }`) and `FeishuMessageResource` (`{ data }`), a `getMessageResource(messageId, fileKey, signal?)` provider method, and the `FEISHU_RESOURCE_UNSUPPORTED` seam error.
- `@deepseek-ai/dsh-feishu-bot` extracts image keys from `image`, `post`, and `interactive` content (`images` on `FeishuReceiveEvent` and `FeishuMessage`), and downloads one image's bytes through `GET /im/v1/messages/:message_id/resources/:file_key?type=image`.
- `@deepseek-ai/dsh-feishu-receive` downloads the images carried by an inbound or referenced message, saves each to `ctx.attachments` after sniffing its raster format (jpeg/png/webp/gif), and appends image content blocks after the text. A deleted or unrecognized image is skipped and logged — reading an image never blocks delivery, and text-only delivery still carries the `[图片]` marker.

## Alternatives considered

- **Inlining a base64 data URI** into the message and bypassing the attachment store — rejected: model image blocks carry durable `ImageAttachmentRef`s, and the attachment store normalizes each request image and owns the per-route pixel/byte budgets; inlining would bypass both.
- **Rendering only the image key** (no bytes) — rejected: the model would still not be able to read the image.
- **Downloading through `/im/v1/images/:image_key`** — rejected: that endpoint downloads only bot-uploaded images; a resource inside a user message uses the message-resource endpoint, and Feishu reports a deleted resource there with an HTTP 400 + `code` envelope.

## Consequences

- Multimodal Feishu chats now pass user images to the model when the mounted attachment store accepts the format; text-only models still receive the stable `[图片]` marker, unchanged from before.
- Image availability depends on Feishu retention: a message image deleted before it is read again surfaces as a logged `FEISHU_PROVIDER_ERROR` (code `14005`, "Resource Has Been Deleted") and degrades to the text marker.
- The seam's `verify-type-equiv` blocks and the three package READMEs document the new `images` fields and `getMessageResource`; coverage is the `feishu`, `feishu-bot`, and `feishu-receive` unit suites.