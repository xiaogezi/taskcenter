# Changelog

All notable changes to TaskCenter are documented here.

## Unreleased

- 修复 Kimi ACP 权限请求未携带参数时的工具关联：从同一调用的完整 JSON 参数快照校验权限，保留一次授权和任务门禁。

- 受管 Claude/Kimi 派发统一接入现有 Harness 操作，保留任务领取、逐工具权限和型号回执校验；集中配置支持客户端多模型目录及四个已核实的 Kimi 型号，旧 profile 继续兼容。

- 子任务派发收敛为主窗口自主选择 Luna、MiMo、K3；关闭 Codex 自动升级和容量回退，其他既有 Codex 执行型号标记退役，主窗口模型及历史记录不变。

- 修复任务创建与幂等重放整文件拆分事件历史导致控制服务内存溢出的问题；改为倒序分块读取，保留历史数据及原有幂等校验。

- 页面新增版本徽章：/health 透出 release（package version + 部署 revision），所有工作台页面右下角展示
- 修复：模型调度页 governance 读取接入代理白名单（/governance-metrics），避免整页加载失败
- 修复：任务事件索引裁剪无消费方的大文本字段（reason/review_reason/routing_reason 等），只保留详情白名单渲染与去重字段，源事件文件完整保留；索引体积下降、128 MB 堆下增量重建稳定（全量测试恢复全绿）。
- 额度池模型：config/model-roles.json 新增 quota_pools 定义（provider/models/source/notes），model-role-config 解析并随 /routing/health 透出；实测 kimi/claude CLI 无官方余额查询接口，MiMo/K3 池按 runtime-signal 标注（余额未知、仅限流信号与本地累计），Codex 池按官方 rate_limits 标注；额度池页面显示来源、覆盖模型、主次窗口与观测时间。
- 今日用量与执行器消耗：模型调度页新增"今日用量（24 小时）"（主代理 Token 与成本估算）与"CLI 执行器消耗"（运行次数、状态分布、按模型分组、回执 Token）；任务详情 CLI 执行记录显示每次回执用量；governance-metrics 新增 cliRuns 聚合，metrics-worker 定期写入。
- 模型健康卡片补充限流恢复时间、最后错误、最后成功；试点评估口径见 docs/delegated-cli-pilot.md。

- delegation CLI 运行增加中间态与心跳：领取后上报 running，权限校验与限流中断记录 waiting_permission/waiting_quota，执行中定期 touch 更新最后观测时间。任务详情展示 CLI 运行状态（启动/执行/等待权限/等待限流/失联/终态）与最后观测，失联与失败分开，信号不足标待确认。

- 任务详情与活动随刷新更新，分别展示加载、失败与上次成功观测；失败保留同任务旧数据，切换任务和迟到响应不串用。区分路由选择与有绑定证据的客户端报告模型，活动仅展示允许字段，工具调用不再暗示执行成功。

- 任务查询支持服务端按任务与 Session 精准过滤及显式 `view=summary`；默认 full 保留完整字段、全部结果和归档可见性。单任务摘要减少不必要历史，查询失败不再伪装成空结果，完成报告预读复用精准查询。

- Context 同步超时取消传输并阻止迟到响应触发后续写入，已发送操作明确为结果未知；映射与审计文件写入统一收紧至 0600。启停锁先准备完整 owner 再原子发布，旧版无 owner 锁保守报错；内容字段保留换行缩进并兼容旧事件重放。

- 修复任务账本超过 500 条时静默丢失历史与活跃任务的问题；查询及普通事件不再因会话源缺失自动移除任务。创建事件超出去重窗口仍核对历史，缺失任务拒绝直接复活；新增[只读恢复证据预览](docs/task-retention-recovery.md)，不自动写回或推断验收状态。

- 补齐 Node、Claude、Kimi 精确版本查询的 L0 放行，复用同一版本判定供终端检测使用；携带执行参数、重定向或写入的组合仍需任务授权。

- 修复无活跃任务时 CLI 路径探测被 Hook 误拦：精确放行 which、command -v/-V 和 type 查询，保留实际执行与写入授权；拒绝提示区分未识别只读命令与已检测写入。

