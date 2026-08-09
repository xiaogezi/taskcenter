# ReqRadar（需求雷达）

ReqRadar 是一个独立、本地运行的 Codex 项目需求看板。它从本机 Codex 会话中只读提取需求，按任务 ID 区分来源，并把“Codex 声称完成”和“有代码/测试证据的验收状态”分开展示。

## 能做什么

- 按 Codex 任务聚合用户提出的需求。
- 过滤“继续”“可以”等无需求消息。
- 展示已验收、部分实现、未实现、待验证和待整理状态。
- 关联人工维护的代码证据与验收缺口。
- 待整理消息可选择继续推进或丢弃，并随时从已处理记录撤销。
- “部分完成”需求支持新建并注入压缩上下文的 Codex Session，也支持通过 `codex exec resume` 追加到原 Session。
- 原 Session 忙碌时会进入本地持久化队列，等当前 turn 结束后自动投递；页面展示等待、投递、运行和结束状态。
- 每条“部分完成”需求都可复制完整续办信息；已排队任务可先取消自动队列，再手动粘贴到任意 Codex 会话，避免重复执行。
- 复制文本包含稳定的 ReqRadar 需求 ID。当前跨 Session 的“已完成”表述只作为实现声明，不会自动升级为“已验收”；验收状态仍以本地需求基线和代码/测试证据为准。
- 所有正式需求卡片支持人工标记完成或移除。人工决定保存在本机覆盖文件中；移除项不会删除原始需求，可从“已移除需求”区域恢复。
- 运行期间检查会话文件变化，在 Codex 停止写入 20 秒后自动刷新数据，避免频繁打断页面。
- 待整理 Inbox 决策由本地控制服务持久化到 `data/inbox-decisions.json`（可用 `REQRADAR_INBOX_DECISIONS_PATH` 覆盖），服务重启后仍可读取；原始 Codex 会话保持只读。

## 隐私边界

ReqRadar 仅在本机读取：

- `~/.codex/sessions/**/*.jsonl`
- `~/.codex/session_index.jsonl`

它不会读取 `~/.codex/auth.json`、API Key、Cookie，也不会写入 Codex 目录或把聊天上传到远端。正因为数据包含本地会话内容，本项目默认不提供远端部署。

“转发到 Session”是唯一的写操作入口：页面会先明确展示处理方式、上下文来源、剩余缺口和 Token/工作区风险。新建模式使用官方 `@openai/codex-sdk`，只注入当前需求的压缩上下文。原 Session 模式使用本机已登录的 Codex CLI，不读取或保存认证信息；只有在本地 JSONL 同时确认消息和 turn 后才进入运行状态。

## 启动

要求 Node.js `>=22.13.0`。

```bash
npm install
npm run dev:live
```

