# TaskCenter Agent Rules

## Safety boundaries

- TaskCenter is a local-only task governance tool. Do not add remote upload of session content without a separate privacy and authentication design.
- Read Codex session data only from `~/.codex/sessions/**/*.jsonl` and `~/.codex/session_index.jsonl`.
- Never read `~/.codex/auth.json`, API keys, cookies, or other credentials.
- Never modify files under `~/.codex`; user-owned integration config changes require explicit user action.
- Treat an assistant's `done_claimed` status as an implementation claim, not acceptance.

## Required workflow

Before changing project files in an MCP-enabled session:

1. Call `taskcenter_session_register` with the real session ID, workspace, agent, provider, and model.
2. Call `taskcenter_task_create` with `contract_version=v2`, goal, scope, non-goals, plan, structured acceptance criteria, workflow profile, review policy, optional execution environment, and a verification plan for `standard` / `strict` work.
3. Continue only after `accepted=true` and a distinct `task_id` are returned.

For delegated CLI execution, the main Agent owns the single formal task. Each CLI executor still uses an independent registered Session, but ordinary search, implementation, test, and evidence-gathering runs must claim a short-lived `taskcenter_delegation_grant` for that parent task instead of creating another formal task. The grant binds parent task, delegate Session, exact workspace, declared scope, optional allowed tools, executor model, and TTL. The CLI reports its lifecycle and evidence with `taskcenter_cli_run_report`; this audit record never changes the parent task status or grants acceptance authority.

When TaskCenter routing is available, Sol must call `taskcenter_routing_select` before launching a CLI executor and must close the lease with `taskcenter_routing_result`, preserving the raw status, error classification, code, and request ID. The result is a strong default recommendation, not execution authority: TaskCenter stores health, circuit state, concurrency leases, and audit events but never starts CLI processes or replaces Sol's risk judgment, integration, or acceptance. A reasoned Sol override must be recorded with `taskcenter_routing_record`. If TaskCenter is unavailable in an external project that is allowed to continue, use the static routing policy and backfill the override/result after recovery; this repository's own gate-enabled maintenance remains fail-closed as stated below.

OCR independent review is a routing exception. TaskCenter may report the Spark reviewer as unavailable, but Luna, Terra, Sol, or a normal CLI Run must never be recorded as a successful independent OCR review substitute.

Create a formal child task only when the work has an independently owned deliverable, lifecycle, acceptance criteria, or handoff boundary. Delegation is not permission to mutate the parent task contract, completion state, review, or acceptance.

`done_claimed` is only the execution claim. Report acceptance-criterion results and verification claims against the current `SubjectReference`; when review is required, follow the active Workspace Policy. Final acceptance must use the independently authorized acceptance API; Context is one optional acceptance adapter, not a core dependency.

Exception: when the Hook explicitly reports `TaskCenter 门禁豁免白名单放行`, the current real Session may proceed without registration or an active task. Do not infer this exception from the content-reading allowlist; only the separate local gate-exemption allowlist grants it. Command safety checks still apply.

This workflow applies only to the Codex/Hook adapter in this repository. TaskCenter core records, offline evidence import, CI, PR, human and other adapters do not require a Codex Session. TaskCenter availability must not be made a prerequisite for an external project's build, test, commit or release; evidence may be backfilled with both occurrence and recording timestamps.

If the Codex TaskCenter MCP is unavailable in a gate-enabled Session, restrict project-file work to read-only inspection and report `TASKCENTER_UNAVAILABLE`.

## Verification

```bash
npm run sync
npm run lint
npm test
git diff --check
```

## 运行中服务保护

- 开发、修复、构建和测试期间必须保持当前健康的 TaskCenter 实例持续运行，不得直接停止、重启或用未验证代码替换它。
- `service:stop` 与 `service:restart` 对健康实例默认受硬门禁保护。代码完成、验证通过并提交后，只能使用 `npm run service:deploy` 重新部署。
- 受控部署必须在原 PID 持续健康的情况下完成 lint、完整测试、Git revision 与干净工作区校验；任何切换前检查失败都必须保留原实例且不得切换。全部检查通过后才进入重新部署阶段，该阶段不属于开发或修复阶段。
- `TASKCENTER_ALLOW_SERVICE_DISRUPTION=1` 仅用于人工明确停机或隔离测试环境，不得作为 Agent 开发或部署捷径。

## Git 提交

- 项目改动完成且验证通过后，默认自动创建本地 Git 提交，无需再次等待用户确认；除非用户明确要求暂不提交。
- 功能性改动的提交信息使用 `feat: 中文描述`，描述应准确概括本次交付；修复、文档等明确类型可使用对应 Conventional Commit 前缀并保持中文描述。
- 自动提交不等于推送。只有用户明确要求时才执行 `git push`、创建 PR 或发布版本。
