---
kind: logging_system
name: 基于 Cordis LoggerService 的插件化日志与结构化会话日志系统
category: logging_system
scope:
    - '**'
source_files:
    - packages/experimental/webworker-runtime/src/worker-host.ts
    - packages/session/session-log-deepseek/src/index.ts
    - packages/session/session-persistence-jsonl/src/format.ts
    - packages/session/session-telemetry/src/coordinator.ts
    - packages/session/session-telemetry-otel/src/index.ts
---

## 1. 使用的系统与框架

仓库没有引入独立的第三方日志库（如 winston、pino、bunyan），而是统一使用 **Cordis 框架内置的 `LoggerService`** 作为应用级日志门面。所有业务模块通过 `ctx.logger` 访问，并通过 `ctx.logger.exporter()` 注册自定义导出器来接管输出目的地。

此外，项目还维护了两套“结构化日志”：
- **会话事件日志（Session Log）**：以 JSONL 格式持久化的不可变事件流，由 `packages/session/session-persistence-jsonl` 实现，是 DSH 的核心可观测性数据源。
- **遥测记录（Telemetry）**：通过 `packages/session/session-telemetry` 协调捕获，并由 `packages/session/session-telemetry-otel` 经 OpenTelemetry OTLP/HTTP 上报。

## 2. 关键文件与包

| 路径 | 职责 |
|---|---|
| `packages/experimental/webworker-runtime/src/worker-host.ts` | 定义 `LogMessage` / `LogExporter` 接口，并在 worker 启动时通过 `installLogSink` 把 Cordis logger 输出桥接到 `console.warn/error` |
| `packages/session/session-log-deepseek/src/index.ts` | 将增量会话事件注入 DeepSeek LLM API 请求的 `dsh_session_log` 扩展字段 |
| `packages/session/session-persistence-jsonl/src/format.ts` | JSONL 会话日志的物理格式、路径编码、头行序列化、截断恢复扫描 |
| `packages/session/session-telemetry/src/coordinator.ts` | 从 session 事件流中抽取遥测记录，映射 severity，执行 redact waterfall |
| `packages/session/session-telemetry-otel/src/index.ts` | 将 `SessionTelemetryRecord` 映射到 OpenTelemetry `SeverityNumber`，经 OTLP/HTTP 上报 |
| `apps/cli/tests/profiles/headless/tests/resume.e2e.ts` 等测试 | 验证 JSONL 后端 flush、回放、版本兼容性等行为 |

## 3. 架构与设计决策

### 3.1 Cordis LoggerService 作为唯一入口
- 所有业务代码通过 `this.ctx.logger`（或解构出的 `logger`）调用 `warn` / `error` / `info` / `debug`，不直接依赖任何日志库。
- 默认情况下 Cordis 将消息写入一个 ring buffer；必须显式调用 `ctx.logger.exporter(exporter)` 挂载导出器才能看到输出。
- Web Worker 环境在 `installLogSink` 中手动安装了一个最小 exporter：仅放行 `warn` 和 `error`（级别阈值设为 2，即 WARN），因为 info/debug 会淹没页面控制台，且该 sink 的目的是让失败的 provider 可见而非全量追踪。

### 3.2 结构化会话日志（JSONL）
- 每个 session 对应一个追加写（append-only）的 JSONL 文件，首行为带 `type: 'session'` 的不可变 `HeaderLine`（含 version、id、createdAt、cwd、parentSession、seedLength、origin、delegationDepth、agentPreset）。
- 后续每行是一个 `StorageRecord`（即 `SessionEvent` 的压缩/打包形式），支持 zstd 压缩（`.jsonl.zstd`）或明文（`.jsonl`）。
- 路径布局为 `<root>/<projectKey(cwd)>/<encodeSegment(sessionId)>/session.jsonl[.zstd]`，其中 `projectKey` 对路径分隔符做有损替换，`encodeSegment` 对 SessionId 做安全转义，防止目录穿越。
- 读取端 `SessionLogScanner` 按字节边界解析，遇到损坏行则丢弃直到下一个 `turn/end`，并返回可安全续写的截断偏移（committedBytes）。
- 通过 `SESSION_FORMAT_VERSION` 拒绝未来版本的日志，向上游报告 “upgrade the harness”，而不是报 “corrupt session log”。

### 3.3 遥测通道（Telemetry）
- `session-telemetry` 包监听 `session/event`，将事件投影为 `SessionTelemetryRecord`（channel: `ledger` | `ops`，severity: `info` | `warn` | `error`，attributes 包含 session.id、event.type、event.seq 等，body 为 structuredClone 后的 event.data）。
- severity 映射规则：`tool/result` 中 `isError === true` → error，`turn/end` 中 reason.kind === 'error' → error，其余 → info。
- `session-telemetry-otel` 是具体后端实现：将 severity 映射为 OTel `SeverityNumber`，通过 `LoggerProvider` + `BatchLogRecordProcessor` + `OTLPLogExporter` 发送，resource 携带 service.name/version 与匿名 user.id。
- 支持三种模式：`FULL`（实时）、`FEEDBACK_ONLY`（仅在用户反馈事件中按需回放）、`DISABLED`（本地静默）。

### 3.4 会话日志对外透传
- `session-log-deepseek` 插件可选地将当前会话的增量事件附加到 DeepSeek LLM API 请求的 `dsh_session_log` 扩展字段中，通过 `acceptedThrough` watermark 避免重复重发，并在服务端确认后回写 `session-log-deepseek/delivery-accepted` 事件。

## 4. 约定与约束

| 约定 | 说明 |
|---|---|
| 业务日志一律通过 `ctx.logger` | 禁止直接使用 `console.log` 作为业务日志；仅底层错误兜底（如连接失败、subscriber 崩溃）才用 `console.error/warn` |
| 日志级别语义 | Cordis 内部级别计数递增：ERROR=0 < INFO=1 < WARN=2 < DEBUG=3；exporter 未声明 level 时会静默丢弃 warn+，因此 worker 中显式设置 `levels.default = 2` |
| 会话日志不可变追加 | 已提交行永不修改，损坏尾部被丢弃，重启后从 committedBytes 续写 |
| 会话日志版本兼容 | 读入前检查 `version === SESSION_FORMAT_VERSION`，否则抛出 `SessionFormatUnsupportedError` |
| 遥测 severity 三态 | 仅允许 `info` / `warn` / `error`，未知事件类型默认降级为 `info` |
| 遥测 payload 可序列化 | body 必须是 `AnyValue` 子集（JSON 可序列化），attributes 为 `Record<string, string | number>` |
| 日志输出目的可插拔 | 通过 `ctx.logger.exporter()` 挂载 exporter，默认 ring buffer 无输出，必须显式安装 |

## 5. 观察到的实践模式

- 各包内大量使用 `this.ctx.logger.warn(...)` 记录非致命异常（如 ACP 配置更新失败、工具调用投递失败、HMR 重建帧未知条目），配合 `errorChain(error)` 拼接链式错误信息。
- 对 `console.*` 的使用集中在客户端连接层、UI 命令层等“最后防线”的错误兜底，通常带有 `[connection]`、`[ui-commands]` 等前缀以便区分来源。
- 测试中对 `ctx.logger.warn` 进行 mock/spy 来断言警告内容（见 `dispose.spec.ts`、`controller.host.spec.ts`），表明 logger 是可测试的契约面。
- 遥测采集通过 `waterfall('session-telemetry/record', record, () => record)` 暴露给部署方做 redact 过滤，确保敏感字段可在不改动核心逻辑的前提下脱敏。