打开 [http://localhost:3000](http://localhost:3000)。`dev:live` 会同时启动页面、Codex 会话监听器和只监听 `127.0.0.1:3001` 的本地 Session 投递服务。

### macOS 桌面入口

```bash
npm run desktop:install
```

安装后双击桌面的 **需求雷达 ReqRadar.app**。入口会复用已经运行的服务，否则在后台启动 ReqRadar 并打开页面；不会重复启动服务。首次打开只需选择一次 ReqRadar 项目文件夹以授权访问。

只生成一次数据或仅启动页面：

```bash
npm run sync
npm run dev
```

## 选择任务

默认递归扫描 `~/.codex/sessions/**/*.jsonl` 中的全部本地 Codex 任务，并通过 `session_index.jsonl` 补充任务名称。可通过环境变量缩小为白名单：

```bash
REQRADAR_THREADS="任务ID1,任务ID2" npm run dev:live
```

运行中的看板会每 5 秒检查会话文件变化，在停止写入 20 秒后自动同步；左侧“手动扫描”会立即执行一次全量同步并刷新页面。

ReqRadar 管理的 Session 需要配置本地 MCP。注意：MCP 配置开启只代表客户端允许加载，不能自动解析用户消息；每个新 Session 仍必须主动完成注册和任务创建。

## Agent MCP 配置

### Claude Code

在项目或全局配置中添加 MCP server：

**项目级配置**（`.claude/settings.json`）：
```json
{
  "mcpServers": {
    "reqradar": {
      "command": "node",
      "args": ["/Users/liuyuge/Documents/company-ai-agent/projects/ReqRadar/scripts/reqradar-mcp.mjs"]
    }
  }
}
```

**全局配置**（`~/.claude/settings.json`）：
```json
{
  "mcpServers": {
    "reqradar": {
      "command": "node",
      "args": ["/Users/liuyuge/Documents/company-ai-agent/projects/ReqRadar/scripts/reqradar-mcp.mjs"]
    }
  },
  "permissions": {
    "allow": ["mcp__reqradar__*"]
  }
}
```

### Codex Desktop

在 `~/.codex/config.toml` 添加：

```toml
[mcp_servers.reqradar]
command = "node"
args = ["/Users/liuyuge/Documents/company-ai-agent/projects/ReqRadar/scripts/reqradar-mcp.mjs"]
```

新 Session 启动后自动可用；已运行的 Session 需重启或手动加载配置。当前配置还提供 `/session-status`，看板会显示 Session 是否已登记。

### WorkBuddy

WorkBuddy 代码模型（hy3、Kimi-K2.7-Code、GLM-5.2）通过 Claude Code 的 MCP 配置继承。确保 Claude Code 配置中包含 `mcp__reqradar__*` 权限，并在委派任务时传递 MCP 上下文。

## MCP 工具列表

- `reqradar_session_register` - 注册 Session（开始任务前调用）
- `reqradar_task_create` - 创建任务（修改代码前调用）
- `reqradar_task_update` - 更新任务进度
- `reqradar_task_report` - 上报任务结果
- `reqradar_task_query` - 查询任务账本
- `reqradar_session_status` - 查询 Session 登记状态和执行器身份

协议 Skill 位于 `skills/reqradar-task-protocol/SKILL.md`。

### 会话启动闸门

每个 Codex、Claude 或 WorkBuddy Session 开始处理任务时按以下顺序调用：

1. `reqradar_session_register`：提交真实 `session_id`、`workspace`、`agent`、`provider` 和 `model`。
2. `reqradar_task_create`：提交目标、验收标准和计划。
3. 只有返回 `accepted=true` 和独立 `task_id` 后才允许修改文件。
4. MCP 工具未挂载或返回 `REQRADAR_UNAVAILABLE` 时停止写操作，不得静默继续。

旧任务和历史 Session 没有执行器元数据时显示 `unknown`，不会根据标题或 workspace 猜测 Codex/Claude。

### 客户端 Hook 门禁

当前机器已配置客户端 Hook：

- Claude Code：`~/.claude/settings.json` 的 `SessionStart` 会登记真实会话，`Edit` / `Write` 等工具执行前检查是否已有 ReqRadar 任务。
- Codex：Hook 文件放在 `~/.codex/hooks.json`，`~/.codex/config.toml` 只通过 `[features] hooks = true` 启用同样的登记和写操作门禁；不能把 Hook 文件路径写入 `hooks` 配置项。
- Hook 只访问本机 `http://127.0.0.1:3001`，控制服务不可用或 Session 没有任务时返回阻断码，不会创建猜测任务。

配置修改只对新启动或重新加载配置的 Session 生效；已经运行的 Session 不会动态获得 Hook。当前 Hook 脚本为 `scripts/reqradar-hook.mjs`，可用临时 JSON 输入独立验证，不要用标题或 workspace 代替真实 `session_id`。

左侧“添加会话”可以手动维护采集范围；已移除的会话不会因后续自动扫描重新加入，只有再次勾选保存后才会恢复。选择配置保存在 `data/session-selection.json`，不会删除或修改原始 Codex 会话文件。

进入手动选择模式后，看板只展示已选会话有来源的需求；清空会话时右侧看板也会为空。

人工维护的需求基线位于 `data/requirements.seed.json`。聊天中新发现但尚未匹配基线的内容会进入“待整理”，不会被自动标成已实现。

## 验证

```bash
npm test
npm run lint
npm run build
git diff --check
```

`npm test` 会运行 `tests/*.test.mjs` 全量测试，专项测试仍可用 `node --test tests/<name>.test.mjs` 单独运行。健康检查、时间线和归档状态来自本地控制服务/任务账本；Chrome 长期稳定性仍需真实环境持续观察，不能由本地测试替代。
