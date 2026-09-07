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

页面中的两套白名单职责独立：“读取白名单”决定哪些本机 Session JSONL 可以进入同步与反思；“门禁豁免”决定哪些 Session 在非只读工具调用前无需登记活跃任务。门禁豁免默认关闭、按 Session 显式配置；打开“门禁豁免”后，每个精确 Session 都可一键“加入豁免”或“退出豁免”，操作立即生效且不会覆盖其他 Session。豁免只跳过任务登记检查，不跳过交互式进程和命令形态等安全检查。

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
npm run service:deploy
npm run service:history
```

运行中的健康实例默认受到保护，直接执行 `service:stop` 或 `service:restart` 会被拒绝。开发和修复期间保持原实例运行；代码完成、验证通过并提交后，使用 `npm run service:deploy`。

受控发布按固定阶段执行：

```text
干净提交 → lint/完整测试 → 不可变 release worktree → production build
→ 隔离数据与随机端口候选自检 → 准备上一版本回滚包
→ 稳定端口切换 → 健康确认 → 成功或自动恢复上一版本
```

正式实例运行 `.local/releases/<commit>` 中的生产构建，不再监听日常开发工作区；候选实例使用 `.local/candidates/` 下的临时 runtime、日志、Codex home 和数据目录，不读取或写入正式账本。原 PID 在 lint、测试、构建和候选健康检查期间持续提供服务，任一切换前检查失败都保留原实例。稳定端口切换失败时会自动启动上一已验证 release。人工明确停机可临时设置 `TASKCENTER_ALLOW_SERVICE_DISRUPTION=1`，不得把该变量用于常规 Agent 开发或部署。

首次安装尚无 `active-release.json` 时，`service:start` 会先校验干净提交、执行 lint 和完整测试，再构建并启动不可变 release；不会回退到主工作区的 `vinext dev`。`TASKCENTER_ALLOW_LEGACY_DEV_START=1` 仅供隔离测试夹具使用，不得用于正式实例。

每次发布会把阶段、revision、前一 revision、耗时、候选端口和最终结果追加到 `.local/release-events.jsonl`。`npm run service:history` 输出发布次数、成功率、回滚率、P50/P95 耗时和最近一次结果，用于复盘发布失败、优化测试与缩短反馈周期；事件不包含 Session 正文或凭据。

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
codex mcp add taskcenter -- node "/absolute/path/to/taskcenter/scripts/taskcenter-mcp-launcher.mjs"
codex mcp list
```

将生成的 Hook 配置合并到 `~/.codex/hooks.json`，并确认 `~/.codex/config.toml` 包含：

```toml
[features]
hooks = true
```

重新启动 Codex，在 `/hooks` 中审核并信任 Hook，在 `/mcp` 中确认 `taskcenter` 已连接。也可以把 MCP 配置放进可信项目的 `.codex/config.toml`。

v2 任务不能通过普通 `taskcenter_task_report(done_claimed)` 绕过闭环；Agent 应使用 `taskcenter_task_close` 原子提交验收与验证证据，并读取返回的 `completionReadiness`。完成就绪度、缺失验证和 Review 继续由 TaskCenter 记录和展示，但不会通过 `Stop` Hook 打断 Codex 回复；用户可以在后续发现问题时人工打回任务。旧配置中即使暂时保留 TaskCenter `Stop` 命令，当前脚本也会兼容地直接放行。

### Claude Code

注册用户级 MCP：

```bash
claude mcp add --scope user --transport stdio taskcenter -- \
  node "/absolute/path/to/taskcenter/scripts/taskcenter-mcp-launcher.mjs"
claude mcp list
```

将生成的 Hook 配置合并到 `~/.claude/settings.json`。如需项目共享 MCP，可将 `integrations/claude/mcp.json.example` 复制为目标项目的 `.mcp.json`，替换路径后由使用者审核授权。

配置变更只对新启动或重新加载的 Session 生效。Hook 会在本机控制服务意外退出时尝试一次自动恢复；恢复失败仍会阻断普通写操作，并只允许在项目根目录执行固定的跨平台 break-glass 命令：`node scripts/taskcenter-control.mjs start`（启动）或 `node scripts/taskcenter-control.mjs status`（诊断）。旧的 `/bin/bash scripts/taskcenter-control.sh ...` 入口继续作为 macOS/Linux 兼容薄封装。

