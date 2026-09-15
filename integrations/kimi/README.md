# Kimi Code CLI 接入 TaskCenter

本目录面向 Kimi Code CLI（本机核对版本 0.43.0），不是旧 Python kimi-cli。

## 配置

运行 `npm run integrations:print`，将 Kimi 段合并到项目 `.kimi-code/mcp.json` 或用户 `~/.kimi-code/mcp.json`。也可复制本目录 `mcp.json.example`，替换 `__TASKCENTER_ROOT__` 为仓库绝对路径。保留现有服务器配置。

配置使用稳定 launcher，实际加载已部署的不可变 release；工作区提交不会自动生效。部署后新建客户端会话，在 `/mcp` 检查连接；按客户端提示确认工作区信任与工具权限。

官方依据（2026-09-15 核对）：[Kimi MCP 配置](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html)。当前客户端没有旧版 `--mcp-config-file` 参数，不使用旧版安装命令。

## 基础任务闭环

1. 调用 `taskcenter_agent_capabilities`，传 `agent: "kimi"`，检查 TaskCenter 适配能力。
2. 从客户端取得真实当前 Session ID；不要生成随机替代值，不要复用其他客户端或 PCA 的 client_session_id。
3. 调用 `taskcenter_task_begin`，传真实 `session_id`、`agent: "kimi"`、真实 workspace、goal、scope、plan 和结构化 acceptance_criteria；模型与 provider 填实际值，不能由客户端名称推断。
4. 收到 `accepted=true` 和 task_id 后执行工作，用 `taskcenter_task_report` 上报进度。
5. 验证后调用 `taskcenter_task_close`，携带同一 Session/task、Subject/revision、tests、evidence、close_requirements 和 close_verifications。证据按合同提供，`done_claimed` 不等于独立验收。

缺少可信宿主身份不阻断原有显式登记协议；它也不授予依赖可信身份的管理、租约或 Session 操作权限。

## 可信宿主身份

`taskcenter_client_context` 只返回宿主注入的身份，缺失时明确返回 `TASKCENTER_SESSION_CONTEXT_UNAVAILABLE`。

通用宿主适配器可通过请求 `_meta["taskcenter/sessionId"]` 注入真实 Session UUID，或为每个会话独享的 MCP 进程设置 `TASKCENTER_CALLER_SESSION_ID`。Codex 的 `_meta.threadId`、`CODEX_SESSION_ID` 和 `CODEX_THREAD_ID` 保留兼容。多个来源必须一致；空 metadata、非法 UUID、冲突或模型在工具参数中声明身份不能建立可信绑定。

不能在全局 mcp.json 固定一个 Session ID供所有会话使用；不能将父 Codex 的环境身份沿用到 Kimi。共享 MCP 进程必须由宿主按请求注入身份。非 UUID 原生身份需要单独设计稳定映射，当前不放宽可信 UUID 校验。

原生 Kimi MCP 配置不自动建立绑定；本节下方的受管 ACP 入口使用真实 Session 创建独立 MCP 进程并注入身份，已用 `taskcenter_client_context` 实测。

## Hook + ACP 完整接入（Kimi Code CLI 0.43.0）

推荐通过受管 ACP 入口运行，无需改写用户全局配置：

```bash
node scripts/kimi-run.mjs --cwd /absolute/project --pca-root /absolute/ProjectContextAgent --prompt '本轮任务'
node scripts/kimi-run.mjs --cwd /absolute/project --pca-root /absolute/ProjectContextAgent --session session_<UUID> --prompt '继续任务'
```

- 自动执行 TaskCenter 登记与任务准备、PCA attach/prepare/commit/detach；正式任务仍按合同创建，回流不等于验收。
- 复用 PCA 的客户端无关 Hook 与独立 `kimi` 身份；macOS 使用 PCA 的 `mac-node.sh`，避免 SQLite ABI 与 Node 版本不一致。未配置 PCA 根目录或服务失败时有明确诊断，不阻塞 Kimi。
- ACP 创建返回原生 `session_<UUID>`。ACP 始终使用完整原生 ID；TaskCenter/PCA 使用其中的 UUID，不随机生成、不散列、不读取历史日志。报告同时保留两种表示。其他格式拒绝绑定。
- 新建后关闭空会话，再通过 `session/load` 将真实 UUID 注入该会话的 TaskCenter MCP 子进程；恢复前从 ACP 会话列表核对所属工作区。父 Codex 的 Session 环境变量不会传给 Kimi。
- `Ctrl-C` 发送 ACP cancel；五秒未响应则关闭所启动的 ACP 进程。不把取消记为任务完成。
- 权限请求只允许用户交互确认的 `allow_once`；无终端或未确认时拒绝。不会自动允许永久授权。宿主不声明文件或终端代理能力，未知回调拒绝。
- 恢复时历史消息重放不进入本轮输出、摘要或用量。仅本轮最终响应的末尾 1200 字符交给 PCA 脱敏与回流；不读取会话正文。

### 原生 Kimi 终端 Hook

`npm run integrations:print` 也生成 `config.toml` 的四个 `[[hooks]]` 条目。用户可将其合并到 `~/.kimi-code/config.toml`，并在启动 Kimi 前设置 `TASKCENTER_PCA_ROOT`。脚本不改写用户配置。用 `kimi doctor config <候选配置>` 校验后，新会话生效。

原生 Hook 支持自动登记/上下文准备/解绑；原生 Stop 未携带最终回答时提交 `automatic_empty`，不虚构知识摘要。完整最终回答回流由受管 ACP 提供。受管 ACP 设置进程标记跳过重复的原生 Hook。

### 用量口径

每次成功结束的受管调用将有界元数据写入 `.local/kimi-runs/<run-id>.json`：原生/TaskCenter Session、工作区、stopReason、取消状态及最后一次 ACP `usage_update` 快照。不保存 prompt、原始回答或认证信息。

`used/size` 是上下文占用，不是本轮输入输出 Token；快照取最后值、不累加。Kimi 未提供 cost 时为 null，没有 usage_update 时整体为 unknown。当前不合并到 Codex 账单估算，也不回填历史用量。

### 验证与边界

本机已通过真实 Kimi ACP 的新建、同会话恢复、TaskCenter 可信身份工具调用与 PCA 上下文注入；单元/协议测试覆盖权限拒绝与单次允许、取消、工作区错配、历史重放隔离、Hook 依赖故障。

这提供了受管 CLI 入口，不会将现有 Codex 看板派发按钮改为 Kimi，也不接管已经在另一终端运行的 Kimi 会话。使用恢复入口前结束该会话的其他交互。现有服务仍须按受控部署规则更新后才能通过稳定 launcher 加载新 MCP 能力声明。
