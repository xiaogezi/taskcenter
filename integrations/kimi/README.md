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

当前没有核实 Kimi 自动注入上述 metadata/env，配置示例不会声称自动绑定成功。需要可信能力时先完成客户端级绑定，再用 `taskcenter_client_context` 核对真实身份。

## 能力与验证边界

TaskCenter 的 Kimi Hook、自动恢复、日志/用量采集尚未适配，能力查询返回 false；这不代表 Kimi 产品自身没有这些功能。不会因这些可选能力缺失阻断基础任务管理，也不会自动安装 Hook 或修改用户配置。

仓库测试通过真实 MCP stdio 与隔离 Control API 验证 Kimi 标识的登记、创建、进度、证据关闭及顺序任务；验证了通用身份解析和冲突拒绝。它是协议集成验证，不是 Kimi 模型实际调用工具的端到端实测。人工接入验收应在部署后按上述五步执行一次无项目写入的小任务，并核对账本 agent/session/task 归属。
