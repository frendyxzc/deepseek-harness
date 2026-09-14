# Agent Note: 命名的飞书 bot 解析到了扁平单应用的 secret，而不是它自己的 per-id 引用

Status: implemented

[English](2026-09-14-feishu-named-bot-secret-ref.md) | 中文

## 问题

当组合里的 `credentials` 列表为空时（`botId === ... || config.credentials === undefined || config.credentials.length === 0`），`credentialFor` 会给每个 bot 都返回扁平的字段。由于 `Config` schema 把 `appSecretEnv` 默认为 `FEISHU_APP_SECRET`，一个命名 bot 会解析到这个扁平默认的 `appSecretEnv`，从而永远无法落到它自己的 per-id 引用。于是 `qa` 用扁平应用的 secret 去鉴权，报 `app secret invalid`，`status()` 被钉在 `error`，而正确存储的 `FEISHU_APP_SECRET_QA` 从未被读取。

## 决策

`credentialFor` 只对扁平单应用 provider id（`FEISHU_BOT_PROVIDER_ID`）返回扁平字段。没有匹配 `credentials` 条目的命名 bot 落到空，于是 `resolveOptions` 按 `feishuAppSecretRef(botId)` 派生其 App Secret——正如该函数的契约本来写的那样。

## 备选方案

**移除 `appSecretEnv` / `appIdEnv` 的 schema 默认值。** 否决：扁平单应用路径依赖这些默认值，去掉会破坏扁平 provider 的常规 `FEISHU_APP_SECRET` 解析。

**对字面 App ID 恰好等于扁平 `FEISHU_APP_ID` 的 bot 做特判。** 否决：这又引入一条「此 bot 即扁平应用」的隐式规则，而 per-id 派生无需隐藏匹配即已表达该语义。

## 影响

- 命名 bot 会在 `FEISHU_APP_SECRET_<ID>` 下解析自己的 secret，与 Settings IM 页及 `feishuAppSecretRef` 契约一致。
- 之前是扁平单应用（其 App ID 等于 `FEISHU_APP_ID`）的 bot，现在必须把 secret 存到自己的 per-id 引用（`FEISHU_APP_SECRET_<ID>`）下，而非扁平的 `FEISHU_APP_SECRET`。

## 测试

`packages/feishu/feishu-bot/tests/index.spec.ts` 以 `qa` bot 且无 `credentials` 列表启动插件，断言 `status()` 解析 `FEISHU_APP_SECRET_QA`，而绝不解析扁平的 `FEISHU_APP_SECRET`。