- 新增 Kimi／Claude 可选 CLI 执行入口及集中 profile：绑定原任务路由和 delegation，真实 Session 领取后执行、回写并释放租约；请求型号、报告型号和推理档位分开记录。保留默认 executor/reviewer，未知结果不自动重试。

- 补齐跨客户端共享任务接手：复用 resume，保留创建者、当前执行者与交接记录；有效委派未结束时拒绝换手，旧 Session 不能借手动事件前缀继续更新任务。支持已启动客户端接手，不自动启动执行器。

- Claude SessionStart 注入真实 Hook 身份与生命周期调用指引，门禁拒绝时回显真实 Session；补齐完整参数、Context 语义绑定及验收项 ID 模板，防止自拟身份的 MCP 冒烟测试被误认为真实会话验收。

- 修复治理指标刷新大体积中文任务历史索引时的堆内存溢出：减少解码副本并按任务分段原子写回，保持索引格式、历史记录与现有内存上限。

- 引入同进程静态 Harness 适配层，统一能力查询与执行回执，迁移 Codex SDK/CLI 和 Kimi 受管 ACP 调用，保留旧入口与历史数据；会话页展示真实支持范围与用量口径。未知或未适配操作不回退到 Codex，通信异常保留结果未知并阻止普通派发重复提交。

- 整理手动按钮：任务列表与详情共享状态操作，已完成任务可重新处理或归档，归档详情可取消归档；明确状态操作不会自动启动或停止 Agent。改进建议区分刷新与重新分析，试点按钮明确请求语义，补充提交防重、Bug 取消编辑与派发状态刷新入口。

- 修复 Kimi 原生 Hook 把 Claude 形态 JSON 外壳原样写入 stdout 刷进终端与上下文的问题；现仅输出 `additionalContext` 纯文本，仅在出现 `permissionDecision` 时保留 JSON，并补协议测试。

- 修复 Kimi 原生 Hook 丢失 PCA 上下文注入：Kimi 0.43 的 `UserPromptSubmit` 载荷中 `prompt` 为内容块数组，直接透传给 PCA 共享桥接会因空 prompt 静默跳过 `prepare_turn`；现归一化为文本后再桥接，并补协议测试。

- Kimi 增加 Hook + ACP 受管入口：自动登记、PCA 上下文注入与回流、同会话恢复、取消与逐次权限确认；按真实 `session_<UUID>` 绑定 MCP 身份，记录上下文用量快照，未知费用不估算，不读取历史正文或改写用户配置。

- 集中多 Agent 标识与 TaskCenter 适配能力，新增能力查询、通用宿主 Session metadata 入口和身份查询；提供 Kimi Code CLI MCP 配置及基础闭环说明，保持 Codex 兼容和身份冲突拒绝，未适配能力明确标注。

- MCP 的 Session 登记、任务开始与任务更新/报告接口支持 `agent: "kimi"`，保留 Kimi 身份，无需再登记为 `unknown`。

- 修复旧接口返回的审查原因仍可能触发任务重新处理的问题；明确验证审查过期不阻塞流程，移除重复测试断言。

- 所有任务的 Review 均改为非阻塞信息，包括 `strict` 与历史 `required` 合同；审查缺失、过期、拒绝或未解决发现不再阻断完成判断、待验收分组或自动产生返工要求。审查真实性、验证、权限和独立验收约束继续保留，不批量改写历史记录。

- 本项目协作默认由用户安排外部 Agent Review，实施 Agent 不自动派发、等待、导入或处理审查结果；补充外部审查注意事项。此调整仅影响协作规则，不修改接口或历史审查策略。

- 已完成任务支持通过 `taskcenter_task_resume` 在当前或新 Session 接续原交付，恢复执行状态且不受等待时长限制；提交后的合并、验证无需重复建任务，仍校验任务归属、工作区和单活跃任务。Hook 拦截提示优先引导接续原任务。

