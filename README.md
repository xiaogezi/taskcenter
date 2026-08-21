# TaskCenter（任务中心）

TaskCenter 是一个本地优先、核心协议与平台解耦的任务治理看板。人、Agent、CI、PR 审查平台和其他任务平台都可以创建任务、提交证据与独立验收；Codex、Claude Code、Context Agent、MCP 和 Hook 都只是可选适配器。

> 当前版本：`v0.1.5`。核心 Web、MCP、Hook 与服务控制支持 macOS、Linux/WSL2 和原生 Windows；桌面快捷入口仅支持 macOS。

## 核心能力

- 按真实 Session 展示 Agent 创建的正式任务。
- 跟踪目标、计划、当前步骤、阻塞、预计时间、测试和证据。
- 通过 Hook 在受支持工具调用前检查 Session 是否已登记且存在活跃任务。
- 通过显式 Session 白名单控制哪些本机 Codex JSONL 可以读取。
- 基于白名单聚合数据和任务账本生成可审核的本地改进提案。
- 所有任务账本和运行状态仅保存在本机。
- 以通用 `SubjectReference` 和 `ActorIdentity` 记录工作对象与参与者，不把 Git、Session 或单台机器作为核心前提。
- 支持离线补录、通用验收，以及 JSON/Markdown Completion Packet 导出。
- 作为轻量模型路由控制面保存熔断、并发租约、路由建议与审计，但不启动或管理 CLI。

## 隐私与安全边界

TaskCenter 只读访问：

- `~/.codex/sessions/**/*.jsonl`
- `~/.codex/session_index.jsonl`

TaskCenter 不读取 `~/.codex/auth.json`、API Key、Cookie 或其他认证材料，不会修改 Codex 会话，也不会将聊天内容上传到远端。项目默认只监听本机地址，不支持未经重新设计的数据脱敏、多用户鉴权和远程部署。

Session 内容采用 fail-closed 白名单：缺少 `data/session-selection.json`、配置损坏或白名单为空时，不读取任何 JSONL 正文。候选列表只从允许的本机索引和文件名读取 Session ID、标题与文件时间，便于人工勾选；未入白名单的消息、cwd 和摘要不会进入 dashboard 或反思输入。旧 `all` / `selected` 配置只迁移其中显式列出的 `threadIds`，不会把隐式 `all` 扩大为全量读取。

页面中的两套白名单职责独立：“读取白名单”决定哪些本机 Session JSONL 可以进入同步与反思；“门禁豁免”决定哪些 Session 在非只读工具调用前无需登记活跃任务。门禁豁免默认关闭、按 Session 显式配置，只跳过任务登记检查，不跳过交互式进程和命令形态等安全检查。

“自改进”采用复查闭环：TaskCenter 从白名单后的聚合结果与本地任务账本识别证据缺口、阻塞聚集、逾期和返工，输出结构化提案。提案只包含聚合计数和任务 ID，不复制 Session 正文。采纳后可选择已有或新建 Codex Session；TaskCenter 会先登记目标 Session 并创建幂等的正式改进任务，再派发受 Hook 保护的执行提示。Agent 上报 `done_claimed` 后即可再次运行反思：问题消失则标为已解决，仍存在则重新进入审核；人工发现未完成时可直接打回。TaskCenter 不直接修改源码、Hook、MCP 或 `~/.codex`。

估时用于校准计划，不作为完成判定。`dueAt` 表示显式交付截止，`estimatedEffortMs` 表示预计有效执行工时；TaskCenter 分别记录墙钟耗时、`in_progress` 有效工时和 `blocked` 等待时间，并保留每次调整的旧值、原因和时间。Hook 只在显式交付截止逾期或有效工时超预估后提供一次幂等反馈，要求区分范围变化、依赖阻塞与执行偏差，再调整估时或拆分任务。旧 `expectedAt` 只作为历史预计完成时间保留，用于估时校准，不会自动升级为 `dueAt` 或触发交付逾期。旧任务没有状态分段证据时会显示“有效工时未知”，不会把创建至今的累计时间伪装成执行工时。反思只聚合有效工时偏差、阻塞占比和显式交付延期等校准指标，不自动延期，也不因超时判定任务失败。

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

