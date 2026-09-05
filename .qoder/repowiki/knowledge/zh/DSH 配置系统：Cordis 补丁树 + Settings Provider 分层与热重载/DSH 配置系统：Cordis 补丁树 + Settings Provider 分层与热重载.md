---
kind: configuration_system
name: DSH 配置系统：Cordis 补丁树 + Settings Provider 分层与热重载
category: configuration_system
scope:
    - '**'
source_files:
    - apps/cli/src/profile-boot.ts
    - apps/cli/src/dump-config.ts
    - packages/settings/settings/src/index.ts
    - packages/settings/settings-file/src/index.ts
    - packages/credentials/credentials-local/src/index.ts
    - scripts/gen-config-catalog.ts
    - docs/config-catalog.md
    - apps/cli/config/examples/cordis/cordis.yml
---

## 1. 系统概览

DeepSeek Harness 的配置体系由两条正交通道组成：

- **启动期配置（Composition / Cordis）**：通过 `cordis.yml` 根文件 + 多层 `cordis.patch.yml` 补丁，以声明式方式装配插件、服务与能力缝。加载器按固定优先级把多个补丁层叠加成最终树，再交给 Cordis 运行时挂载。
- **运行期用户设置（Settings Provider）**：通过 `ctx.settings` 抽象出可插拔的存储后端（默认是 YAML/JSON 文件），每个插件注册一个命名空间 schema，值按「schema 默认 → 组合 base → 用户文档」三层合并，支持增量 patch、replace、path mutate、watch 以及跨进程原子写与热重载。

两套系统都围绕 `$DSH_HOME`（或 `~/.dsh`）组织持久化文件，并通过 schemastery schema 做运行时校验，通过生成脚本保证文档与代码一致。

## 2. 关键文件与包

| 职责 | 关键路径 | 说明 |
|---|---|---|
| CLI Profile 装配 | `apps/cli/src/profile-boot.ts` | 解析 profile、写出空根 `cordis.yml`、组装 bundle / profile / home / overlay 四层补丁栈，注入 `DSH_TELEMETRY_DISABLED` 开关 |
| 配置 dump | `apps/cli/src/dump-config.ts` | 不启动进程，仅组合补丁层并输出带注释的完整配置树 |
| 用户设置核心 | `packages/settings/settings/src/index.ts` | `SettingsProvider` 抽象、命名空间注册、三层合并、序列化写队列、revision 冲突检测、`settings/updated` 事件 |
| 文件型设置后端 | `packages/settings/settings-file/src/index.ts` | `FileSettingsProvider`，读写 `<harness home>/settings.yaml`，chokidar 监听外部编辑，comment-preserving YAML diff 写回 |
| 凭据存储 | `packages/credentials/credentials-local/src/index.ts` | 基于 `$DSH_HOME/.credentials.yaml` 的多层凭据解析（进程环境 > 托管文件 > `.env`），严格权限检查与原子写 |
| 配置目录清单 | `docs/config-catalog.md` | 由 `scripts/gen-config-catalog.ts` 从各包入口类型与 schemastery schema 自动生成，验证 schema 键与声明类型一一对应 |
| 示例配置 | `apps/cli/config/examples/*/cordis.yml` | 各场景的 Cordis 根配置样例 |

## 3. 架构与约定

### 3.1 Cordis 补丁树（启动期）

- 每个 profile 目录下存在一个空根 `cordis.yml`（由 `prepareProfile` 写入），所有实际配置都以补丁形式叠加。
- 补丁应用顺序固定为：**bundle 层**（来自 `package.json` 的 `dsh.profile.bundles`）→ **profile 自身层**（`cordis.patch.yml`）→ **home 层**（`$DSH_HOME/cordis.patch.yml`，机器级覆盖）→ **overlay 层**（`--patch <file>` 命令行传入）→ 最后可选地插入 `DSH_TELEMETRY_DISABLED` 开关。
- 该顺序意味着 home 层总是高于 profile 层，overlay 又高于 home，从而支持“部署基线 → 用户偏好 → 单次覆盖”的分层策略。
- `dump-config` 命令复用同一套 `loadOptionalPatches` / `loadOverlayPatches` / `renderConfigDump` 逻辑，在不启动 Cordis 的情况下打印完整配置树，便于诊断。

### 3.2 Settings Provider（运行期）

