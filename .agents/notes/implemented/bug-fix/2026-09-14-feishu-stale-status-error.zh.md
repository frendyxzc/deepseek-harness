# Agent Note: 飞书 bot 的接收长连接恢复后状态仍停留在「错误」

Status: implemented

[English](2026-09-14-feishu-stale-status-error.md) | 中文

## 问题

`FeishuBotProvider.status()` 只要 `lastError` 被设置就报 `state: 'error'`。`lastError` 由任何操作失败写入，但只在成功的 `sendMessage` / `updateMessage` / `getMessage` / `getMessageResource` 里被清除。接收长连接会在 `onError` 及 start/setup 失败时写入 `lastError`，但 `onReady` 与 `onReconnected` 从不清除它。一个只接收的 bot 只要撞上一次瞬时连接或凭据失败，就会永远显示「错误」——它的凭据和连接其实已经恢复健康，但没有任何东西清掉那个陈旧值，于是 Settings IM 页报出的连接错误与真实状态不符。

## 决策

`FeishuBotProvider` 在三个能证明先前失败已不再成立的位置清除 `lastError`：接收通道的 `onReady`、接收通道的 `onReconnected`、以及一次成功的 `getAccessToken` tenant-token 拉取。发送成功仍如往常一样清除它。

## 备选方案

**每次成功操作都清除 `lastError`。** 否决：该字段本就对消费者建模「最近一次失败 + 相关的成功点」；在一次无关的 `getMessage` 成功时清除，会丢掉一个仍然存活的发送失败。新增的三个点各自直接反驳接收与鉴权路径记录的那几类失败。

**改为从实时的 `receiveActive` 推导 `state`，而不是 `lastError`。** 否决：`lastError` 携带失败原因，状态面与诊断都依赖它；用布尔值替换会丢掉错误文案，也覆盖不了发送/鉴权失败。

## 影响

- 接收通道重连（或凭据重新开始鉴权成功）的 bot，在下一次状态轮询时回到 `connected`，而不是一直钉在陈旧的「错误」上。
- 状态面保持诚实：`error` 现在意味着「最近一次相关成功之后尚未清除的失败」。

## 测试

`packages/feishu/feishu-bot/tests/provider.spec.ts` 新增 `clears a recorded connection failure when the connection re-establishes (onReady)`：先触发 `onError` 再触发 `onReady`，断言状态从 `error` 回到 `connected`。