定时自动化可通过条件 Hook 启用 `scheduled_readonly`。当前 Profile 固定身份为 `--automation-id instory --project-id instory`，并要求显式绑定绝对 `--workspace-root` 与唯一 `--report-path`，同时声明 `--task-mutation false --pca-mutation false --report-mutation true --network false`。`UserPromptSubmit` 只有同时命中`Automation ID: instory` 独立行、绑定报告的绝对路径和 `<!-- AUTO-MANAGED-BEGIN -->` 标记时才为当前 Session 登记 Profile，普通 Session 直接 no-op。它取消 active task 前置条件，但只放行绑定工作区内的 `Read/Grep/Glob`、严格参数校验的 `rtk cat` / `rtk head -n` / `rtk tail -n` / `rtk sed -n '<行范围>p'`、`git status`、`git rev-parse HEAD`、TaskCenter 自带的固定 managed-payload 探针、唯一报告的 `apply_patch`，以及明确列出的 Context/TaskCenter 查询。`apply_patch` 同时兼容 Codex canonical `tool_input.command` 与自由文本载荷，现有报告只接受单个 `Update File`；报告不存在时允许单个 `Add File`，内容只能是完整托管区块（含哈希行），路径限于工作区 `project-context/90-Agent提案/自动化报告` 下的单个 `.md`，缺失目录可由补丁创建，路径不得经过符号链接，且要求补丁可唯一、精确地应用并保持托管区块外字节不变；Hook 会在写前补齐托管内容对应的 `sha256-v1`，并由 `PostToolUse` 再次校验真实落盘结果。Shell 读取只接受一个真实存在且位于绑定工作区或等于唯一报告的文件；多文件、覆盖式 Add、Delete/Move、未知选项、`sed -i`、管道、重定向和复合命令继续拒绝。其他项目和文件、解释器、网络、Task/Context 写接口和 delegation 均 fail-closed。该 Profile 是 Hook 最小权限 guardrail，不替代 Codex sandbox 或操作系统网络隔离。

当定时会话需要枚举项目文件时，可以直接对 Agent 说“为当前 scheduled_readonly Session 开启扫描豁免”或“退出扫描豁免”。Agent 调用 `taskcenter_scheduled_readonly_scan_exemption_status` / `taskcenter_scheduled_readonly_scan_exemption_set`，并传入当前 Hook payload 的真实 `session_id`；Hook 会校验它与当前 Session 完全一致，拒绝跨 Session 修改。开启后只额外允许绑定工作区内无管道、无重定向、无复合控制符的 `rtk git ls-files [工作区内路径]`、`git check-ignore [安全选项] [工作区内路径]` 和 `git branch --show-current`，不开放外部 exclude 文件、脚本、网络、跨项目读取或任何新增写入；Profile 重新检测会保留该状态，退出后立即恢复原 Profile。扫描豁免只更新 Session Profile，不创建正式任务。

条件配置模板位于 [`integrations/codex/scheduled-readonly-hooks.json.example`](integrations/codex/scheduled-readonly-hooks.json.example)。将其中两个 matcher group 合并到现有日常 Hook，而不是覆盖整个文件；普通 Session 不登记 Profile，因此不会改变现有门禁。占位路径必须替换为本机审核过的绝对路径。固定完整性命令由 Hook 注入，不允许自动化自行拼接 Node/Python/管道：

```text
rtk node "/absolute/path/to/taskcenter/scripts/scheduled-report-probe.mjs" --report "/absolute/path/to/inStory/project-context/90-Agent提案/自动化报告/附件-项目研发效能夜间优化探索.md"
```

Codex 配置中的 `UserPromptSubmit` Hook 会在非门禁豁免 Session 没有活跃正式任务时，提前向 Agent 注入任务准备指令。已登记且无活跃任务的 Session 可在 L0 运行单条确定性只读命令：`pwd`、`ls`、`cat`、`head`、`tail`、`wc`、`du`、`stat`、`file`、`rg`、`sed -n`、受限 `find`，以及限定的只读 `git` 子命令（可选前缀 `rtk`）。重定向、管道、命令替换、解释器和复合命令均会 fail-closed；提示会要求拆成单条只读命令，或创建任务。L0 只保留每个 Session 的计数聚合，不创建任务、验收或 Review，也不记录命令历史。未登记 Session 不享有 L0。