- 每个插件通过 `settings.register(ns, schema, { base, applies, validate })` 声明一个命名空间；schema 使用 schemastery 定义，`base` 是组合层默认值，用户文档中的同名 section 覆盖它。
- 值解析顺序固定为：`schema defaults` → `base` → `user section`，结果被 `deepFreeze` 后暴露给消费者，防止下游修改。
- 写操作分三种：`update`（merge）、`replace`（整段替换）、`mutate`（path ops），全部经过 JSON 形状校验（拒绝 Date/Map/BigInt/循环引用/非有限数等），然后串行写入当前命名空间的写队列，避免并发覆盖。
- 写成功后调用 provider 的 `persist` 持久化，再 bump revision、触发 watcher 回调和 `settings/updated` 事件；读侧通过 `expectedRevision` 实现乐观锁冲突（`SettingsConflictError`）。
- 默认后端 `FileSettingsProvider` 将每个 namespace 作为顶层 key 写入单个 YAML/JSON 文档，使用 chokidar 监听外部编辑，并以 comment-preserving 的 YAML diff 写回，保留用户注释。
- 提供 `installSettingsSection(ctx, ns, schema, entry, hooks)` 辅助函数，让消费方在 settings 服务存在时挂接、不存在时回退到组合 entry，且能感知 attach/detach/change。

### 3.3 凭据分层

`credentials-local` 显式定义了四层信任链：

```
inherited process environment (read-only, wins)
> $DSH_HOME/.credentials.yaml      (provider-managed, writable)
> <invocation cwd>/.env            (read-only fallback)
> $DSH_HOME/.env                   (read-only fallback)
```

- 进程环境变量最高优先，不可被内部写回覆盖，因此 CI secret 或容器 `-e` 始终生效。
- 托管文件是唯一可写的凭据源，每次写都通过 `withFileLock` 加跨进程写锁，再 read-modify-write 只改目标 key，保留其余格式。
- 文件创建/替换时使用 `0600`，并在 POSIX 上强制校验 group/other 位为 0，否则直接报错。

### 3.4 配置文档与 schema 一致性保障

- `scripts/gen-config-catalog.ts` 扫描各包入口，提取 `Config` 接口及其 JSDoc，粘贴到 `docs/config-catalog.md`，同时收集 schemastery schema 的所有键路径。
- 生成过程会断言：schema 中出现的每一个键都能在声明类型中找到；引用的本地类型必须无别名、可内联粘贴；缺失 JSDoc 的属性会被报告。
- 文档通过 `pnpm run verify-config-catalog`（纳入 doc-sync）在 CI 中校验，确保源码变更不会使文档过时。

## 4. 约定与约束

| 约定 / 约束 | 来源 / 证据 |
|---|---|
| 配置文件根目录统一通过 `resolveDshHome()` 解析，默认 `$DSH_HOME` 或 `~/.dsh` | `settings-file`、`credentials-local`、`profile-boot` 均调用此函数 |
| 用户设置文档默认位于 `<harness home>/settings.yaml`，扩展名决定 YAML/JSON | `settings-file` 的 `resolveSpec` 与 `FORMATS` 映射 |
| 凭据文档默认位于 `<harness home>/.credentials.yaml` | `credentials-local` 的 `CREDENTIALS_FILENAME` 常量及 `resolveSpec` |
| 凭证文件权限必须 owner-only（POSIX 下 0600），否则启动时报错 | `credentials-local` 的 `assertOwnerOnly` 与错误消息 |
| 命名空间名称必须符合 `^[a-z][a-z0-9-]*$` | `settings` 包的 `settingsNamespace` 校验 |
| 补丁层顺序固定为 bundle → profile → home → overlay → telemetry switch | `profile-boot.ts` 的 `allPatches` 与 `composeProfile` |
| 用户层可通过 `DSH_TELEMETRY_DISABLED` 硬关遥测行 | `profile-boot.ts` 的 `resolveTelemetryPatch` |
| 写 settings 前必须通过 schemastery schema 校验，非法值在 `update/replace/mutate` 处立即拒绝 | `settings` 包 `write` 流程与 `cloneJsonShaped` |
| 并发写同一 namespace 串行化，并通过 revision 检测乐观冲突 | `settings` 包每 namespace 的写队列与 `SettingsConflictError` |
| 外部编辑 settings/credentials 文件时自动热重载 | `settings-file` 与 `credentials-local` 均使用 chokidar watch + debounce |
| 配置目录清单 `docs/config-catalog.md` 禁止手工编辑，必须由生成脚本产出 | 文件头注释与 `gen-config-catalog.ts` 的生成逻辑 |
| 插件 Config 类型与运行时 schema 必须一一对应，否则生成失败 | `gen-config-catalog.ts` 对 schema 键集合与类型字段的交叉校验 |
