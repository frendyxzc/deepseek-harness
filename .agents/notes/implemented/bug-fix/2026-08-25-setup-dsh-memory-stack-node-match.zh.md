# Agent Note: 内存栈的安装在服务启动所用的 Node 下运行

Status: implemented

[English](2026-08-25-setup-dsh-memory-stack-node-match.md) | 中文

## Problem

`start-all.sh` 把每个 TencentDB 内存服务都起在 Node v22 上（捆绑的 `$DSH_HOME/tdai-stack/node22`，其次 Homebrew `node@22`），但 `setup.sh` 在环境 Node 下安装并校验依赖。机器环境 Node 升到 v26（npm 11）后，`setup.sh --upgrade` 死在 `MemoryProxy better-sqlite3 native binding failed to build`。同一症状背后是两个独立的陷阱：

- npm 11 阻止依赖的安装脚本，除非 `package.json` 的 `allowScripts` 点名批准。`better-sqlite3` 在上游是可选依赖，npm 于是把它整个从 `node_modules` 里静默省略掉，而 `npm install better-sqlite3` 仍报告 "up to date" —— 包根本不在，无从修复。（`npm install-scripts approve` 也帮不上：它只认已安装的包，而恰恰是这个被省略的包没装上，批准工具无法解开它自己的失败模式。）
- native 绑定按 ABI 区分。Node 26（ABI 147）下构建的绑定在服务启动的 Node 22（ABI 127）下加载报 `ERR_DLOPEN_FAILED`；反过来，Node 22 构建的绑定会让环境 Node 的校验永远误报"缺失"。校验和修复都必须在栈的 Node 下运行。

## Decision

`lib.sh` 新增 `stack_node_bin`：栈运行所用 Node 的唯一解析（捆绑 node22，其次 Homebrew node@22，否则环境 Node）。`start-all.sh` 用它替换内联块；`setup.sh` source `lib.sh`，把所有内存栈安装（proxy npm、core/panel/knowledge pnpm、panel web 构建）和 `better-sqlite3` 验证-修复都放在同一个 Node 下运行，结束后恢复 `PATH`。校验因此检查的正是服务将加载的东西，修复安装的正是它们需要的 ABI。

针对到处都没有钉住 Node 的回退场景，`ensure_proxy_npm_approvals` 幂等地向 `MemoryProxy/package.json` 写入 `allowScripts` 条目（better-sqlite3/esbuild/node-pty/protobufjs，对齐该服务自己的上游 `pnpm-workspace.yaml` `allowBuilds`），让 npm 11 安装可选依赖而不是省略它；npm 10 忽略该字段，钉住的工具链下补丁无副作用。审批补丁与 pnpm-workspace.yaml 补丁一样，在 `--skip-install` 时也执行（pnpm 侧的审批早于此修复，见 [MemoryCore admin 引导笔记](2026-08-23-setup-dsh-admin-bootstrap-after-core-start.zh.md)）。`start-all.sh` 的存储守卫现在把修复指向 `setup.sh --upgrade`，而不是一条会踩同样陷阱的裸 `npm install better-sqlite3`。

## Alternatives considered

**用 `npm install-scripts approve` 批准脚本。** 拒绝：该命令只匹配已安装的包，而被省略的可选依赖正是没装上的那个——批准工具无法解开自己的失败模式。

**把 `better-sqlite3` 升到带 Node 26 prebuild 的版本。** 拒绝：那会为环境 Node 构建绑定，而服务跑的是 Node 22，ABI 失败换到另一边重现；还让部署偏离上游版本范围。

**在 `setup.sh` 里复制 node22 路径检查。** 拒绝，改用 `lib.sh` 的 `stack_node_bin`：给这个事实一个共享的家，两个脚本不会再漂移。

## Verification

复现了原始失败：在环境 Node 26/npm 11 下，proxy 的 `npm ls better-sqlite3` 报 `(empty)`，而 `npm install better-sqlite3` 说 "up to date"。把 `stack_node_bin`（本机解析到 Homebrew `node@22`）加进 PATH 后，安装取回了绑定，`require('better-sqlite3')` 在 Node 22 下成功，同一绑定在 Node 26 下报 `ERR_DLOPEN_FAILED`——同时证明了修复有效、以及校验为何必须在栈的 Node 下运行。`allowScripts` 补丁幂等（第二次运行无改动）。重跑 `./scripts/setup-dsh/setup.sh --upgrade` 完成迁移，不再死在绑定检查上。

## Consequences

`setup.sh` 与 `start-all.sh` 不可能再就内存栈跑哪个 Node 产生分歧：安装、绑定检查、服务启动统一走 `stack_node_bin`。没有任何 Node 22 的机器在两个脚本里一致地回退到环境 Node，此时 `allowScripts` 补丁保证 npm 11 的安装不撒谎。部署本地的 `MemoryProxy/package.json` 会多一个生成的 `allowScripts` 字段；上游 `git pull` 可能把它冲掉，下一次 `setup.sh` 运行会恢复它。
