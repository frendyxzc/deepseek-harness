---
kind: dependency_management
name: pnpm Workspace + 源码级 Vendor + Rescope 的依赖治理体系
category: dependency_management
scope:
    - '**'
source_files:
    - pnpm-workspace.yaml
    - package.json
    - pnpm-lock.yaml
    - patches/node-pty@1.2.0-beta.15.patch
    - scripts/rescope-vendor.ts
    - scripts/verify-vendored-links.ts
    - scripts/check-vendor-manifest.sh
    - .github/dependabot.yml
    - python/sdk/pyproject.toml
    - python/sdk-runtime/pyproject.toml
    - docs/cookbook/adding-a-vendored-package.md
---

## 1. 使用的系统/方法

仓库采用 **pnpm workspace**（`pnpm-workspace.yaml`）作为多语言、多子模块的统一依赖管理核心，同时结合 **源码级 vendor**、**patchedDependencies**、**Dependabot** 与一系列脚本化门禁，形成“本地锁定上游版本 + 安全沙箱式安装”的治理模式。

- Node/TS 侧：根 `package.json` 声明 `packageManager: pnpm@11.7.0`、`engines.node ^22.19.0 || >=24.0.0`，通过 `workspaces` 聚合 `vendor/*`、`packages/*/*`、`native/landlock-run`、`apps/*`、`website`、`python/sdk-runtime` 等所有子包；依赖解析由根 `pnpm-lock.yaml` 锁定。
- Python 侧：`python/sdk/pyproject.toml` 使用 Hatchling 构建，依赖 `deepseek-harness-runtime-bin==0.0.0.dev0`；通过 `[tool.uv.sources]` 将运行时包以 `editable = true` 指向同仓 `../sdk-runtime`，实现 Python SDK 与打包后的 dsh 可执行体的本地绑定。
- CI 自动升级：`.github/dependabot.yml` 配置 npm（排除 `vendor/**`）、uv（`python/sdk`）、GitHub Actions 三个生态，按 UTC+8 凌晨定时扫描并打标签 `kind/dependency, area/infra`，默认 30 天冷却。

## 2. 关键文件与包

| 文件 | 作用 |
|---|---|
| `pnpm-workspace.yaml` | 工作区定义、`linkWorkspacePackages: true`、`overrides`、`allowBuilds`、`minimumReleaseAgeExclude`、`patchedDependencies` |
| `package.json`（根） | workspace 入口、顶层脚本（`build`、`release:*`、`verify-*`、`gen-third-party-notices` 等） |
| `pnpm-lock.yaml` | 全仓依赖锁定文件（被 rescope 脚本显式排除在改写之外） |
| `patches/node-pty@1.2.0-beta.15.patch` | 对 node-pty 的官方补丁 |
| `scripts/rescope-vendor.ts` | 将 vendor 下的 Cordis/Cosmokit/Schemastery 等包从上游名重命名为 `@deepseek-ai/*` 的 codemod |
| `scripts/verify-vendored-links.ts` | 校验 `pnpm-lock.yaml` 中所有 vendor 包均解析为 `link:`，禁止回退到 npm registry |
| `scripts/check-vendor-manifest.sh` | lefthook 钩子：修改 `vendor/*/src` 或 `bin.js` 时必须同步更新 `vendor/README.md` |
| `.github/dependabot.yml` | Dependabot 对 npm/uv/GitHub Actions 的定期升级策略 |
| `python/sdk/pyproject.toml` | Python SDK 依赖声明，通过 uv sources editable 引用 sdk-runtime |
| `python/sdk-runtime/pyproject.toml` | 打包 dsh CLI 可执行体及 sidecar 的 Python wheel 描述 |
| `docs/cookbook/adding-a-vendored-package.md(.zh)` | 新增 vendor 包的流程文档（含 rescope 要求） |

## 3. 架构与约定

### 3.1 源码级 vendor + 名称重映射（Rescope）

仓库将 Cordis 框架及其插件（`cordis`、`cosmokit`、`schemastery`、`@cordisjs/plugin-loader`、`plugin-include`、`plugin-group`、`plugin-timer`、`plugin-hmr`、`plugin-logger-console`）源码拷贝进 `vendor/`，并通过 `scripts/rescope-vendor.ts` 将其 `package.json.name` 及全仓引用统一改写为 `@deepseek-ai/cordis`、`@deepseek-ai/cosmokit`、`@deepseek-ai/schemastery`、`@deepseek-ai/cordis-plugin-*`。重映射表集中在该脚本的 `RENAMES` 常量中，支持 `--apply` / `--check` / `--reverse` 三种模式，并对 Markdown fence、YAML `name:` 标量、代码字符串进行精确匹配重写。