需要写入时由 Agent 主动登记并创建或复用任务后再调用工具，不应要求用户代为处理。L1 `fast` 默认不要求 verification plan 或 review；L2 `standard` 必须声明 verification plan、默认不要求独立 review；L3 `strict` 必须有 verification plan 和当前 Subject 的独立 review。Subject 更新会使旧验证和 Review 失效。CLI 没有 Agent 的路径可直接调用 Core HTTP/导入证据接口；它不依赖 Hook 或 MCP，恢复服务后再补录 `occurred_at` 与证据即可。`PreToolUse` 仍保留硬阻断作为兜底。只有显式加入“门禁豁免”白名单的精确 Session ID 才会跳过任务要求，不会按项目、目录或标题自动扩大豁免。

任务创建、更新、报告、Subject、证据导入与验收等写入型 MCP 支持 `response_mode: "summary" | "full"`，缺省为 `summary`。摘要只返回 `accepted`、`task_id`、`status`、`verification_status`、`review_status` 和 `missing_count`；排障、query、export 或需要兼容旧全量回包时显式传 `full`。`routing_select` 与 delegation 控制面必须返回模型租约、`route_id` 或一次性 claim token，为避免旧执行器失效，其默认仍为 `full`。

同一语义需求在用户反馈、测试失败或 Review 后修订时继续复用原任务，通过 `taskcenter_task_subject_update` 更新 Subject；只补跑受影响验证并对增量 diff 复审。首次遗漏原因、防回归措施和完成度变化记录在原任务事件中，不为普通修订重复创建正式任务。

TaskCenter 与 ProjectContextAgent 关联后，Completion Packet 是交付完成证据的唯一桥接对象：`fast` 任务在 TaskCenter 门禁通过后可自动同步；`strict` 任务必须在页面核对当前 Subject、验收、验证、独立 Review 和未决 finding，再点击“完成并同步 ProjectContext”。页面确认会触发 ProjectContextAgent 的原生用户授权弹窗，并签发绑定 task、Subject 和 packet digest 的一次性授权；重试复用 request ID，不会产生重复完成事件。两端默认共享 `~/.local/state/project-context-agent/taskcenter-attestation-token` 中权限为 `0600` 的专用凭证；可用 `PROJECT_CONTEXT_ATTESTATION_TOKEN_PATH` 同时覆盖两端路径，或通过 `TASKCENTER_CONTEXT_ATTESTATION_TOKEN` 与 `AGENT_WEB_ATTESTATION_TOKEN` 显式提供相同值。该凭证不等于 Dashboard token，也不取消原生确认。

在 Windows 上，TaskCenter 会安全解析标准 npm 安装生成的 `codex.cmd` 并直接调用其 Node 入口，避免把 Session prompt 拼进 shell。非标准批处理启动器应通过 `TASKCENTER_CODEX_COMMAND` 指向 `codex.exe`，或配合 `TASKCENTER_CODEX_PREFIX_ARGS` 显式配置。

## 通用完成协议与 Codex 适配器

TaskCenter Core 不依赖 Codex、Context Agent、OCR、GitHub/GitLab、Worktree 或 MCP，也不能成为外部项目 build、test、commit、merge 或 release 的强制条件。服务离线时工作可以继续，恢复后通过 `taskcenter_task_import_evidence` 补录；事件同时保存原始 `occurred_at` 与账本 `recorded_at`。

### 只读诊断与闭环引用

已登记但没有活跃任务的普通 Session 可使用 L0 只读查询，包括带引号的正则检索（如 `rtk rg 'foo|bar' README.md`）、`rtk proxy` 包装以及固定 `adb devices [-l]` / `adb version` 探针。引号内的正则符号按字面参数处理；管道、重定向、命令替换、变量展开、不完整引号和执行型参数继续拒绝。`npm run service:status` 不属于固定只读探针，因为任意工作区的同名 npm script 可执行任意代码。L0 不等同于文件系统沙箱，也不会恢复 Codex 尚未挂载的 MCP；服务不可用仍遵循离线恢复门禁。

闭环的两个 `requirement_id` 指向不同集合：`close_requirements[].requirement_id` 引用 `acceptance_criteria[].id`；`close_verifications[].requirement_id` 引用 `verification_plan[].id`，其 `kind` 必须匹配计划。Claim 自身 `id` 是唯一证据记录 ID。引用错误返回 `UNKNOWN_ACCEPTANCE_REFERENCE` / `UNKNOWN_VERIFICATION_REFERENCE` 和合法 ID，类型不符返回 `VERIFICATION_KIND_MISMATCH`。应在一次 `task_close` 中提交整包证据。请求校验失败后可修正再提交；已成功落账的 event_id 只能重放相同内容，不能用幂等键覆盖已记录事实。

