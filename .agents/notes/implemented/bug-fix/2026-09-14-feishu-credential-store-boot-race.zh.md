# Agent Note: 在凭据存储异步加载之前注册的飞书 bot 会以缺失 App Secret 失败

Status: implemented

[English](2026-09-14-feishu-credential-store-boot-race.md) | 中文

## 问题

`dsh-credentials-local` 是异步加载 `.credentials.yaml` 的（在 `Service.init` 里 `await this.loadInitial()`）。`dsh-feishu-bot` 此前只注入 `feishu`，因此 Cordis 可能在该加载完成之前就注册了它的提供方——紧接着 `dsh-feishu-receive` 可能就打开了这些提供方的接收通道。一个 App Secret 只存在 `.credentials.yaml` 里的 bot（例如通过 Settings IM 页新增的 bot）在凭据存储的引用仍为空时去解析凭据，`beginReceiveConnection` 抛出 `FEISHU_PROVIDER_CREDENTIAL_MISSING`，连接从未打开，`status()` 永远钉在 `error`（没有 `onReady` 触发来清 `lastError`）。平铺单应用 bot 之所以幸免，只是因为它的 `FEISHU_APP_SECRET` 走的是同步的 `.env` 回退，而非文件。

## 决策

`dsh-feishu-bot` 在其 `inject` 中声明了 `credentials`（与 `feishu` 并列）。因此 Cordis 会在 `apply` 注册任何提供方之前完成凭据存储的异步加载，每个提供方的启动期凭据解析都会在其引用填充完之后读存储。

## 备选方案

**延迟后重试凭据缺失的接收启动。** 否决：`FEISHU_PROVIDER_CREDENTIAL_MISSING` 也是真实配置错误的信号；重试会掩盖真正缺失的秘密，违反「最早可解决点响亮失败」。

**把初始加载改成同步读。** 否决：在服务构造期做文件 I/O 会阻塞启动 fiber，并放弃文件监听器的热更新契约。

## 影响

- 通过 Settings IM 页新增的 bot——其 secret 由该页写到 `.credentials.yaml` 的 `feishuAppSecretRef(id)` 下——在启动时即解析并连接；之后的一次 Settings 保存会沿同一条路径重新注册它，因此新 bot 无需重启、也无需 `.env` 条目即可生效。
- 该依赖已被所有发布组合满足（base bundle 将 `dsh-credentials-local` 与 `dsh-feishu-bot` 一起挂载）。

## 测试

`packages/feishu/feishu-bot/tests/index.spec.ts` 新增 `declares credentials in its inject so file-backed secrets load before providers register`，钉住 `inject` 契约；已有的 `resolves a named bot App Secret under its per-id reference` 测试继续以凭据存储 mock 启动该插件。