- `pnpm-workspace.yaml` 的 `overrides` 把 `@deepseek-ai/cosmokit`、`@deepseek-ai/schemastery` 强制指向 `link:vendor/...`。
- `linkWorkspacePackages: true` 使任何匹配上游 semver 范围的依赖都解析到本地 pinned 的 vendor 源码，而非 npm registry。
- `verify-vendored-links.ts` 在 CI 中检查 `pnpm-lock.yaml`：每个 vendor 包必须解析为 `link:`，且不能出现在 `packages`/`snapshots` 段（否则意味着存在 registry 副本）。违反即失败。
- `check-vendor-manifest.sh` 作为 pre-commit 钩子：任何 `vendor/*/src` 或 `vendor/*/bin.js` 的变更必须伴随 `vendor/README.md` 的更新，用于记录“Local modifications”。

### 3.2 严格的安全安装策略（allowBuilds + minimumReleaseAgeExclude）

pnpm 10+ 默认拒绝任何带 install/build script 的第三方包。仓库通过 `allowBuilds` 白名单仅放行已知必要的原生构建：`esbuild`、`lefthook`、`node-pty`、`koffi`、`@deepseek-ai/dsh-subprocess-local@file:...`；其余如 `@google/genai`、`protobufjs`、`node-addon-require-builtin` 显式设为 `false`（安装仍成功但不会执行其生命周期脚本）。

对于平台特定二进制（如 `@anthropic-ai/claude-agent-sdk-*-arm64`、`@openai/codex` 各平台 alias），通过 `minimumReleaseAgeExclude` 指定精确版本号集合，绕过 pnpm 的发布冷却期——因为供应链策略不允许未经验证的近期发布进入已审核的运行闭包。

### 3.3 Patch 机制

唯一记录的 patch 是 `patches/node-pty@1.2.0-beta.15.patch`，通过 `pnpm-workspace.yaml#patchedDependencies` 应用。其他依赖通过 vendor + rescope 解决，不依赖 npm registry 上的同名包。

### 3.4 Python 侧依赖

- `python/sdk` 通过 `pyproject.toml` 声明 `dependencies = ["pydantic>=2.12,<3", "deepseek-harness-runtime-bin==0.0.0.dev0"]`。
- 通过 `[tool.uv.sources] deepseek-harness-runtime-bin = { path = "../sdk-runtime", editable = true }` 在开发时直接引用同仓产物，避免 PyPI 发布周期。
- `python/sdk-runtime` 用 Hatchling 构建 wheel，只打包注入的 dsh 可执行体与 sidecar，排除 `node/` 开发闭包。
- Dependabot 对 `python/sdk` 单独启用 uv 生态扫描。

### 3.5 依赖清单与合规

- `scripts/gen-third-party-notices.ts` 从 `vendor/README.md` 的表格生成 `THIRD_PARTY_NOTICES.md`，rescope 后表格新增 `Upstream name` 列区分重映射前/后的名称。
- `scripts/verify-dsh-package-licenses.ts`、`scripts/publint-all.ts`、`scripts/verify-optional-dependency-imports.ts` 等脚本在 `check:all` / `hygiene` 门禁中运行，确保无遗漏依赖、许可证合规、可选依赖不被误引入。

## 4. 约定与约束

| 约定 | 来源/依据 |
|---|---|
| 新增 vendor 包必须经 `scripts/rescope-vendor.ts --apply` 重命名为 `@deepseek-ai/*`，并保留上游 `version`/`exports`/`type` | `docs/cookbook/adding-a-vendored-package.md` 与 `rescope-vendor.ts` 的 EXACT_EDITS 契约 |
| vendor 源码改动必须同步更新 `vendor/README.md` 的 Local modifications 表 | `scripts/check-vendor-manifest.sh`（pre-commit 钩子） |
| 所有 vendor 包在 `pnpm-lock.yaml` 中必须解析为 `link:`，不得出现 registry 副本 | `scripts/verify-vendored-links.ts`（CI gate） |
| 任何带 install/build script 的第三方包必须列入 `allowBuilds`，否则安装失败 | `pnpm-workspace.yaml` 注释与 pnpm 10+ 行为 |
| 近期发布的平台二进制需逐一加入 `minimumReleaseAgeExclude` 才能跳过冷却期 | `pnpm-workspace.yaml` 中的精确版本列表 |
| 依赖升级由 Dependabot 统一发起 PR，默认 30 天冷却，标记 `kind/dependency` | `.github/dependabot.yml` |
| Python SDK 开发时通过 uv editable source 绑定同仓 sdk-runtime，不依赖 PyPI | `python/sdk/pyproject.toml` 的 `[tool.uv.sources]` |
| 根 workspace 的 `packageManager` 字段锁定 pnpm 版本，保证安装一致性 | 根 `package.json` 的 `packageManager: pnpm@11.7.0` |
