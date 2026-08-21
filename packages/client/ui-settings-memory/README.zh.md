# @deepseek-ai/dsh-client-ui-settings-memory

[English](README.md) | 中文

Memory 面板设置分区的浏览器侧：设置面板上的单个导航条目（外壳归 `ui-settings-general` 所有），链接到正在运行的 TencentDB-Agent-Memory（Memory Hub）面板。

deepseek-harness 仓库自身不携带记忆面板。该分区只是跳转链接；面板本体是独立的 TencentDB-Agent-Memory 控制台，由 DSH 会话的记忆代理（`8096`）对接。

## 模型体验

- 向设置面板添加一个 **Memory** 导航条目，排在 Models 分区之后。
- 该分区渲染标题、一行简介、面板 URL，以及在新浏览器标签页中打开面板的 **Open memory panel** 主按钮。
- 面板 URL 跟随页面自身的主机：回环渲染固定的 `http://127.0.0.1:8123`，局域网源渲染同一主机在面板端口上的地址（例如 `http://192.168.1.5:8123`），因此当 DSH 本身被跨网络打开时跳转链接仍可用。
- 不执行任何网络请求、会话事件或 settings 写入；该分区是固定链接，对模型和会话日志没有任何贡献。

## 已知限制与延期工作

- 面板端口固定为 `8123`，并假定面板与 DSH 同机；把面板部署在其他端口或机器上的场景需要先把该源做成可配置，链接才能跟随它。
- 面板本体是独立的 TencentDB-Agent-Memory 服务。局域网浏览器能否实际加载 `http://<host>:8123` 取决于该服务自己的绑定策略，不在本仓库的控制范围内。