- 任务工作区状态标签在窄列中保持完整显示；计划、阻塞和其他需处理任务可直接开始、恢复、重新处理或返工，已取消任务可二次确认归档，活跃任务可二次确认关闭；任务状态操作继续受同源代理与 Control API 校验保护。
- 归档任务不再进入默认任务列表和看板统计；任务详情与 append-only 事件历史继续保留，避免已完成任务长期堆积为待验证、待验收。
- 普通代码审查默认改用本地 `ocr_review.ocr_auto_review` MCP，保持免费模型优先和完整费用、积分、覆盖率回报；TaskCenter 正式独立审查继续绑定集中 `reviewer`、独立 Session 与同一 Subject/OCR 证据，普通自动审查不得冒充独立验收。
- 统一版本号、更新日志、受控部署与正式发布规则：`package.json` 为版本单一来源，Changelog 只保留一个 `Unreleased`，部署继续使用 Git revision，SemVer 与 tag 仅在明确发版时更新。
- TaskCenter MCP 集成改用稳定 launcher：从受控元数据解析当前不可变 release，避免开发工作树缺少依赖或发布切换导致 Codex 工具加载失败。

- 新增只读活跃任务复用 Advisor 与独立 append-only 决策审计，返回可解释的 `reuse/create_new/uncertain` 建议并完整保留 `force_new_reason`；Session/project 身份严格绑定，审计查询受本机 MCP 令牌保护，跨进程锁与可恢复的 event-id/顺序/project/workspace 索引保持并发幂等和有界查询；首阶段不增加 Hook 提示、阻断或自动合并。
- 新增 append-only 任务阶段事件与阶段报告，分别提供并行去重的任务墙钟、各执行器累计活动时间和显式等待来源；复用 Review Cycle 作为 Review 时间权威账本，并让旧任务保持 `unknown` 而非伪造零值。
- 正式服务改为运行不可变 release worktree 与 production build，开发工作区修改不再被当前实例热加载。
- 新增隔离候选自检、失败自动回滚、发布阶段事件与 `service:history` 研发效能摘要。

- Adds incremental `review_cycle.reported` observations, Review Attestation v3 linkage, finding fingerprints, review-stage distributions, data-quality coverage, long-tail diagnostics, Completion Packet review history, and a team-level Review governance panel while preserving legacy attestations unchanged.
- Keeps wall-clock and caller-reported active Review time separate, excludes unaccepted and independent OCR tasks from implementation completion ratios, and reports missing samples as data insufficient instead of zero.
- Recommends an independent Luna reviewer after known Spark OCR unavailability while retaining the same Subject, OCR Bundle and rules references plus explicit fallback and recovery audit fields.

- 门禁豁免支持按精确 Session 一键加入与退出，操作幂等且不会覆盖其他 Session。

- Adds a fail-closed, per-Session `scheduled_readonly` Hook profile for the fixed CyberRole context automation, scoped to one workspace, one rolling report, a fixed managed-payload probe, exact read-only MCP queries, and the sole ability to patch that report without TaskCenter/PCA/task mutation authority.
- Adds L0 registered-session deterministic read-only access with aggregate-only auditing, while keeping writes, composite shell forms, interpreters, redirects, and unregistered Sessions fail-closed.
- Defines L1 `fast`, L2 `standard`, and L3 `strict` defaults: verification is required for L2/L3, independent current-Subject review for L3, and Subject changes stale prior verification and review evidence.
- Adds `response_mode: summary|full` to task mutation/report MCP calls; summary is the compact default, while routing/delegation control calls retain full operational replies for backward compatibility.