### TaskCenter 与 ProjectContext 的职责边界

TaskCenter 是执行合同、运行状态、验证、Review、验收与路由审计的权威来源。ProjectContext 管理项目事实、决策、待审核知识与跨 Session 上下文，其语义任务用于组织上下文，不应替代 TaskCenter 的执行状态。现有 `scripts/context-bridge.mjs` 与 completion adapter 已承载映射和 Completion Packet 投递；这是已有能力，而非新增桥接。

后续整合优先复用稳定 task/context 关联和摘要投递，避免 Agent 手动维护两套执行状态。Context 投递失败保留 TaskCenter 已落账事实并走补偿，不能回滚或伪造验收。现有 Context 语义任务和生命周期适配仍保留；删除重复接口或迁移状态机需要独立设计与兼容性验证。

任务契约使用结构化 `AcceptanceCriterion { id, description, required }`。验证和审查绑定 `SubjectReference`，支持 `git_commit`、`git_worktree_snapshot`、`pull_request_head`、`artifact`、`document_version`、`external` 和 `none`。主体变化后旧证据自动 stale。参与者使用 `ActorIdentity`，审查独立性与验收身份由版本化 Workspace Policy 决定，而不是硬编码 Session 是否相同。绝对本地路径不能作为 standard/strict 的唯一跨团队证据。

以下步骤是 Codex/Hook 适配器的门禁流程，不是 TaskCenter Core 的通用前置条件：

默认情况下，每个 Session 按以下顺序执行：

1. `taskcenter_session_register`：提交真实 `session_id`、`workspace`、`agent`、`provider` 和 `model`。
2. `taskcenter_task_create`：新任务使用 `contract_version=v2`，提交目标、范围、非目标、计划、结构化验收标准、工作流等级、审查策略、可选执行环境，以及 `standard/strict` 所需的验证计划。Session 登记可同时提供稳定的 `project_id`，供后续复用 Advisor 跨 Session 匹配；旧 Session 缺失时保持 unknown，不从仓库名伪造。
3. 收到 `accepted=true` 与独立 `task_id` 后才能执行写操作。
4. 使用 `taskcenter_task_update` 更新进度，使用 `taskcenter_task_report` 上报结果。
5. TaskCenter 可用时，Sol 在派发执行器前调用 `taskcenter_routing_select`。它会原子检查模型并发、`Closed/Open/Half-Open` 熔断状态并发放有 TTL 的执行租约；执行结束后调用 `taskcenter_routing_result` 释放租约并回报原始错误。TaskCenter 只给出强建议，不启动 CLI，也不取代 Sol 的风险判断、整合和验收。
   当前 executor 通过 `roles.executor.task_class_models` 选择角色池内模型：`general`、`search`、`mechanical`、`documentation` 使用默认 Luna；`implementation`、`test`、`architecture`、`migration`、`complex_diagnosis` 使用 Terra；只有 `security`、`data_migration`、`high_risk` 默认使用 GPT-6 Astra。普通任务只回退 Terra，不把 Astra 当作容量兜底；映射到非默认模型的任务在目标模型不可用时不降级。需要因真实失败、风险证据或用户明确判断升至 Astra 时，调用方必须显式传 `preferred_model=gpt-6-astra` 并通过 `routing_record` 写明理由；该显式 Astra 选择同样不降级。Reviewer 固定使用 Astra，fallback 为空并 fail closed；两个角色的推理等级均为 `medium`。返回的 `config_version` 是集中配置内容 SHA-256，`matched_rule` 记录命中规则，`policy_version` 保留路由控制协议版本；配置每次新 `routing_select` 重新加载，运行中的租约不受热更新影响。同一 `event_id` 始终重放原选择，即使配置已更新。
   正式实例的 `TASKCENTER_MODEL_ROLE_CONFIG_PATH` 固定指向控制器工作区的可编辑 `config/model-roles.json`，release worktree 只承载代码，不成为模型策略副本。显式 `preferred_model` 仍优先于 task class 映射；retired 模型沿用既有归一化行为。Reviewer 始终使用 reviewer 主模型并 fail closed，OCR 继续要求同一 Subject、Bundle 和规则证据，不接受 task class 映射或容量回退。
   回滚时删除对应 `task_class_models` 映射并恢复原 JSON；新派发立即回到 executor 主模型，已发放租约按原策略结算。
