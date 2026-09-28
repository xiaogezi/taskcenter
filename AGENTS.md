# TaskCenter Agent Rules

## Safety boundaries

- TaskCenter is a local-only task governance tool. Do not add remote upload of session content without a separate privacy and authentication design.
- Read Codex session data only from `~/.codex/sessions/**/*.jsonl` and `~/.codex/session_index.jsonl`; model roles come only from this repository's `config/model-roles.json`.
- Never read `~/.codex/auth.json`, API keys, cookies, or other credentials.
- Never modify files under `~/.codex`; user-owned integration config changes require explicit user action.
- Treat an assistant's `done_claimed` status as an implementation claim, not acceptance.

## Required workflow

One registered Codex Session may carry multiple formal tasks sequentially. A new task may be created after the previous task is no longer `planned`, `in_progress`, or `blocked`; only one formal task may be active in a Session at a time. Reuse the existing task for the same deliverable, and create a distinct task for a new deliverable without requiring a new Session.

Before changing project files in an MCP-enabled session:

1. Prefer `taskcenter_task_begin` to register the real Session and create the task in one call. Existing clients may call `taskcenter_session_register` followed by `taskcenter_task_create`.
2. Supply a v2 contract with goal, scope, non-goals, plan, structured acceptance criteria, workflow profile, review policy, optional execution environment, and a verification plan for `standard` / `strict` work.
3. Continue only after `accepted=true` and a distinct `task_id` are returned.

For ordinary execution use native Codex sessions. The parent owns the formal task; each executor registers its real independent Session and claims a short-lived `taskcenter_delegation_grant` bound to the native route, task, workspace, scope, model and TTL. Report lifecycle/evidence through the existing `taskcenter_cli_run_report` API (also used by native sessions). New CLI/other grants are disabled under the current executor policy; historical CLI records and their report/revoke APIs remain available. A delegation is not a separate formal task or acceptance authority.

When TaskCenter routing is available, the user-selected current main model must call `taskcenter_routing_select` before launching an executor and must close the lease with `taskcenter_routing_result`, preserving the raw status, error classification, code, and request ID. The result is a strong default recommendation, not execution authority: TaskCenter stores health, circuit state, concurrency leases, and audit events but never starts processes or replaces the current main model's risk judgment, integration, or acceptance. A reasoned override must be recorded with `taskcenter_routing_record`. If TaskCenter is unavailable in an external project that is allowed to continue, use `config/model-roles.json` as the static routing policy and backfill the override/result after recovery; this repository's own gate-enabled maintenance remains fail-closed as stated below.

For each new ordinary execution phase, call `taskcenter_routing_select` with a stable `phase_id` and short `phase_summary`; reuse the decision within that phase. Use `channel=other` for the automatic path. Jev recommends task class, model and `delegate/direct/needs_context`, but cannot block the current main model from continuing an authorized task. Explicit `direct` requires a concrete `direct_reason` for audit, not a new user message, one-shot authorization, or restricted exception category. Legacy exception fields are optional and validated when supplied. `needs_context` returns a direct route so the main model checks existing context and asks only for material missing information. Jev failure uses the configured executor policy; no runnable model, missing native capability, exhausted quota or capacity falls back to an active `direct` lease for the current main Session, never CLI. Main-model direct execution does not consume executor capacity.

If spawning, registration, claim, tools or execution fail, preserve the actual failure in `routing_result`; correct a grant/tool mismatch at most once if useful, then stop the executor, confirm it no longer writes, revoke its delegation and request `channel=direct` with the actual failure reason. Continue the same authorized task without asking again for main-model permission or ending it because delegation failed. If routing_select itself fails, correct invalid input or request direct with the routing error as evidence. Task registration, ownership, workspace, safety checks and independent Reviewer restrictions still apply; this fallback grants no new task permissions. Never overlap executor and parent write ownership. The Codex Hook continues to require an active matching direct route for parent project execution.