- Adds `taskcenter_routing_select` and `taskcenter_routing_result` as a local model-routing control plane with per-model concurrency leases, TTL expiry, idempotent results, and `Closed/Open/Half-Open` circuit state.
- Keeps routing advisory and recoverable: TaskCenter never launches CLI executors, Sol can record a reasoned override, external work can use static fallback while the service is unavailable, and OCR reviewer failure cannot be auto-substituted as independent approval.
- Stores mutable routing health in ignored `data/routing-control.json` under the single control-server writer while retaining append-only `routing.decision` and `routing.health` task audit events.
- Opens the circuit immediately for explicit capacity, rate-limit, or model-unavailable responses and treats Codex `Bash` and desktop `exec_command` as the same delegation tool family.
- Adds short-lived CLI delegations so ordinary executors attach their own registered Session and auditable CLI Run to one formal parent task instead of creating duplicate formal subtasks.
- Enforces delegation workspace, TTL, optional tool allowlist, and file-tool scope boundaries; Shell execution requires explicit whole-workspace scope and never gains parent-task completion or acceptance authority.
- Adds platform-neutral v2 task contracts with structured acceptance criteria, optional execution environments, verification plans, versioned Workspace Policy, and legacy migration without rewriting history.
- Adds generic SubjectReference and ActorIdentity models, append-only Requirement Results, Verification Claims, Review Attestations, Acceptance Records, derived stale events, and machine-readable completion readiness.
- Adds Session-free core events, offline evidence import with occurrence/recording timestamps, JSON/Markdown exports, and an independently token-protected generic acceptance API; Context remains a compatibility adapter and `done_claimed` never auto-promotes to `accepted`.
- Adds MCP tools for subject updates, requirement/verification/review reporting, evidence import, readiness, export, Completion Packet, and independently authorized acceptance; TaskCenter availability is not a build/test/commit/release prerequisite.
- Replaces implicit full-session scanning with a fail-closed Session allowlist that filters files before JSONL parsing.
- Migrates only explicitly listed IDs from legacy `all` / `selected` selection files and keeps unapproved message bodies, cwd values, and summaries out of dashboard data.
- Adds a local reflection loop that derives auditable improvement proposals from aggregate allowlisted data and the task ledger without copying Session text or modifying source automatically.
- Adds manual accept, reject, and re-review actions for reflection proposals plus isolated persistence and cross-platform tests.
- Turns accepted proposals into idempotent formal tasks, then dispatches them to a selected existing or newly created Codex Session while preserving the Hook gate.
- Tracks proposal, task, Session, and dispatch linkage; Agent-completed improvements resolve when a new reflection pass no longer detects the signal, otherwise they reopen for review and can be manually returned when incomplete.
- Removes the default pending-review queue and per-task approval action: `done_claimed` appears as completed, while manual reject remains available for later corrections.
- Separates delivery deadlines (`dueAt`) from estimated active effort, tracks wall/active/blocked durations and estimate revisions, and keeps `expectedAt` as a legacy compatibility alias.
- Stops promoting legacy `expectedAt` values into delivery deadlines; only an explicitly recorded `dueAt` can produce delivery-overdue status.
- Emits idempotent Agent-facing calibration feedback for schedule lateness or active-effort overruns, while legacy tasks without segment evidence report active effort as unknown instead of reusing wall-clock time.
- Adds delivery delay, active-effort variance, and blocked ratio to aggregate planning reflection evidence and turns estimation calibration into explicit improvement-task acceptance criteria.
- Separates the empty-allowlist setup prompt from Agent improvement tasks, removes review/dispatch actions from that prompt, and dismisses it immediately after a non-empty allowlist is saved.
- Recognizes RTK-wrapped read-only inspection commands in the Hook while continuing to reject wrapped writes, shell control operators, and output-producing Git options.
- Adds a separate fail-closed Hook gate-exemption allowlist so explicitly selected Sessions may work without an active task while command safety checks remain enforced.
- Adds a Codex `UserPromptSubmit` preparation hook that tells non-allowlisted Agents to create or reactivate a formal task before their first write, while keeping exact Session allowlisting as the only task-gate exemption.
- Adds a Node-based cross-platform service controller with managed heartbeats and graceful stop requests for macOS, Linux/WSL2, and native Windows.
- Removes POSIX environment assignments and shell glob expansion from build and test scripts.
- Moves Hook recovery to the Node controller and covers PowerShell and Command Prompt interactive-process forms.
- Resolves standard Windows npm `codex.cmd` shims without interpolating prompts through a command shell.
- Adds `windows-latest` CI coverage and platform-neutral Context launcher tests.