6. Sol 有理由偏离建议，或 TaskCenter 暂时不可用而外部项目允许继续时，按静态规则执行并用 `taskcenter_routing_record` 记录 override；服务恢复后补录执行结果。TaskCenter 不得成为外部项目 build、test、commit 或 release 的单点依赖。本仓库自身启用 Hook 门禁时仍遵循 fail-closed 维护边界。
7. OCR 独立审查保持 reviewer 独立性：Spark 已知不可用时，TaskCenter 默认推荐 Luna，并记录 `fallback_from`、`fallback_reason`、`retry_after_at` 及同一 Subject、OCR Bundle、规则的引用或 fingerprint。TaskCenter 只返回建议和写入审计；独立只读 Luna Session、相同 Bundle/规则加载和实际审查仍由 Agent/OCR Skill 完成。Terra、Sol 或普通实现 CLI Run 不能冒充独立 OCR 审查通过。
8. Agent 的 `done_claimed` 仅代表执行声明，提交时必须附带 `tests` 或 `evidence`；随后通过验收条件结果、Verification Claim 和独立 Review Attestation 计算 `completion_readiness`。
9. `accepted` 只能由携带 `TASKCENTER_ACCEPTANCE_TOKEN` 的独立验收适配器通过 `taskcenter_task_acceptance_report` 上报；来源可以是 human、pull_request、ci、task_platform、context_agent、manual 或 other。普通执行 Agent、`task_report` 和浏览器操作均不能直接设置最终验收。

主 Agent 派发普通 CLI 执行器时不再重复创建正式子任务。主 Agent 通过 `taskcenter_delegation_grant` 为当前正式任务签发短期授权，CLI 先登记自己的真实 Session，再以一次性 token 调用 `taskcenter_delegation_claim`。授权固定绑定父任务、CLI Session、精确 workspace、声明 scope、可选工具集合、执行模型和 TTL；CLI 用 `taskcenter_cli_run_report` 上报 started/running/终态、改动、测试与证据。CLI Run 只显示在主任务详情中，不获得修改主任务状态、审查或验收的权限。只有存在独立交付物、独立生命周期、独立验收或明确交接边界时，才创建正式子任务。

scope 为文件工具提供可执行的路径边界；可识别路径超出 scope 时 Hook 会阻断。任意 Shell 命令无法可靠静态证明实际写入路径，因此只有 scope 显式为整个 workspace（`.`）时才允许，同时仍受精确 workspace、Session、TTL 和 `allowed_tools` 约束。该机制是任务授权边界，不替代 Codex sandbox 或操作系统隔离。

完成闭环包含四层独立状态：执行 `done_claimed`、验证 `verification_status`、审查 `review_status`、最终验收 `acceptance_status`。`done_claimed` 在 UI 中显示为“已声明完成”，不能等同于真正完成。`CompletionReadiness` 还返回当前 subject、机器可读 reason codes、缺失/失败条件、过期证据、未解决 findings 与 `completionClaim.allowed`；只有该字段为 `true` 时，调用方才可以向用户宣称任务真正完成。`strict` 默认要求当前 subject 的独立审查，但 Workspace Policy 可以显式调整。历史记录只追加，不覆盖。

新版 Review Attestation 使用 `review_contract_version=v2`，由同一个独立 reviewer 按顺序提交 `spec_verdict`、`quality_verdict`、总体 `verdict` 和 `unverified_requirements`。总体 `approved` 仅在规格 `compliant`、质量 `approved`、没有未验证要求且没有未解决 finding 时成立。旧记录继续按 `legacy` 读取，不伪造缺失的双结论。

如果 Hook 明确输出“门禁豁免白名单放行”，当前 Session 可以不执行登记和建任务步骤。该例外只来自独立的门禁豁免白名单，不能由内容读取白名单推断；命令安全检查仍然有效。

