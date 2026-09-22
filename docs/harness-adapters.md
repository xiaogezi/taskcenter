# Harness 适配层决策与接入契约

日期：2026-09-18。用户已选择同进程、静态注册、按能力分组的模块适配器；沿用 Node.js，不增加进程、插件加载器、依赖或数据库。

## 2026-09-20：受管派发与多模型配置决策

用户选择扩展本适配层：主窗口负责选择执行客户端和具体型号，客户端适配器负责协议与回执转换。客户端身份不再与一个固定型号等同：Codex 子任务只使用集中角色配置中的 Luna；Kimi 型号由明确的配置目录选择；Claude 通道保留 MiMo。主窗口自身模型不受子任务型号限制。2026-09-20 起普通执行的默认路由从 executor 角色的非 Codex 客户端（Kimi/MiMo）按能力与可用性选择、默认并发一，Luna 仅在用户显式授权或 Codex 专属实测时使用；默认路由会反解并返回实际客户端 profile 与 harness。

实现范围是受管 CLI 派发与配置，保留旧 `kimi-k3`、`claude-mimo` profile 兼容入口。任务登记、delegation claim、权限检查、并发租约与验收仍由核心控制。请求型号与客户端回执型号不一致时不能声明成功；发现可用型号也不等于取得调用授权。不新增服务、动态插件加载器或历史数据迁移。

本机能力证据（2026-09-20）：Kimi Code CLI 2.0.0 的 ACP `initialize` / `session/new` 返回以下型号。探测使用临时工作目录，不发送 prompt，并关闭会话；这证明本机客户端公开这些选项，不代表各型号已完成模型执行验收。

| 显示名称 | 客户端真实型号 ID |
| --- | --- |
| K2.8 Preview | `kimi-code/kimi-for-coding` |
| K2.7 Code Highspeed | `kimi-code/kimi-for-coding-highspeed` |
| K3 | `kimi-code/k3` |
| K3-256k | `kimi-code/k3-256k` |

该客户端的 thinking 选项为 `low`、`high`、`max`；本项目默认选择 `low`，不把其他客户端的 `medium` 原样套入。新增型号先核实真实 ID 与能力，再更新集中配置。验收覆盖旧 profile、新型号选择、未知配置拒绝、claim 前不执行、权限拒绝、取消与型号回执不一致；真实执行证据与契约测试分别记录。回滚本次代码与配置提交即可恢复旧入口，已有任务与历史证据保持原样。

### 配置与执行入口

`config/model-roles.json` 的 `cli_clients` 按 Harness 配置 provider、模型别名到真实 ID 的映射及支持的推理档位；`cli_profiles` 通过 `harness`、`model_key`、`reasoning_effort` 引用它。旧的直接 `model` 写法与不含 `cli_clients` 的旧配置仍可读取；配置了客户端目录后，型号必须属于目录，冲突的 `model` / `model_key` 在启动前拒绝。

| Profile | 选择 |
| --- | --- |
| `kimi-k3` | 兼容旧入口，仍为 K3-256k |
| `kimi-k3-standard` | K3 |
| `kimi-k2.8-preview` | K2.8 Preview |
| `kimi-k2.7-highspeed` | K2.7 Code Highspeed |
| `claude-mimo` | MiMo v2.5 Pro（兼容入口） |
| `claude-mimo-v2.6-pro` | MiMo v2.6 Pro |
| `claude-mimo-v2.6-flash` | MiMo v2.6 Flash |
| `claude-mimo-v2.5` | MiMo v2.5 |

MiMo 型号按用户提供的 ID 纳入目录，共用现有 Claude Harness 和额度池；新增入口不改变默认 executor 或自动回退顺序。目录注册不表示已完成上游调用可用性验证。

路由和 manifest 继续传 `cli_profile` / `profile`，无需新增协议字段。受管编排通过 `requireHarnessOperation(harness, "runDelegatedCli")` 取得静态注册的执行函数。Claude 的启动参数与 JSONL 回执、Kimi 的 ACP 参数与一次授权选项由各自模块转换；核心只提供 claim、工具授权和事件记录回调，并统一检查最终身份、型号与回报。Codex 的原生派发保持原通道，不能用历史 Dashboard 的 `createSession` 冒充受管 delegation。

### 权限故障边界

CLI 的 MCP 工具审批、文件系统沙箱、TaskCenter Session/claim 是三个独立检查。拥有父任务 grant 不等于宿主已批准 MCP 工具，模型可用也不等于能够执行任务。非交互调用遇到 `MCP tool call requires approval, but approval policy is never` 时，应定位到工具审批，停止执行并释放 grant/路由，不记为模型容量失败，不自动切换型号或扩大权限。

2026-09-20 实测：原生执行器错误使用自拟 Session ID，已撤销 grant；独立 Luna CLI 的 `thread.started` 提供真实 UUID，但身份查询与 Session 登记仍被宿主审批拒绝。相关尝试不计为完成执行。真实身份只能来自宿主事件或可信上下文，禁止为了通过 claim 自拟 ID。

OpenAI 官方支持 MCP 单工具 `tools.<tool>.approval_mode` 设置，见[官方 MCP 文档](https://developers.openai.com/zh-Hans/docs/extend/mcp)。审批调整需要明确授权；本适配层不修改用户的 `~/.codex` 配置，不设置整个 MCP server 自动批准，也不关闭沙箱或 Hook。

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
| Claude | 受管 CLI 启动与 JSONL 回执接入统一派发，保留 Hook 领取与逐工具门禁 | 控制服务通用创建/恢复、独立用量采集 |
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

权限诊断：受管 CLI 在提交 prompt 前检查工作目录、输入可读与输出目录可写；失败仍撤销 delegation 并释放路由租约。执行回执区分工具审批、文件系统权限、任务授权错误；客户端报告工具拒绝时不能声明成功。Codex 非交互 MCP 的进程级审批调整尚未启用，等待用户选择。

实机验证：2026-09-20，受管 `kimi-k3` 使用真实 Session 登记和 claim，返回 `TASKCENTER_ADAPTER_OK`，回执型号 `kimi-code/k3-256k`。其他三个 Kimi 型号已通过本机 ACP 目录确认和配置解析测试，未声称完成生成测试。