首次启动时白名单为空。打开“会话白名单”，勾选允许读取的 Session 并保存，再执行同步。空白名单只产生本机“待配置”提示，不创建任务，也不能派发给 Agent；保存非空白名单后提示自动消失。需要复盘时在“数据反思与改进提案”区域运行反思；只有 Agent 改进提案在采纳后才会选择已有 Session 或新建独立 Session、自动建任务并派发。Agent 声明完成后可直接点击“再次反思验证效果”。

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

定时只读自动化可为独立 Hook 命令配置 `--profile scheduled_readonly`。当前 Profile 固定身份为 `--automation-id cyberrole-agent-context --project-id cyberrole`，并要求显式绑定绝对 `--workspace-root` 与唯一 `--report-path`，同时声明 `--task-mutation false --pca-mutation false --network false`。它只取消已登记 Session 的 active task 前置条件：仅放行绑定工作区内的 `Read/Grep/Glob`、`git status`、`git rev-parse HEAD`、固定报告的 SHA-256 探针，以及明确列出的 Context/TaskCenter 查询；其他项目、解释器、复合 Shell、网络、Task/Context 写接口和 delegation 均 fail-closed。该 Profile 是 Hook 最小权限 guardrail，不替代 Codex sandbox 或操作系统网络隔离。

隔离自动化配置模板位于 [`integrations/codex/scheduled-readonly-hooks.json.example`](integrations/codex/scheduled-readonly-hooks.json.example)，其中 `PreToolUse` 必须匹配全部工具，避免 MCP 写接口从普通 Hook matcher 外绕过。该模板只用于专用自动化配置，不能直接覆盖日常 Codex Hook。占位路径必须替换为本机审核过的绝对路径：

```text
node "/absolute/path/to/taskcenter/scripts/taskcenter-hook.mjs" pre-tool-use --agent codex --profile scheduled_readonly --automation-id cyberrole-agent-context --project-id cyberrole --workspace-root "/absolute/path/to/CyberRole" --report-path "/absolute/path/to/cyberrole-agent-context.md" --task-mutation false --pca-mutation false --network false
```

Codex 配置中的 `UserPromptSubmit` Hook 会在非门禁豁免 Session 没有活跃正式任务时，提前向 Agent 注入任务准备指令。已登记且无活跃任务的 Session 可在 L0 运行单条确定性只读命令：`pwd`、`ls`、`cat`、`head`、`tail`、`wc`、`du`、`stat`、`file`、`rg`、`sed -n`、受限 `find`，以及限定的只读 `git` 子命令（可选前缀 `rtk`）。重定向、管道、命令替换、解释器和复合命令均会 fail-closed；提示会要求拆成单条只读命令，或创建任务。L0 只保留每个 Session 的计数聚合，不创建任务、验收或 Review，也不记录命令历史。未登记 Session 不享有 L0。

需要写入时由 Agent 主动登记并创建或复用任务后再调用工具，不应要求用户代为处理。L1 `fast` 默认不要求 verification plan 或 review；L2 `standard` 必须声明 verification plan、默认不要求独立 review；L3 `strict` 必须有 verification plan 和当前 Subject 的独立 review。Subject 更新会使旧验证和 Review 失效。CLI 没有 Agent 的路径可直接调用 Core HTTP/导入证据接口；它不依赖 Hook 或 MCP，恢复服务后再补录 `occurred_at` 与证据即可。`PreToolUse` 仍保留硬阻断作为兜底。只有显式加入“门禁豁免”白名单的精确 Session ID 才会跳过任务要求，不会按项目、目录或标题自动扩大豁免。

任务创建、更新、报告、Subject、证据导入与验收等写入型 MCP 支持 `response_mode: "summary" | "full"`，缺省为 `summary`。摘要只返回 `accepted`、`task_id`、`status`、`verification_status`、`review_status` 和 `missing_count`；排障、query、export 或需要兼容旧全量回包时显式传 `full`。`routing_select` 与 delegation 控制面必须返回模型租约、`route_id` 或一次性 claim token，为避免旧执行器失效，其默认仍为 `full`。

同一语义需求在用户反馈、测试失败或 Review 后修订时继续复用原任务，通过 `taskcenter_task_subject_update` 更新 Subject；只补跑受影响验证并对增量 diff 复审。首次遗漏原因、防回归措施和完成度变化记录在原任务事件中，不为普通修订重复创建正式任务。