Ordinary execution is native-only according to `roles.executor.dispatch_channel` in `config/model-roles.json`. The executor pool, cost preference order, runtime mappings (`native_models` plus `roles.executor.native_models`), per-model reasoning exceptions and concurrency limits come solely from that file. Jev chooses from the configured models intersected with the caller's actual `available_native_models`, with cost preference used when capability is sufficient. Do not infer spawn support from the desktop model selector. No runnable candidate returns an audited main-model direct fallback, never CLI. The existing task authority covers main-model takeover; no transcript phrase or repeated authorization is required. Native grant/claim binds an active route, canonical model, actual runtime model, independent Session and workspace; mismatches and ended leases are rejected. Default/task-class reasoning remains low/medium, with only explicitly user-authorized per-model exceptions in `model_reasoning_efforts`. Review remains arranged by the user and its role is unchanged.

A task may persist `execution_model_policy.mode=quota_preferred` only when the user explicitly chooses the exact model and quota pool. The model must be listed in `manual_only_models`: it never enters automatic role selection or ordinary fallback. A fresh non-exhausted pool selects it; an exhausted pool falls back through the existing executor policy; a missing or stale snapshot permits one bounded probe at a new dispatch boundary. Quota exhaustion is recorded separately from model quality failures, and reset only restores eligibility for the next dispatch—it never interrupts a running executor. Routing audit must retain the requested model, actual model, quota pool, snapshot time, usage, reset time, and switch reason.

Reasoning effort uses the same central role configuration. `reasoning_effort` is the low-cost default; `task_class_reasoning_efforts` and explicitly authorized `model_reasoning_efforts` exceptions determine the actual effort, which every route must expose and audit.

Review is arranged by the user through external Agents. Unless explicitly asked for a specific review action, the implementation Agent must not launch OCR/Reviewer, wait or poll for review, import reports, handle findings, or add review as a prerequisite for ordinary implementation, verification, local commit, or authorized deployment. Continue the authorized work and report its actual validation; never claim external review passed without evidence. For new ordinary tasks use `standard`/`fast` as appropriate and `review_policy=recommended`; do not opt into blocking review merely because a reviewer is available. Existing explicit `required` contracts and independent acceptance controls are not silently changed or bypassed. External reviewers should read [外部 Agent Review 注意事项](project-context/20-规范与标准/外部Agent审查注意事项.md). This project-specific user decision supersedes the previous automatic OCR/fail-closed reviewer orchestration workflow; it does not remove the existing APIs.

Create a formal child task only when the work has an independently owned deliverable, lifecycle, acceptance criteria, or handoff boundary. Delegation is not permission to mutate the parent task contract, completion state, review, or acceptance.

`done_claimed` is only the execution claim. Report acceptance-criterion results and verification claims against the current `SubjectReference`. Review never blocks completion, commit, handoff, merge eligibility or authorized deployment, including strict and historical required tasks. Keep Review status and evidence truthful; do not automatically process external findings. This supersedes any earlier blocking-review wording in these rules. Final acceptance must use the independently authorized acceptance API; Context is one optional acceptance adapter, not a core dependency.

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
- 正式实例必须运行 `.local/releases/<commit>` 的不可变 production build；候选实例必须使用独立端口、runtime、日志、Codex home 与数据目录。切换失败必须自动恢复上一已验证 release，并追加发布事件供 `service:history` 复盘。
- `TASKCENTER_ALLOW_SERVICE_DISRUPTION=1` 仅用于人工明确停机或隔离测试环境，不得作为 Agent 开发或部署捷径。

## Git 提交

- 项目改动完成且验证通过后，默认自动创建本地 Git 提交，无需再次等待用户确认；除非用户明确要求暂不提交。
- 功能性改动的提交信息使用 `feat: 中文描述`，描述应准确概括本次交付；修复、文档等明确类型可使用对应 Conventional Commit 前缀并保持中文描述。
- 自动提交不等于推送。只有用户明确要求时才执行 `git push`、创建 PR 或发布版本。

## 版本与更新日志

- 统一遵循 `CONTRIBUTING.md#versioning-and-changelog`；该章节是版本号、Changelog、部署与正式发布的唯一完整规则，不在其他文件复制一套定义。
- 影响用户入口、公共协议、持久化、安全边界、模型角色或发布方式的改动，必须在同一提交更新顶部唯一的 `CHANGELOG.md / Unreleased`。其他改动可以不更新，但须在 TaskCenter 证据或 PR 中记录 `changelog: not required` 及理由。
- 普通提交和 `service:deploy` 不自动修改 SemVer。只有用户明确要求正式发布时，才允许修改版本、封版 Changelog、创建 tag；push、远端 tag、PR 和 hosted release 仍需分别获得明确授权。
