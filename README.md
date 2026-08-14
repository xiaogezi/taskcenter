# TaskCenter（任务中心）

TaskCenter 是一个本地优先的 Agent 任务治理看板。Codex、Claude Code 等客户端通过本地 MCP 登记真实 Session、创建任务、更新进度并提交证据；TaskCenter 将“Agent 声称完成”和“人工验收通过”分开记录。

> 当前版本：`v0.1.5`。核心 Web、MCP、Hook 与服务控制支持 macOS、Linux/WSL2 和原生 Windows；桌面快捷入口仅支持 macOS。

## 核心能力

- 按真实 Session 展示 Agent 创建的正式任务。
- 跟踪目标、计划、当前步骤、阻塞、预计时间、测试和证据。
- 通过 Hook 在受支持工具调用前检查 Session 是否已登记且存在活跃任务。
- 只读发现本机 Codex Session，用于来源筛选和状态展示。
- 所有任务账本和运行状态仅保存在本机。

## 隐私与安全边界

TaskCenter 只读访问：

- `~/.codex/sessions/**/*.jsonl`
- `~/.codex/session_index.jsonl`

TaskCenter 不读取 `~/.codex/auth.json`、API Key、Cookie 或其他认证材料，不会修改 Codex 会话，也不会将聊天内容上传到远端。项目默认只监听本机地址，不支持未经重新设计的数据脱敏、多用户鉴权和远程部署。

Hook 是有限的任务生命周期守卫，不是操作系统安全沙箱。Codex 的 `write_stdin` 不会再次触发 `PreToolUse`，TaskCenter 会拒绝已知的 stdin 交互式 shell/REPL 启动形态，但无法证明任意命令都不会转为长期进程；需要强安全边界时必须使用 Codex sandbox、最小文件权限和隔离运行环境。

## 快速开始

要求 Node.js `>=22.13.0`。

```bash
git clone https://github.com/xiaogezi/taskcenter.git
cd taskcenter
npm ci
npm run dev:live
```

打开 <http://localhost:3000>。`dev:live` 同时启动页面、Codex 会话监听器，以及只监听 `127.0.0.1:3001` 的本地控制服务。

如需后台启停，可以在 macOS、Linux、WSL2 或 PowerShell 中使用同一组命令：

```bash
npm run service:start
npm run service:status
npm run service:stop
```

Windows 原生环境要求 Node.js 与 Git 在 `PATH` 中。使用 WSL2 时建议把仓库放在 Linux 文件系统（例如 `~/code/taskcenter`），不要放在 `/mnt/c`；这能避免跨文件系统的权限、符号链接和监听性能问题。Windows 当前不提供 GUI 桌面壳。

macOS 可安装桌面快捷入口：

```bash
npm run desktop:install
```

## 配置 MCP 与 Hook

先输出基于当前克隆目录生成的配置：

```bash
npm run integrations:print
```

该命令只打印配置，不会改写 `~/.codex` 或 `~/.claude`。示例模板位于 [`integrations/`](integrations/)。

### Codex

注册本地 STDIO MCP：

```bash
codex mcp add taskcenter -- node "/absolute/path/to/taskcenter/scripts/taskcenter-mcp.mjs"
codex mcp list
```

将生成的 Hook 配置合并到 `~/.codex/hooks.json`，并确认 `~/.codex/config.toml` 包含：

```toml
[features]
hooks = true
```

重新启动 Codex，在 `/hooks` 中审核并信任 Hook，在 `/mcp` 中确认 `taskcenter` 已连接。也可以把 MCP 配置放进可信项目的 `.codex/config.toml`。

### Claude Code

注册用户级 MCP：

```bash
claude mcp add --scope user --transport stdio taskcenter -- \
  node "/absolute/path/to/taskcenter/scripts/taskcenter-mcp.mjs"
claude mcp list
```

将生成的 Hook 配置合并到 `~/.claude/settings.json`。如需项目共享 MCP，可将 `integrations/claude/mcp.json.example` 复制为目标项目的 `.mcp.json`，替换路径后由使用者审核授权。

配置变更只对新启动或重新加载的 Session 生效。Hook 会在本机控制服务意外退出时尝试一次自动恢复；恢复失败仍会阻断普通写操作，并只允许在项目根目录执行固定的跨平台 break-glass 命令：`node scripts/taskcenter-control.mjs start`（启动）或 `node scripts/taskcenter-control.mjs status`（诊断）。旧的 `/bin/bash scripts/taskcenter-control.sh ...` 入口继续作为 macOS/Linux 兼容薄封装。

在 Windows 上，TaskCenter 会安全解析标准 npm 安装生成的 `codex.cmd` 并直接调用其 Node 入口，避免把 Session prompt 拼进 shell。非标准批处理启动器应通过 `TASKCENTER_CODEX_COMMAND` 指向 `codex.exe`，或配合 `TASKCENTER_CODEX_PREFIX_ARGS` 显式配置。

## Agent 任务协议

每个 Session 按以下顺序执行：

1. `taskcenter_session_register`：提交真实 `session_id`、`workspace`、`agent`、`provider` 和 `model`。
2. `taskcenter_task_create`：提交目标、计划和验收标准。
3. 收到 `accepted=true` 与独立 `task_id` 后才能执行写操作。
4. 使用 `taskcenter_task_update` 更新进度，使用 `taskcenter_task_report` 上报结果。
5. 需要审计模型选择时，使用 `taskcenter_routing_record` 记录直接执行、原生派发、CLI 兜底或有理由偏离；该记录不阻断执行。
6. Agent 的 `done_claimed` 只表示实现声明，不能自动升级为人工验收通过。

MCP 工具：

- `taskcenter_session_register`
- `taskcenter_session_status`
- `taskcenter_task_create`
- `taskcenter_task_query`
- `taskcenter_task_update`
- `taskcenter_task_report`
- `taskcenter_routing_record`

## 数据文件

运行态写入 `data/`，并由 `.gitignore` 排除。仓库只保留空白 seed、示例数据和空的 Session 合并配置。删除运行态前请确认范围；TaskCenter 不应删除或改写 `~/.codex` 下的会话与认证数据。

## 开发与验证

```bash
npm run sync
npm run lint
npm test
git diff --check
npm audit --omit=dev
npm pack --dry-run
```

`npm test` 使用隔离 fixture 输出执行同步、生产构建和全部测试文件，不会覆盖本机 `data/dashboard.json`。CI 同时覆盖 Ubuntu 与 Windows；Chrome 长期稳定性和真实 Hook 生命周期仍需要本机持续运行验证。

## 许可证

Apache License 2.0。参见 [LICENSE](LICENSE)。