在 Windows 上，TaskCenter 会安全解析标准 npm 安装生成的 `codex.cmd` 并直接调用其 Node 入口，避免把 Session prompt 拼进 shell。非标准批处理启动器应通过 `TASKCENTER_CODEX_COMMAND` 指向 `codex.exe`，或配合 `TASKCENTER_CODEX_PREFIX_ARGS` 显式配置。

## 通用完成协议与 Codex 适配器

TaskCenter Core 不依赖 Codex、Context Agent、OCR、GitHub/GitLab、Worktree 或 MCP，也不能成为外部项目 build、test、commit、merge 或 release 的强制条件。服务离线时工作可以继续，恢复后通过 `taskcenter_task_import_evidence` 补录；事件同时保存原始 `occurred_at` 与账本 `recorded_at`。

任务契约使用结构化 `AcceptanceCriterion { id, description, required }`。验证和审查绑定 `SubjectReference`，支持 `git_commit`、`git_worktree_snapshot`、`pull_request_head`、`artifact`、`document_version`、`external` 和 `none`。主体变化后旧证据自动 stale。参与者使用 `ActorIdentity`，审查独立性与验收身份由版本化 Workspace Policy 决定，而不是硬编码 Session 是否相同。绝对本地路径不能作为 standard/strict 的唯一跨团队证据。

以下步骤是 Codex/Hook 适配器的门禁流程，不是 TaskCenter Core 的通用前置条件：

默认情况下，每个 Session 按以下顺序执行：

1. `taskcenter_session_register`：提交真实 `session_id`、`workspace`、`agent`、`provider` 和 `model`。
2. `taskcenter_task_create`：新任务使用 `contract_version=v2`，提交目标、范围、非目标、计划、结构化验收标准、工作流等级、审查策略、可选执行环境，以及 `standard/strict` 所需的验证计划。
3. 收到 `accepted=true` 与独立 `task_id` 后才能执行写操作。
4. 使用 `taskcenter_task_update` 更新进度，使用 `taskcenter_task_report` 上报结果。
5. TaskCenter 可用时，Sol 在派发执行器前调用 `taskcenter_routing_select`。它会原子检查模型并发、`Closed/Open/Half-Open` 熔断状态并发放有 TTL 的执行租约；执行结束后调用 `taskcenter_routing_result` 释放租约并回报原始错误。TaskCenter 只给出强建议，不启动 CLI，也不取代 Sol 的风险判断、整合和验收。
6. Sol 有理由偏离建议，或 TaskCenter 暂时不可用而外部项目允许继续时，按静态规则执行并用 `taskcenter_routing_record` 记录 override；服务恢复后补录执行结果。TaskCenter 不得成为外部项目 build、test、commit 或 release 的单点依赖。本仓库自身启用 Hook 门禁时仍遵循 fail-closed 维护边界。
7. OCR 独立审查是例外：TaskCenter 可以记录 Spark reviewer 不可用，但不会自动把 Luna、Terra 或 Sol 标记为独立审查通过。
8. Agent 的 `done_claimed` 仅代表执行声明，提交时必须附带 `tests` 或 `evidence`；随后通过验收条件结果、Verification Claim 和独立 Review Attestation 计算 `completion_readiness`。
9. `accepted` 只能由携带 `TASKCENTER_ACCEPTANCE_TOKEN` 的独立验收适配器通过 `taskcenter_task_acceptance_report` 上报；来源可以是 human、pull_request、ci、task_platform、context_agent、manual 或 other。普通执行 Agent、`task_report` 和浏览器操作均不能直接设置最终验收。

主 Agent 派发普通 CLI 执行器时不再重复创建正式子任务。主 Agent 通过 `taskcenter_delegation_grant` 为当前正式任务签发短期授权，CLI 先登记自己的真实 Session，再以一次性 token 调用 `taskcenter_delegation_claim`。授权固定绑定父任务、CLI Session、精确 workspace、声明 scope、可选工具集合、执行模型和 TTL；CLI 用 `taskcenter_cli_run_report` 上报 started/running/终态、改动、测试与证据。CLI Run 只显示在主任务详情中，不获得修改主任务状态、审查或验收的权限。只有存在独立交付物、独立生命周期、独立验收或明确交接边界时，才创建正式子任务。

