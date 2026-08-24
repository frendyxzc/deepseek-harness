# Agent Note: Feishu referenced card markdown reading

Status: implemented

English | [中文](2026-08-24-feishu-referenced-card-markdown-reading.zh.md)

## Problem

A quoted or replied-to Feishu message that was actually an interactive card built from `tag: "markdown"` components reached the agent only as an image placeholder (`[图片]请升级至最新版本客户端，以查看内容`). The get-message API, called without the card-content hint, returns such a card in its flattened preview form: the markdown element becomes an `img` element plus that placeholder text, and the `img` resource reports "Resource Has Been Deleted" when fetched. The markdown text was never delivered to the model.

## Decision

`@deepseek-ai/dsh-feishu-bot`'s `getMessage` now requests `GET /im/v1/messages/:message_id?card_msg_content_type=user_card_content`, which makes Feishu return the card's original JSON (schema 1.0 or 2.0) instead of the flattened preview. The existing card-text extraction already walks `body.elements` for `tag: "markdown"` components, so a markdown card now resolves to its text; the post-shaped `{ title, elements: [[…]] }` branch stays as the fallback for content that still arrives flattened.

## Alternatives considered

- **Parsing the placeholder image** — rejected: the placeholder `img` resource is deleted server-side, so there is no image to read.
- **Passing a different `card_msg_content_type` value** — rejected: `user_card_content` is the documented value that returns the original card JSON; other values fall back to the preview form.

## Consequences

- Quoted markdown cards now deliver their markdown text to the model instead of `[图片]`; the raw text keeps inline `<at>` mention and `<font>` styling tags, so the model reads the authoring markup rather than a resolved mention name.
- Card message content now arrives as original card JSON (schema 1.0 or 2.0). Consumers reading a card must handle both shapes; the shared `extractCardText` walker already does.
- Coverage: the `feishu-bot` provider suite asserts the `card_msg_content_type=user_card_content` query and that a schema 2.0 markdown card resolves to its text; the package READMEs and the `feishu` subsystem page document the behavior.

## Related

- [`2026-08-24-feishu-message-image-reading`](2026-08-24-feishu-message-image-reading.md) — reading real message images end to end; the same placeholder text motivated that work, but a markdown card is read as text through `user_card_content`, not as an image.