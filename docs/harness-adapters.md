# Harness 适配层决策与接入契约

日期：2026-09-18。用户已选择同进程、静态注册、按能力分组的模块适配器；沿用 Node.js，不增加进程、插件加载器、依赖或数据库。

## 边界

控制服务/受管 CLI → `scripts/harnesses/index.mjs` → 客户端模块 → 原 SDK、CLI 或 ACP。

任务账本、权限、Session 归属、派发队列、独立验收继续归核心；适配器不授予权限。Harness 标识与 provider/model 分开。请求内容不能注册适配器、指定导入模块或传入待执行命令。

静态注册表是 MCP agent enum、旧 `agent-clients.mjs` 和会话页面能力信息的共同来源。每个适配器只声明自己实现的操作；未知客户端及不支持操作在启动进程前拒绝，不回退到 Codex。

## 调用与回执

`invokeHarness(id, operation, input)` 接收绝对 `workingDirectory`、`prompt`、原生 `sessionId` 及可选 `onEvent`。内部调用者必须先完成来源、权限、Session 归属和并发检查；这个函数不是新的公开执行 API。

- `createSession` 不接受已有 Session ID；`resumeSession` 必须提供原生 ID，不得静默新建。
- `inspectSession` 只读。当前安全队列要求该能力；仅实现恢复，不等于可以进入该队列。
- `accepted` 只表示取得会话回执；`running` 表示观察到执行；`completed` 表示 turn 终态，不等于任务验收。
- `failed` 必须有失败回执；通信异常或缺少终态标记为 `unknown`，没有自动重试。
- 能力 `supported` 表示实现存在；`availability=unknown` 表示没有探测当前安装、认证、连接或权限。不能根据 supported 显示“已连接”或绕过授权。
- Kimi 保留原生 `session_<UUID>` 与 TaskCenter UUID 的双标识，`context_snapshot` 不累计为 Token 用量；Codex 保留既有 Token 统计。

## 本次接入范围

| Harness | 已迁移能力 | 尚未接入 |
| --- | --- | --- |
| Codex | SDK 创建、CLI 恢复、JSONL 忙碌检查；原控制服务调用通过注册表 | 桌面打开、压缩、Bug 宿主创建仍为原专用通道 |
| Kimi | 受管 CLI 通过统一调用进入 ACP 创建/恢复，保留逐次权限确认、取消与上下文快照 | 控制服务安全队列（缺少独立忙碌检查），桌面打开 |
| Claude | 已有 Hook/MCP 支持与身份要求进入统一能力表 | 主动创建、恢复、用量采集；明确返回 unsupported |
| WorkBuddy / unknown | 保留兼容身份声明 | 主动操作不支持 |

历史 Dashboard 新建派发继续使用注册表中的兼容默认 Harness，未新增客户端选择参数。恢复派发优先使用可信 Session 注册身份；未登记的旧记录按历史 Codex 来源处理。旧 `session-cli.mjs`、`kimi-run.mjs` 导出继续可用，任务 ID、历史数据及权限协议不变。

## 新 Harness 接入步骤

1. 在 `scripts/harnesses/` 新增模块，提供 id、client 元数据、identity、usageScope 和实际实现的 operations。
2. 加入 index 的静态注册表；MCP enum 与会话能力展示自动取得新条目。无需修改任务账本。
3. 接通它的可信宿主身份与 Hook 配置，核实原生 Session ID、工作区和恢复语义。
4. 用隔离夹具验证创建/恢复、缺失能力、失败与未知结果、权限拒绝、用量口径及取消；再做该 Harness 的真实环境验收。不得用 Codex 夹具证明其他客户端能力。

暂不把各客户端压缩、桌面控制和用量采集强塞进一个万能接口；有第二个真实实现时再迁移对应能力。没有已核实适配的按钮不承诺可执行。

## 验证与回滚

契约测试：`tests/harnesses.test.mjs`；旧路径回归：`tests/dispatch.test.mjs`、`tests/kimi.test.mjs`；项目标准 sync、lint、test 与 diff 检查。契约夹具不代替三端登录后的人工实测。

无需数据迁移；回退本次代码提交即可恢复旧执行入口。新增 executionStatus 只是派发回执信息，旧读者可忽略。正式服务不在开发阶段切换，部署仍走既有 service:deploy。