scope 为文件工具提供可执行的路径边界；可识别路径超出 scope 时 Hook 会阻断。任意 Shell 命令无法可靠静态证明实际写入路径，因此只有 scope 显式为整个 workspace（`.`）时才允许，同时仍受精确 workspace、Session、TTL 和 `allowed_tools` 约束。该机制是任务授权边界，不替代 Codex sandbox 或操作系统隔离。

完成闭环包含四层独立状态：执行 `done_claimed`、验证 `verification_status`、审查 `review_status`、最终验收 `acceptance_status`。`CompletionReadiness` 还返回当前 subject、机器可读 reason codes、缺失/失败条件、过期证据与未解决 findings。`strict` 默认要求当前 subject 的独立审查，但 Workspace Policy 可以显式调整。历史记录只追加，不覆盖。

如果 Hook 明确输出“门禁豁免白名单放行”，当前 Session 可以不执行登记和建任务步骤。该例外只来自独立的门禁豁免白名单，不能由内容读取白名单推断；命令安全检查仍然有效。

MCP 工具：

- `taskcenter_session_register`
- `taskcenter_session_status`
- `taskcenter_task_create`
- `taskcenter_task_query`
- `taskcenter_task_update`
- `taskcenter_task_report`
- `taskcenter_task_requirement_report`
- `taskcenter_task_verification_report`
- `taskcenter_task_review_report`
- `taskcenter_task_completion_readiness`
- `taskcenter_task_completion_packet`
- `taskcenter_task_subject_update`
- `taskcenter_task_import_evidence`
- `taskcenter_task_export`
- `taskcenter_task_acceptance_report`（仅独立验收进程配置 Token）
- `taskcenter_routing_record`
- `taskcenter_routing_select`
- `taskcenter_routing_result`
- `taskcenter_delegation_grant`
- `taskcenter_delegation_claim`
- `taskcenter_cli_run_report`
- `taskcenter_delegation_revoke`

控制服务提供无 Session 依赖的 `POST /core/task-events`、`POST /tasks/import-evidence`、`GET /tasks/:id/export?format=json|markdown`，以及受令牌保护的 `POST /task-acceptance-report`。旧 `POST /task-acceptance-sync` 继续作为 Context 兼容适配器。令牌只通过进程环境传递，不写入任务、事件、日志或仓库。

## 数据文件

运行态写入 `data/`，并由 `.gitignore` 排除，包括内容读取白名单 `session-selection.json`、门禁豁免白名单 `gate-session-allowlist.json`、CLI 授权账本 `delegations.json`、路由派生状态 `routing-control.json` 与 `reflection-proposals.json`。`routing-control.json` 是控制服务单写者维护的可变派生状态；不可变任务事件仍是审计依据，不承担锁或租约状态源职责。仓库只保留空白 seed、示例数据和空的 Session 合并配置。删除运行态前请确认范围；TaskCenter 不应删除或改写 `~/.codex` 下的会话与认证数据。

## 开发与验证

用量报告可通过 `node scripts/usage-report.mjs` 生成，默认只读取 `~/.codex/sessions/**/*.jsonl` 和本地任务账本；聚合使用每条记录的 `last_token_usage`，并按 `5h`、`24h`、`7d` 和 model/project/session/task 输出 input、cached input、output、average/P50/P95。报告支持注入 `sessionsRoot`、`ledger`、`rates`、`now`；全部未知费率时标记为 `unestimable`，混合已配置与未知费率（包括未配置的 Spark）时保留可估算部分并标记为 `partial`。

费率表位于 `config/model-rates.json`，只应填写模型提供方正式公布并经操作者确认的每百万 Token Credits；禁止用相近模型价格代填 Spark。`taskcenter_usage_report`、`taskcenter_session_lifecycle` 和 `taskcenter_governance_metrics` 分别提供用量、会话建议与试点指标。生命周期建议不会强制中断，且“新建 Codex Session”不等于“新建 TaskCenter task”：同一交付继续复用原任务并携带 1–2KB handoff。

普通闭环可用 `taskcenter_task_close` 一次提交最终报告、Requirement Results 与 Verification Claims，并直接取得 readiness；同一 `event_id` 重试幂等。它把典型的 verification、requirements、report、readiness 四次往返压缩为一次，同时保留原有细粒度接口和 OCR 独立 Session/attestation 路径。

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
