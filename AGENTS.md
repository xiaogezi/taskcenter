# TaskCenter Agent Rules

## 底层原则：任务即契约

**任务即契约：以契约约束执行，以持久状态管理过程，以证据判定完成。**

所有后续改动必须符合这一原则；新增能力应说明其如何服务契约、过程状态或交付证据，不能削弱已有约束。

- 契约约束执行：明确目标、范围、授权与验收条件。执行方法可在契约内调整；扩大范围、改变目标或降低验收标准必须形成显式契约变更，不得静默修改。
- 持久状态管理过程：任务事实、进展、阻塞与恢复依据必须可持久化、可追溯，不能仅依赖聊天或进程内状态。结果未知时先核对已有事实，再决定恢复或重试，避免重复副作用。
- 证据判定完成：完成结论依据验收条件及绑定当前工作对象、契约和产物版本的证据；Agent 声明、命令已发出或单项测试通过不能替代独立验收。验证强度与风险相称，未验证项如实记录。

PCA 提供版本化规格与项目知识；TaskCenter 管理本次委托的契约、生命周期与交付证据，最终验收由独立授权主体完成。模型选择、派发、工具执行、重试与终止仍归宿主和当前主模型；该原则不恢复已退役的编排能力，也不增加自动 Review 门禁。

## Safety boundaries

- TaskCenter is a local-only task governance tool. Do not add remote upload of session content without a separate privacy and authentication design.
- Read Codex session data only from `~/.codex/sessions/**/*.jsonl` and `~/.codex/session_index.jsonl`.
- Never read `~/.codex/auth.json`, API keys, cookies, or other credentials.
- Never modify files under `~/.codex`; user-owned integration config changes require explicit user action.
  - 唯一例外：格子已批准 `instory-pca-2` 的单个 `automations/instory-pca-2/memory.md` 通过 `apply_patch` 新建/更新。必须由 `config/automation-memory.json` 的启用绑定、本机宿主 automation Session 元数据、启动消息和登记工作区共同验证，补丁与落盘均须通过结构/路径/成功基线校验并留审计；不得修改其他 `~/.codex` 文件或配置，不授予 inStory 仓库写入。
- Treat an assistant's `done_claimed` status as an implementation claim, not acceptance.

## Required workflow

One registered Codex Session may carry multiple formal tasks sequentially. A new task may be created after the previous task is no longer `planned`, `in_progress`, or `blocked`; only one formal task may be active in a Session at a time. Reuse the existing task for the same deliverable, and create a distinct task for a new deliverable without requiring a new Session.

Before changing project files in an MCP-enabled session:

1. Prefer `taskcenter_task_begin` to register the real Session and create the task in one call. Existing clients may call `taskcenter_session_register` followed by `taskcenter_task_create`.
2. Supply a v2 contract with goal, scope, non-goals, plan, structured acceptance criteria, workflow profile, review policy, optional execution environment, and a verification plan for `standard` / `strict` work.
3. Continue only after `accepted=true` and a distinct `task_id` are returned.

TaskCenter governs only the main Session and its formal task. Model selection, subagent creation, execution, tools, retries and termination belong to the host and current main model. Do not call routing, delegation or managed Reviewer APIs: they are retired. Subagent Hook events bypass TaskCenter before any service request or registration; the main Session still requires task ownership and verification. Historical routing and delegation files remain untouched and are not runtime dependencies.

Review is arranged by the user through external Agents. Unless explicitly asked for a specific review action, the implementation Agent must not launch OCR/Reviewer, wait or poll for review, import reports, handle findings, or add review as a prerequisite for ordinary implementation, verification, local commit, or authorized deployment. Continue the authorized work and report its actual validation; never claim external review passed without evidence. For new ordinary tasks use `standard`/`fast` as appropriate and `review_policy=recommended`; do not opt into blocking review merely because a reviewer is available. Existing explicit `required` contracts and independent acceptance controls are not silently changed or bypassed. External reviewers should read [外部 Agent Review 注意事项](project-context/20-规范与标准/外部Agent审查注意事项.md). This project-specific user decision supersedes the previous automatic OCR/fail-closed reviewer orchestration workflow; it does not remove the existing APIs.

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

- 收尾复用既有命令日志、发布事件和验证结果，注明对应 Subject/产物版本、环境及验收条件；三者未变且已通过时不重复检查，不另建汇总 JSON、Completion Packet 或报告模板。缺少必要证据、源码/配置/环境变化或验收条件变化时，只补受影响的验证；未覆盖本次变更的旧结果不能充当通过证据。
- 上述完整检查仍须满足；`service:deploy` 内置的完整测试、健康与版本/干净工作区门禁必须实际执行，不得以开发阶段已测或证据复用为由跳过。部署后仅补候选与部署入口尚未覆盖的上线冒烟；自动清理已明确成功时，不再默认追加 prune、dry-run 或目录盘点。失败、结果未知或身份/引用不一致时核对已有事实并补必要检查。
- 使用现有 `taskcenter_task_close` 一次提交验收条件结果、当前 Subject 的验证声明及原生日志/事件引用，直接使用返回的就绪度，不再默认追加 query/report。结果未知时先核对落账事实，重试遵守原幂等契约；保留独立验收边界。
- 等待沿用工具与宿主允许的较长有界等待，仅在进展、失败或必要响应时读取日志和更新；交付简述实际变更/部署版本、验证结果、证据位置及未完成项，验收达标后停止。纯规则/文档变更无需新增运行日志或行为冒烟。

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
