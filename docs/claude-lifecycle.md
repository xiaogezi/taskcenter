# Claude 真实身份与任务生命周期

本指南适用于已有 TaskCenter MCP 和 Hook 的 Claude Code。工具前缀随连接器名称变化，以下使用工具末尾名称。不要用 curl 代替 MCP，也不要让其他客户端代办验收。

## 1. 固定真实身份

SessionStart 的 `hookSpecificOutput.additionalContext` 会给出真实 `session_id` 和 `workspace`，登记失败不会宣称已登记。写入被门禁拒绝时，错误也会回显这两个值。沿用 Hook 值，不添加 `local_`，不填写 `claude-session-verification` 等自拟身份。

先用 `taskcenter_session_status({"session_id":"<Hook session_id>"})` 核对登记。若未登记，可使用下方 `taskcenter_task_begin` 一次登记并创建；不要猜身份。已有同一目标的任务先查询并接续，使用 `taskcenter_task_resume`，其中 `expected_session_id` 必须来自任务当前绑定，不能猜测。新目标才创建独立任务。

若 Hook 未给出身份，先恢复现有 Hook 配置或由宿主重新触发 SessionStart；不要通过放宽门禁或注册自拟 ID 继续。

## 2. 创建正式任务

将占位符替换为本次真实值，event_id 为本次操作的唯一值；重试相同操作复用该值。此 fast 示例用于无代码变更的生命周期核验，实际开发按工作风险选择 standard/strict 并提供 verification_plan。

`taskcenter_task_begin`：

```json
{
  "session_id": "<Hook session_id>",
  "workspace": "<Hook workspace>",
  "agent": "claude",
  "provider": "anthropic",
  "event_id": "<本次唯一事件 ID>",
  "title": "Claude 真实会话生命周期核验",
  "goal": "核对真实会话身份、Context 关联和任务关闭",
  "scope": ["当前真实 Session 的生命周期验证"],
  "non_goals": ["修改业务代码", "代替独立验收"],
  "plan": ["核对 Hook 身份", "关联 Context 并提交 Turn", "核对证据后关闭任务"],
  "acceptance_criteria": [
    {"id": "identity", "description": "任务绑定与真实 Hook Session 一致", "required": true},
    {"id": "context", "description": "同一执行任务关联的 Context Turn 成功完成", "required": true}
  ],
  "workflow_profile": "fast",
  "review_policy": "recommended"
}
```

必须同时传 `plan`、`scope`；漏参报错属于正确的契约校验。保存成功返回的 TaskCenter `task_id`，下称 execution task ID。结构化验收项保留自定义 ID；仅字符串数组会生成 `acceptance-1` 等 ID。关闭时引用实际保存的 ID。

## 3. 关联 Context 并完成 Turn

已有 PCA Hook 注入时，优先复用注入的 `client_session_id`、语义 `task_id`、`turn_id` 和执行关联；不要另建 Session，或把自动提交再当作新鲜手动提交。`client_session_id` 可能有客户端命名空间，不等于应改写 TaskCenter 的真实 Session ID。

手动验证且尚未 attach 时：

```json
{"client_id":"claude","client_session_id":"<Hook session_id>","project_id":"<已注册项目 ID>","workspace":"<Hook workspace>"}
```

以上传给 `context_attach_session`。在 `execution_mode=taskcenter` 下，调用 `context_open_task`：

```json
{"client_session_id":"<attach 返回或 Hook 注入的 client_session_id>","execution_task_id":"<execution task ID>","request":"<当前目标>"}
```

不要传 `create_new:true`。保存返回的语义 `task_id`，与 execution task ID 分开使用。

`context_prepare_turn`：

```json
{"client_session_id":"<client_session_id>","project_id":"<项目 ID>","task_id":"<语义 task_id>","turn_id":"<本轮唯一 ID>","message":"<当前请求>"}
```

核对返回的 `execution_task_id` 与正式任务一致。`context_commit_turn`：

```json
{"client_session_id":"<client_session_id>","task_id":"<语义 task_id>","turn_id":"<prepare 返回的 turn_id>","summary":"<本轮实际结果>","decisions":["<实际决定>"]}
```

`status=completed` 仅描述 Context Turn；若 `replayed=true`，表示幂等重放，不能声称本次新写入。不能用这个状态证明 TaskCenter 已完成。

## 4. 关闭正式任务

`taskcenter_task_close`（只对已核实的条件填写 passed）：

```json
{
  "session_id":"<Hook session_id>",
  "task_id":"<execution task ID>",
  "context_task_id":"<语义 task_id>",
  "status":"done_claimed",
  "tests":["<实际运行的核验及结果>"],
  "evidence":["<可核对的实际回执或产物引用>"],
  "close_requirements":[
    {"requirement_id":"identity","status":"passed","evidence_refs":["<身份与任务绑定证据>"]},
    {"requirement_id":"context","status":"passed","evidence_refs":["<Turn 回执证据>"]}
  ]
}
```

不要临时另造 requirement_id，也不要照抄模板中的成功状态作为证据。`done_claimed` 是执行声明，不是独立验收。只有退出手动附加的客户端 Session 时才 detach，不要误 detach 正在被 Hook 管理的 Session。

## 5. 真实写入验收（开发任务）

上面的无代码核验只能证明 MCP/Context 生命周期。完整客户端验收还必须：

1. 在 Claude 的真实 Session 中，由 Claude 自主创建包含写入范围的任务。
2. 在该任务关闭前，对用户授权范围内的测试文件执行一次真实 Write/Edit，再读取确认；已有同名文件不得覆盖。记录 Hook 放行和文件内容证据。
3. 核对本轮 Hook 身份、任务 `sessionId` 和 workspace 一致，再提交 Turn 并关闭该任务。
4. 确认没有 Codex 代办、手动 curl 或绕过门禁；失败时保留原始错误与真实身份。

隔离测试和手动喂入 Hook 的探针不能替代这一步。真实 Claude 宿主未运行前，结果应记为“实现已验证，真实客户端验收待执行”。