## 0.1.5 - 2026-08-14

- Automatically restarts the local control service once when a Hook request finds it offline, then retries the original governance check.
- Adds an exact, project-root-only break-glass allowlist for the fixed `start` and `status` commands while continuing to block arbitrary writes.
- Launches the managed service in a detached process group so it survives the shell session that started it.

## 0.1.4 - 2026-08-14

- Removes the vulnerable `image-size` development dependency by temporarily pinning `vinext` to the last compatible release before it was introduced.
- Overrides Drizzle Kit's deprecated loader chain to use patched `esbuild` 0.25 or newer.
- Restores a clean full `npm audit` while keeping production dependencies unchanged.

## 0.1.3 - 2026-08-14

- Rejects single `&` and the remaining shell control operators before the Hook read-only fast path.
- Blocks additional stdin/interactive interpreter forms, including `env --`, script-plus-interactive flags, and `-` stdin markers.
- Restores terminating interpreter queries such as `--version` and `--help`.
- Treats non-JSON or non-object Context MCP success responses as protocol failures so compensation remains eligible.

## 0.1.2 - 2026-08-14

- Removes `git grep` from the Hook read-only allowlist because its pager options can execute external commands.
- Uses the canonical Codex `Bash` Hook payload and rejects known stdin-driven shell/REPL launch forms while documenting the guardrail boundary.
- Retries Context observation idempotency conflicts with the exact `543cf19` payload shape and keeps tests off the runtime map.
- Reads MCP and Context client versions from the package version and reports `0.1.2` consistently.
- Compares the empty tree to `HEAD` when the CI base is zero, missing, or disconnected.

## 0.1.1 - 2026-08-14

- Withdraws the affected `0.1.0` release and publishes the reviewed open-source tree under a new version.
- Preserves the complete legacy Context idempotency request, including `reqradar-context-*` event IDs and `reqradar_task_id` observation payloads.
- Removes `sed` from the read-only Hook allowlist and rejects interactive PTY or bare shell/REPL commands that could be continued through `write_stdin`.
- Isolates unit-test dashboard output while keeping `test:integration` pointed at the real synchronized dashboard.
- Handles missing or all-zero GitHub push base SHAs and standardizes the lockfile on the official npm registry.
- Replaces project-specific test roadmap data with explicitly synthetic fixtures.

## 0.1.0 - 2026-08-13 (withdrawn)

This release was withdrawn. Do not use or republish its tag or artifacts.

### Breaking migration from ReqRadar

- MCP server name changed from `reqradar` to `taskcenter`.
- Hook and MCP entrypoints changed to `scripts/taskcenter-hook.mjs` and `scripts/taskcenter-mcp.mjs`.
- MCP tools changed from `reqradar_session_register`, `reqradar_session_status`, `reqradar_task_create`, `reqradar_task_query`, `reqradar_task_update`, and `reqradar_task_report` to their `taskcenter_*` equivalents.
- All `REQRADAR_*` environment variables were renamed to `TASKCENTER_*`. Legacy names are not read; replace them before startup, especially session filters such as `REQRADAR_THREADS`, otherwise the default scan scope is `all`.
- Remove the old `reqradar` MCP server and Hook entries, then run `npm run integrations:print` and merge the generated `taskcenter` entries with the Codex and Claude Code configuration.
- Replace old absolute paths, restart Codex and Claude Code, verify `/mcp` and `/hooks`, and confirm the Session selection in the local dashboard before scanning.
- Remove the old ReqRadar desktop shortcut and run `npm run desktop:install` again. Runtime files remain local under the clone's `data/` directory and are not migrated automatically between clone locations.
- Context bridge external idempotency keys intentionally retain the legacy `reqradar-context-*` prefix so upgrades and compensation retries do not duplicate downstream effects.

- Initial open-source source release.
- Local task dashboard and Codex session discovery.
- TaskCenter MCP task protocol and task ledger.
- Codex and Claude Code Hook/MCP configuration templates.
- macOS desktop launcher.
- Local-only privacy and acceptance boundaries.