在已加载新版 MCP 的 Codex Session 中，可以直接对 Agent 说“查询当前 Session 的门禁豁免”“把当前 Session 加入门禁豁免”或“把当前 Session 退出门禁豁免”。Agent 分别调用 `taskcenter_session_gate_exemption_status` 或 `taskcenter_session_gate_exemption_set`；目标 Session ID 优先取自 Codex 为每次 MCP 请求注入的 `_meta.threadId`，仅为旧宿主兼容回退到进程环境变量。两路身份冲突、缺失或格式非法时均拒绝操作。工具不接受调用方指定其他 Session，内部控制端点还要求本机 MCP 进程凭据。加入前要求 Session 已登记，不创建正式任务，也不提供项目级、标题匹配或批量豁免。首次新增工具后需要新建或重启 Codex Session，让客户端重新加载 MCP 工具清单。

MCP 工具：

- `taskcenter_session_register`
- `taskcenter_session_status`
- `taskcenter_session_gate_exemption_status`
- `taskcenter_session_gate_exemption_set`
- `taskcenter_scheduled_readonly_scan_exemption_status`
- `taskcenter_scheduled_readonly_scan_exemption_set`
- `taskcenter_task_create`
- `taskcenter_task_query`
- `taskcenter_task_reuse_check`
- `taskcenter_task_reuse_decision_report`
- `taskcenter_task_reuse_decision_query`
- `taskcenter_task_update`
- `taskcenter_task_report`
- `taskcenter_task_requirement_report`
- `taskcenter_task_verification_report`
- `taskcenter_task_review_report`
- `taskcenter_review_cycle_report`
- `taskcenter_task_phase_report`
- `taskcenter_task_diagnostic_report`
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

控制服务提供无 Session 依赖的 `POST /core/task-events`、`POST /tasks/import-evidence`、`GET /tasks/:id/phase-report`、`GET /tasks/:id/export?format=json|markdown`，以及受令牌保护的 `POST /task-acceptance-report`。任务复用 Advisor 使用 `POST /task-reuse/check` 做无写入查询，并以 `POST/GET /task-reuse/decisions` 独立记录和读取最终选择。旧 `POST /task-acceptance-sync` 继续作为 Context 兼容适配器。令牌只通过进程环境传递，不写入任务、事件、日志或仓库。

## 数据文件

运行态写入 `data/`，并由 `.gitignore` 排除，包括内容读取白名单 `session-selection.json`、门禁豁免白名单 `gate-session-allowlist.json`、CLI 授权账本 `delegations.json`、append-only 复用决策账本 `task-reuse-decisions.jsonl`、路由派生状态 `routing-control.json` 与 `reflection-proposals.json`。`routing-control.json` 是控制服务单写者维护的可变派生状态；不可变任务事件与复用决策记录仍是审计依据，不承担锁或租约状态源职责。仓库只保留空白 seed、示例数据和空的 Session 合并配置。删除运行态前请确认范围；TaskCenter 不应删除或改写 `~/.codex` 下的会话与认证数据。

## 开发与验证

用量报告可通过 `node scripts/usage-report.mjs` 生成，默认只读取 `~/.codex/sessions/**/*.jsonl` 和本地任务账本；聚合使用每条记录的 `last_token_usage`，并按 `5h`、`24h`、`7d` 和 model/project/session/task 输出 input、cached input、output、average/P50/P95。增量索引还会按任务生命周期时间窗保留 lifetime 累计，任务表展示 input、cached input、output、reasoning 和 total；原始事件仍只保留 7 天，共享或重叠 Session 无法唯一归属时计入 `unattributed`，因此任务值是流程分析用估算而非账单数据。CLI delegation 的独立 Session 会归入父任务。报告支持注入 `sessionsRoot`、`ledger`、`rates`、`now`；全部未知费率时标记为 `unestimable`，混合已配置与未知费率（包括未配置的 Spark）时保留可估算部分并标记为 `partial`。

费率表位于 `config/model-rates.json`，只应填写模型提供方正式公布并经操作者确认的每百万 Token Credits；禁止用相近模型价格代填 Spark。`taskcenter_usage_report`、`taskcenter_session_lifecycle` 和 `taskcenter_governance_metrics` 分别提供用量、会话建议与试点指标。治理指标同时返回 Token 任务归属覆盖率；只有显式调用 `taskcenter_task_diagnostic_report` 的案例才进入调试观察聚合，记录根因耗时、假设数、失败修复、回滚和新鲜验证。这些数据只用于发现流程瓶颈和检验改进，不参与个人绩效、任务门禁或自动模型路由。生命周期建议不会强制中断，且“新建 Codex Session”不等于“新建 TaskCenter task”：同一交付继续复用原任务并携带 1–2KB handoff。

