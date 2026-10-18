# Agent Note: 用单一具体地址启动局域网 Web 监听器

Status: implemented

[English](2026-10-18-web-lan-concrete-address-launch.md) | 中文

## 问题

`scripts/setup-dsh/start-all.sh` 以 `pnpm dsh web --host 0.0.0.0 --port 3080` 提供 Web UI，而 `setup.sh` 把同一条命令作为只启动该服务的手工路径打印出来。上游的 [bind one concrete Web address](../architecture/2026-09-19-concrete-web-bind-address.zh.md) 决策在 `dsh web --host` 与 `webserver.config.host` 中都拒绝未指定地址——它测量到通配绑定会把远程代码执行交给机器加入的每一个网络——并且删除了绑定时刻的局域网地址采样，而本分叉的 [LAN access re-enablement](../feature/2026-08-19-web-lan-access-re-enabled.zh.md) 正是记录了那套采样。合入 `dsh-v0.2.1-rc.2` 之后，`dsh web --host 0.0.0.0` 在监听之前就以 1 退出，因此这套启动会在自己的就绪等待处死掉，摘要还会打印一个没有任何进程绑定的 URL。

## 决策

启动器改为点名一个具体地址，而不再要求监听器拥有全部地址。`start-all.sh` 依此顺序解析 Web 绑定主机：`--host` 选项、`DSH_WEB_HOST`、承载默认路由接口的 `lan_ip`，最后在没有局域网地址时回退 `127.0.0.1` 并给出警告。它把该值同时传给 `pnpm dsh web --host` 与 `start_service`，于是“已在监听”的跳过、就绪探测与打印的摘要点名的都是监听器真正持有的地址。`lib.sh` 的 `is_listening` 接收该地址并优先使用 `lsof`，其次 `ss`，再退到只能拨单个地址的 `nc` 与 `/dev/tcp` 探测；`wait_healthy` 把地址转发给它。`setup.sh` 在手工启动提示中打印解析出的地址。记忆面板保留自己的 `HOST=0.0.0.0`：该服务位于独立的 TencentDB 检出中，不受 Web 绑定策略任何部分约束。

## 曾考虑的替代方案

**绑定 `127.0.0.1` 并要求远程浏览器使用 SSH 隧道。** 不予采纳——本分叉的部署存在的意义，是让同一网络上的笔记本或手机无需额外工具就能打开 UI 与记忆面板；回环绑定会为了回避点名一个地址而删掉一个受支持的工作流。

**把通配绑定重新补丁回 `dsh web`。** 不予采纳——这条拒绝承载着上游的安全理由，并由 `apps/cli/tests/built-bin.e2e.ts` 与 `packages/bundle/web-app/tests/startup.spec.ts` 断言；分叉本地的覆盖会在每一轮同步重新积累冲突。绑定操作者实际使用的那个地址就能获得同样的可达性。

**每个地址各跑一个监听器，回环加局域网。** 不予采纳——一个端口只能容纳一个监听器，因此第二个进程需要自己的端口以及自己的会话、profile 与 token；它会把这段脚本已经为单个进程做的监管翻倍。

## 后果

局域网绑定只在该地址应答：局域网地址提供服务时 `http://127.0.0.1:3080` 会拒绝连接，所以 `start-all.sh` 打印已绑定的 URL，`scripts/setup-dsh/README.zh.md` 说明同一条限制。就绪判断、重启检测与等待端口释放仍能工作，因为 `lsof` 和 `ss` 能看到任意绑定地址；两者都没有的主机只能探测自己点名的地址，而启动器现在提供了该地址。本分叉仍然告诉局域网浏览器配置层仅限本机访问（[ui-settings-general](../../../../packages/client/ui-settings-general/src/client/index.ts) 与 Models store 中的 `ctx.remote.$host.isLoopback`），尽管上游现在会用进程启动 token 认证每一个浏览器，并让监听器自身的绑定地址通过 Host 栅栏；撤掉这道客户端闸门是另一个独立决策，需要它自己的暴露面评审。

## 测试

对 `lib.sh`、`start-all.sh`、`setup.sh` 执行 `bash -n`。针对合并后的树实测：`pnpm dsh web --host <LAN IPv4> --port 3980 --no-open` 警告纯 HTTP 并打印 `dsh web: http://<LAN IPv4>:3980/?token=…`；同一端口上的 `127.0.0.1` 拒绝连接；带 token 的请求返回 `303` 并设置一个 `HttpOnly`、`SameSite=Strict` 且受众为已绑定权威的 cookie；干净路径带着该 cookie 返回 `200`，不带则返回 `401`；`pnpm dsh web --host 0.0.0.0` 以 1 退出并打印通配消息，没有 URL 行。