普通闭环可用 `taskcenter_task_close` 一次提交最终报告、Requirement Results 与 Verification Claims，并直接取得 readiness；同一 `event_id` 重试幂等。它把典型的 verification、requirements、report、readiness 四次往返压缩为一次，同时保留原有细粒度接口和 OCR 独立 Session/attestation 路径。

Review 过程使用 `taskcenter_review_cycle_report` 按稳定 `cycle_id` 增量记录 `pending_review/reviewing/fixing/verifying/completed` 阶段、墙钟时间和调用方明确测得的 active time。`taskcenter_task_review_report` 的 v3 Attestation 通过 `cycle_id`、`review_scope=full|incremental`、`base_attestation_id`、文件集合与带 fingerprint 的 finding 关联复审；旧 Attestation 保持 `legacy` 或 v2 原样读取，不补造新字段。治理快照和 Completion Packet 会输出轮次、漏斗、P50/P95、finding 质量、fallback 与 `reviewLoopWarnings`；缺少阶段事件或 active time 时返回“数据不足”，这些指标只用于团队流程诊断，不用于 reviewer、模型或个人排名。

任务阶段使用 `taskcenter_task_phase_report` 追加 `planning/implementing/verifying/reviewing/reworking/waiting_external` 的 `started/paused/resumed/finished` 事件。每条事件必须显式携带 `task_id`、`session_id`、`event_id`、`occurred_at`、`subject_ref`、`reason` 与 `activity_source`；同一执行跨 Session 续接时必须复用稳定的 `activity_id`，且新 Session 必须通过既有 Session merge、delegation 或 Review Cycle 身份获得任务授权。delegated executor 还必须引用已领取的 `delegation_id`。阶段账本只追加，重复 `event_id` 仅在语义完全相同时幂等。

`phaseTiming.task_wall_ms` 是所有已观测阶段区间的并集，多个执行器重叠时只计算一次；`executor_active_ms` 按 Session 或 delegation 累计，因此并行时总和可以大于任务墙钟。`phase_wait_ms` 与 `wait_breakdown_ms` 只统计明确上报的暂停、构建等待、外部等待和 Review 排队区间，不用 Token 或“墙钟减 active”猜测有效工时。Review、返工和 Review 后验证继续以现有 Review Cycle 时间为权威来源，阶段事件只补充边界与执行器归因，不重复计账。指定 `as_of` 时只聚合截止时刻已经发生的边界，跨越截止时间的区间会截断并标记 `partial`。旧任务或缺失字段返回 `unknown`/`partial` 和 `null`，不会把缺失数据伪装为零；这些数据只用于流程诊断，不参与绩效、任务门禁或验收。

创建正式任务前可调用 `taskcenter_task_reuse_check`。Advisor 只读取已登记 Session 与可见任务投影，候选包含 `planned/in_progress/blocked/done_claimed`，默认排除取消、已验收、归档、移除、被替代和 Context 影子任务。相同 `context_task_id + workspace` 是最高优先级的召回证据，但只有同 Session、有效 delegation 或可验证的同 Owner 同时成立时才会形成强复用建议；身份无法确认时保持 `uncertain`。同项目、文本相似和 Subject/Worktree 关系只参与排序。语义相似度使用本地、确定性的 Unicode token overlap，不调用远程模型；同仓库、同 Session 或标题相似都不能单独产生强复用建议。请求的 `project_id` 必须与已登记 Session 一致；旧 Session 没有项目身份时明确降级为 `unknown`，不会采信调用方值或用目录名推断。返回结果始终标记 `advisory_only=true`，不会自动创建、合并、阻断或修改任务。

调用方用 `taskcenter_task_reuse_decision_report` 把 Advisor 建议与最终 `reuse/create_new/uncertain` 选择写入独立 append-only 账本；覆盖 `reuse/uncertain` 建议而新建时必须填写 `force_new_reason`。相同 `event_id` 只有在语义完全一致时幂等，冲突重放会被拒绝；专用跨进程锁以及可从 JSONL 重建的 event-id、顺序、project 和 workspace 索引保证并发唯一性与有界逆序查询，JSONL 仍是唯一审计事实源。`taskcenter_task_reuse_decision_query` 通过本机 MCP 运行时令牌读取审计，用于试点评估；未知项目身份不计入项目覆盖。在完成 3 个项目、至少 10 次创建决策的观察前，不增加 Hook 提示、软门禁、自动阻断或自动合并。

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
