# TaskCenter（任务中心）

「AI 行为」页面 `/ai` 默认展示自主治理。`config/ai-governance.json / automatic.enabled` 启用受管理的独立观察器：自动关联当前工作区的活跃任务与新内容变化，Jev 判断是否需要参与，Claude/DeepSeek 分析证据或阻塞；Jev 未配置或失败时由 DeepSeek 自主判断。无需手动输入任务 ID，手动分析保留在折叠入口。快照只含受限任务字段与已登记证据摘要，不读取会话正文、文件或完整日志；本机路径隐去，疑似密钥拒绝发送。Claude CLI 禁用工具、MCP、项目上下文与会话持久化，超时 120 秒。自动推理并发一，同一快照持久去重，每任务间隔一分钟；失败冷却五分钟并返回规则检查，主线操作不等待 AI。判断和分析只提供建议，不改变任务或验收状态。

治理行为写入 `data/ai-activity.jsonl`（可通过 `TASKCENTER_AI_ACTIVITY_PATH` 隔离）；Jev 观察从 `TASKCENTER_JEV_RUNTIME_DIR/events.jsonl` 及上一轮日志读取。`GET /ai/activity`、`GET /ai/snapshot` 与受同源人工动作校验的 `POST /ai/analyze` 是工作台入口。页面仅展示平台已有记录，不暴露模型内部思维；未记录的用量和原因明确显示未知，历史保留范围遵循原来源，不重放旧任务。

观察器通过任务快照变化发现新事件，不批量重放已结束历史。运行状态与去重状态分别写入 runtime 下的 `ai-observer-health.json`、`ai-observer-state.json`，页面显示心跳、待判断数量与当前任务。Jev 复用宿主已有 `TYPESAFE_API_KEY` 环境变量，不读取凭据文件；候选 dry-run 环境禁用自动推理。停止观察器会终止未结束的 CLI，下一次服务启动恢复观察；配置或日志故障会停止观察器并展示异常，核心服务不依赖它。

TaskCenter 是一个本地优先、核心协议与平台解耦的任务治理看板。人、Agent、CI、PR 审查平台和其他任务平台都可以创建任务、提交证据与独立验收；Codex、Claude Code、Context Agent、MCP 和 Hook 都只是可选适配器。

> 当前版本：`v0.1.5`。核心 Web、MCP、Hook 与服务控制支持 macOS、Linux/WSL2 和原生 Windows；桌面快捷入口仅支持 macOS。

## 底层原则：任务即契约

> **任务即契约：以契约约束执行，以持久状态管理过程，以证据判定完成。**

这是 TaskCenter 后续设计、实现与改动的共同约束：明确本次工作的目标、范围、授权和验收条件；持久记录过程事实，支持核对后恢复；依据绑定当前工作对象、契约和产物版本的证据判定交付。执行方法可以在契约内调整，契约变更必须显式记录；结果未知时先核对再恢复或重试；验证强度与风险相称，完成声明不等于独立验收。

PCA 管“依据什么做”，提供版本化规格与项目知识；TaskCenter 管“这次委托是否按约交付”，管理执行契约、任务生命周期与交付证据，最终验收由独立授权主体完成。模型选择、派发、工具执行、重试与终止由宿主和当前主模型负责。原则不要求恢复已退役编排，也不要求每个任务采用重型审批或自动 Review。

后续改动应说明其如何服务契约、过程状态或交付证据，并遵守已有约束。Agent 执行规则见 [AGENTS.md](AGENTS.md#底层原则任务即契约)。

## 核心能力

- 按真实 Session 展示 Agent 创建的正式任务。
- 跟踪目标、计划、当前步骤、阻塞、预计时间、测试和证据。
- 通过 Hook 在受支持工具调用前检查 Session 是否已登记且存在活跃任务。
- 通过显式 Session 白名单控制哪些本机 Codex JSONL 可以读取。
- 基于白名单聚合数据和任务账本生成可审核的本地改进提案。
- 所有任务账本和运行状态仅保存在本机。
- 以通用 `SubjectReference` 和 `ActorIdentity` 记录工作对象与参与者，不把 Git、Session 或单台机器作为核心前提。
- 支持离线补录、通用验收，以及 JSON/Markdown Completion Packet 导出。

## 隐私与安全边界

TaskCenter 只读访问：

- `~/.codex/sessions/**/*.jsonl`
- `~/.codex/session_index.jsonl`

TaskCenter 不读取 `~/.codex/auth.json`、API Key、Cookie 或其他认证材料，不会修改 Codex 会话，也不会将聊天内容上传到远端。项目默认只监听本机地址，不支持未经重新设计的数据脱敏、多用户鉴权和远程部署。

Session 内容采用 fail-closed 白名单：缺少 `data/session-selection.json`、配置损坏或白名单为空时，不读取任何 JSONL 正文。候选列表只从允许的本机索引和文件名读取 Session ID、标题与文件时间，便于人工勾选；未入白名单的消息、cwd 和摘要不会进入 dashboard 或反思输入。旧 `all` / `selected` 配置只迁移其中显式列出的 `threadIds`，不会把隐式 `all` 扩大为全量读取。

页面中的两套白名单职责独立：“读取白名单”决定哪些本机 Session JSONL 可以进入同步与反思；“门禁豁免”决定哪些 Session 在非只读工具调用前无需登记活跃任务。门禁豁免默认关闭、按 Session 显式配置；打开“门禁豁免”后，每个精确 Session 都可一键“加入豁免”或“退出豁免”，操作立即生效且不会覆盖其他 Session。豁免只跳过任务登记检查，不跳过交互式进程和命令形态等安全检查。

“改进建议”从聚合结果与本地任务账本识别证据缺口、阻塞、逾期和返工，仅生成建议并保存接受/拒绝决定。接受建议不创建或启动 Agent；历史执行记录保留最后观察状态，新版本不继续投递旧队列。

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
npm run service:prune -- --dry-run
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

首次接入或排查任务门禁时，按 [Claude 真实身份与生命周期指南](docs/claude-lifecycle.md) 操作。SessionStart 会注入真实 Hook 身份；不要自拟或给 ID 添加 `local_` 前缀。

任意客户端创建的任务可由另一已启动客户端接手，复用同一 task ID；调用顺序和边界见 [跨客户端共享任务接手](docs/shared-task-handoff.md)。


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

已提交对象巡检在 L0 和 `scheduled_readonly` 中共用精确 Git 白名单，无需扫描豁免。先单独执行 `git show-ref --verify refs/heads/dev`，再执行 `git rev-parse --verify 'refs/heads/dev^{commit}'`；后续将返回的完整 40/64 位小写 SHA 作为字面参数，使用 `git ls-tree -r --name-only SHA -- project-context/`、`git show SHA:路径` 或 `git cat-file -p SHA:路径` 读取树/blob，使用 `git diff --name-only 上次SHA 本次SHA -- project-context/` 比较覆盖范围。支持 `cat-file -t/-s` 与 `ls-tree -z`，对象路径拒绝上级目录和凭据文件；不支持 Git 全局参数、filters/textconv、batch 或输出文件。命令工作目录须在会话工作区内，逐条执行，不使用变量替换、重定向或复合命令；本扩展不改变既有 L0 批次规则。

`instory-pca-2` 不匹配固定的 `instory` Profile，应使用已登记 Session 的 L0 做上述只读取证，不伪造 Automation ID 或启用扫描豁免。若原 `dev` 读取失败，不能建立成功基线；修复生效后重新运行一次，记录实际 SHA、覆盖范围和结果。自动化 memory 默认不享有无任务写权限，创建任务也不解除 `~/.codex` 禁写边界；唯一例外是下文格子明确批准的 `instory-pca-2` 单文件能力。其他情况只在最终回复记录结果，或由用户亲自更新 memory。固定 `instory` Profile 仅可写它绑定报告的托管区块，不授权其他自动化或文件。

格子已单独批准 `instory-pca-2` 的 memory 例外，由 [`config/automation-memory.json`](config/automation-memory.json) 绑定启用状态、固定 automation ID、inStory 工作区、Codex home 绝对路径和直接用户授权来源；不通过 `scheduledReadonly` 的旧 `instory` 报告能力。Hook 从本机 `sessions/**/*.jsonl` 的有界启动段验证 Session ID、`thread_source=automation`、工作区，以及第一条非 AGENTS 用户消息中的宿主自动化 ID/memory 路径，另核对服务端已登记工作区。普通聊天、工具参数或后续消息自报的身份不能获得该能力；源文件缺失、身份不明或审计失败均拒绝。

仅允许单个 `apply_patch` 对 Codex home 下 `automations/instory-pca-2/memory.md` 执行 Add/Update。Add 不覆盖，Update 使用唯一精确上下文；路径/祖先不得为符号链接，文件不得为硬链接，Delete/Move、多文件、任意 shell 写入和其他自动化/项目文件不在授权内。现有全局 PreToolUse/PostToolUse 直接加载源码，无需修改 `~/.codex/hooks.json` 或重启健康服务。文件限制为 64 KiB、固定 Markdown 标题和唯一 JSON 区块：

````markdown
# instory-pca-2

```json
{
  "automation_id": "instory-pca-2",
  "status": "incomplete",
  "subject_sha": null,
  "last_successful_sha": null,
  "observed_at": "2026-10-10T04:00:00Z",
  "coverage": [],
  "result": "等待实际巡检结果"
}
```
````

Agent 应填写真实时间、已验证 Subject SHA、实际仓库相对覆盖路径和结果。只有完成本次已声明覆盖的巡检才写 `status=success`，此时成功 SHA 必须等于 Subject SHA 且覆盖非空；`failed` / `incomplete` 必须保留旧成功 SHA，首次运行保持 null。缺少旧记录时不猜基线。Hook 验证结构及基线变更规则，无法独立验证 Agent 对语义巡检完成的声明。写前/写后审计位于 `.local/automation-memory/audit.jsonl`，只记录批准来源、身份、路径、状态、SHA 和内容哈希，不记录结果正文。PostToolUse 比对批准内容与实际落盘哈希，失败不得宣称记录成功；修复有效内容后重新验证，不自动覆盖可能来自用户的改动。

撤销能力：由有权限的 TaskCenter 维护任务或用户将绑定配置 `enabled` 设为 false（或移除配置），下一次 Hook 即拒绝该例外，不删除已有 memory 或审计。若用户换 Codex home/工作区，须重新审核配置绑定；不能通过工具输入或环境中的 `$CODEX_HOME` 自行改变批准路径。该能力是 Hook guardrail，不是进程级隔离。inStory `90-Agent提案/` 等文件仍须走其 TaskCenter、Worktree、ExecPlan 门禁。

条件配置模板位于 [`integrations/codex/scheduled-readonly-hooks.json.example`](integrations/codex/scheduled-readonly-hooks.json.example)。将其中两个 matcher group 合并到现有日常 Hook，而不是覆盖整个文件；普通 Session 不登记 Profile，因此不会改变现有门禁。占位路径必须替换为本机审核过的绝对路径。固定完整性命令由 Hook 注入，不允许自动化自行拼接 Node/Python/管道：

```text
rtk node "/absolute/path/to/taskcenter/scripts/scheduled-report-probe.mjs" --report "/absolute/path/to/inStory/project-context/90-Agent提案/自动化报告/附件-项目研发效能夜间优化探索.md"
```

Codex 配置中的 `UserPromptSubmit` Hook 会在非门禁豁免 Session 没有活跃正式任务时，提前向 Agent 注入任务准备指令。已登记且无活跃任务的 Session 可在 L0 运行单条确定性只读命令：`pwd`、`ls`、`cat`、`head`、`tail`、`wc`、`du`、`stat`、`file`、`rg`、`sed -n`、受限 `find`，以及限定的只读 `git` 子命令（可选前缀 `rtk`）。重定向、管道、命令替换、解释器和复合命令均会 fail-closed；提示会要求拆成单条只读命令，或创建任务。L0 只保留每个 Session 的计数聚合，不创建任务、验收或 Review，也不记录命令历史。未登记 Session 不享有 L0。

需要写入时由 Agent 主动登记并创建或复用任务后再调用工具，不应要求用户代为处理。L1 `fast` 默认不要求 verification plan 或 review；L2 `standard` 必须声明 verification plan、默认不要求独立 review；L3 `strict` 必须有 verification plan 和当前 Subject 的独立 review。Subject 更新会使旧验证和 Review 失效。CLI 没有 Agent 的路径可直接调用 Core HTTP/导入证据接口；它不依赖 Hook 或 MCP，恢复服务后再补录 `occurred_at` 与证据即可。`PreToolUse` 仍保留硬阻断作为兜底。只有显式加入“门禁豁免”白名单的精确 Session ID 才会跳过任务要求，不会按项目、目录或标题自动扩大豁免。

任务创建、更新、报告、Subject、证据导入与验收等写入型 MCP 支持 `response_mode: "summary" | "full"`，缺省为 `summary`。摘要只返回 `accepted`、`task_id`、`status`、`verification_status`、`review_status` 和 `missing_count`；排障、query、export 或需要兼容旧全量回包时显式传 `full`。

同一语义需求在用户反馈、测试失败或 Review 后修订时继续复用原任务，通过 `taskcenter_task_subject_update` 更新 Subject；只补跑受影响验证并对增量 diff 复审。首次遗漏原因、防回归措施和完成度变化记录在原任务事件中，不为普通修订重复创建正式任务。

TaskCenter 与 ProjectContextAgent 关联后，Completion Packet 是交付完成证据的唯一桥接对象：`fast` 任务在 TaskCenter 门禁通过后可自动同步；`strict` 任务必须在页面核对当前 Subject、验收、验证、独立 Review 和未决 finding，再点击“完成并同步 ProjectContext”。页面确认会触发 ProjectContextAgent 的原生用户授权弹窗，并签发绑定 task、Subject 和 packet digest 的一次性授权；重试复用 request ID，不会产生重复完成事件。两端默认共享 `~/.local/state/project-context-agent/taskcenter-attestation-token` 中权限为 `0600` 的专用凭证；可用 `PROJECT_CONTEXT_ATTESTATION_TOKEN_PATH` 同时覆盖两端路径，或通过 `TASKCENTER_CONTEXT_ATTESTATION_TOKEN` 与 `AGENT_WEB_ATTESTATION_TOKEN` 显式提供相同值。该凭证不等于 Dashboard token，也不取消原生确认。

在 Windows 上，TaskCenter 会安全解析标准 npm 安装生成的 `codex.cmd` 并直接调用其 Node 入口，避免把 Session prompt 拼进 shell。非标准批处理启动器应通过 `TASKCENTER_CODEX_COMMAND` 指向 `codex.exe`，或配合 `TASKCENTER_CODEX_PREFIX_ARGS` 显式配置。

## 通用完成协议与 Codex 适配器

TaskCenter Core 不依赖 Codex、Context Agent、OCR、GitHub/GitLab、Worktree 或 MCP，也不能成为外部项目 build、test、commit、merge 或 release 的强制条件。服务离线时工作可以继续，恢复后通过 `taskcenter_task_import_evidence` 补录；事件同时保存原始 `occurred_at` 与账本 `recorded_at`。

### 只读诊断与闭环引用

已登记但没有活跃任务的普通 Session 可使用 L0 只读查询，包括带引号的正则检索（如 `rtk rg 'foo|bar' README.md`）、`rtk proxy` 包装以及固定 `adb devices [-l]` / `adb version` 探针。引号内的正则符号按字面参数处理；管道、重定向、命令替换、变量展开、不完整引号和执行型参数继续拒绝。`npm run service:status` 不属于固定只读探针，因为任意工作区的同名 npm script 可执行任意代码。L0 不等同于文件系统沙箱，也不会恢复 Codex 尚未挂载的 MCP；服务不可用仍遵循离线恢复门禁。

闭环的两个 `requirement_id` 指向不同集合：`close_requirements[].requirement_id` 引用 `acceptance_criteria[].id`；`close_verifications[].requirement_id` 引用 `verification_plan[].id`，其 `kind` 必须匹配计划。Claim 自身 `id` 是唯一证据记录 ID。引用错误返回 `UNKNOWN_ACCEPTANCE_REFERENCE` / `UNKNOWN_VERIFICATION_REFERENCE` 和合法 ID，类型不符返回 `VERIFICATION_KIND_MISMATCH`。应在一次 `task_close` 中提交整包证据。请求校验失败后可修正再提交；已成功落账的 event_id 只能重放相同内容，不能用幂等键覆盖已记录事实。

### TaskCenter 与 ProjectContext 的职责边界

TaskCenter 是执行合同、运行状态、验证、Review、验收的权威来源。ProjectContext 管理项目事实、决策、待审核知识与跨 Session 上下文，其语义任务用于组织上下文，不应替代 TaskCenter 的执行状态。现有 `scripts/context-bridge.mjs` 与 completion adapter 已承载映射和 Completion Packet 投递；这是已有能力，而非新增桥接。

设置页的 Astra `context_management` 试点区按 TaskCenter 实际登记的 project/workspace 逐项读取项目级 `.codex/config.toml`，展示采集时间、仅新任务生效边界，以及启用后连续三个、带资格证据的自然长 Astra 任务指标。缺失、不可读或存在歧义时保持 `unknown`，不会推断成停用。启用、停用和刷新只写入 append-only intent 并唤醒现有 DevWorkbench 主脑；TaskCenter 不直接修改外部项目或 `~/.codex`。停用对当前任务属于软回退，关闭项目配置并新建 Astra 任务后才完成硬回退。目标项目以 TaskCenter MCP/Hook 协议向本机 `POST /context-management-pilots/intents/:intentId/result` 回写结果，并可用 `POST /context-management-pilots/trials` 提交试点证据。

后续整合优先复用稳定 task/context 关联和摘要投递，避免 Agent 手动维护两套执行状态。Context 投递失败保留 TaskCenter 已落账事实并走补偿，不能回滚或伪造验收。现有 Context 语义任务和生命周期适配仍保留；删除重复接口或迁移状态机需要独立设计与兼容性验证。

任务契约使用结构化 `AcceptanceCriterion { id, description, required }`。验证和审查绑定 `SubjectReference`，支持 `git_commit`、`git_worktree_snapshot`、`pull_request_head`、`artifact`、`document_version`、`external` 和 `none`。主体变化后旧证据自动 stale。参与者使用 `ActorIdentity`，审查独立性与验收身份由版本化 Workspace Policy 决定，而不是硬编码 Session 是否相同。绝对本地路径不能作为 standard/strict 的唯一跨团队证据。

以下步骤是 Codex/Hook 适配器的门禁流程，不是 TaskCenter Core 的通用前置条件：

默认情况下，每个 Session 按以下顺序执行：

1. `taskcenter_task_begin`：一次完成 Session 登记和 v2 任务创建，默认只返回任务状态、下一步和本地上下文引用。同一 Session 可在上一任务关闭或取消后顺序创建下一任务，但同一时间只允许一个活跃任务。已有客户端可继续分别调用 `taskcenter_session_register` 和 `taskcenter_task_create`；`standard/strict` 仍须提交验证计划。
2. 收到 `accepted=true` 与独立 `task_id` 后才能执行写操作。
   Codex 或 Git 创建关联 worktree 后，适配器会从 `.git` 指针自动识别主仓库、当前分支和 `execution_environment=worktree`。每个 worktree 保留独立 `workspace` 与 Subject，稳定 `project_id` 归并到同一项目；TaskCenter 不负责创建、合并或删除 worktree。Context bridge 同时把稳定 `project_id` 和具体 worktree workspace 传给 ProjectContext，使项目知识共享、执行证据隔离。
3. 使用 `taskcenter_task_update` 更新进度，使用 `taskcenter_task_report` 上报结果。
4. 主模型自主决定模型与子代理的使用。TaskCenter 不选择、派发、登记、限制或管理子代理；主线 Hook 不再检查路由租约。
5. Agent 的 `done_claimed` 仅代表执行声明，提交时必须附带 `tests` 或 `evidence`；随后通过验收条件结果、Verification Claim 和独立 Review Attestation 计算 `completion_readiness`。
6. `accepted` 只能由携带 `TASKCENTER_ACCEPTANCE_TOKEN` 的独立验收适配器通过 `taskcenter_task_acceptance_report` 上报；来源可以是 human、pull_request、ci、task_platform、context_agent、manual 或 other。普通执行 Agent、`task_report` 和浏览器操作均不能直接设置最终验收。

### 主线治理边界

模型调度页面、模型角色配置、路由租约、委派协议和托管 Reviewer 已彻底退役，旧 HTTP 路径返回 404，MCP 不再暴露对应工具。宿主原生子代理由主模型自主决定，TaskCenter Hook 在请求服务前识别并忽略它们；会话同步只收集主线。历史路由与委派文件不删除、不重放，也不继续更新。

主线任务登记、合同、所有权、进展、验证、完成声明和独立验收继续有效。外部 Review 由用户安排，已有 Review Attestation / Cycle 证据接口保留；平台不启动或管理 Reviewer。Review 不阻塞任务完成与已授权交付。Jev 观察只提供任务分类、续接、风险和输出建议，不参与模型选择。

核心 MCP 工具以 `taskcenter_session_register`、`taskcenter_task_begin`、`taskcenter_task_update`、`taskcenter_task_report`、`taskcenter_task_close`、验收条件、验证和独立验收报告为主。完整契约以 `scripts/taskcenter-mcp.mjs` 为准。

## 数据文件

运行态写入 `data/`，并由 `.gitignore` 排除，包括读取白名单、门禁豁免白名单、任务事件与投影、复用决策和改进提案。旧 `routing-control.json`、`delegations.json` 仅作历史留存，不读取或改写。删除运行态前请确认范围；TaskCenter 不应删除或改写 `~/.codex` 下的会话与认证数据。

## 开发与验证

用量报告可通过 `node scripts/usage-report.mjs` 生成，默认只读取 `~/.codex/sessions/**/*.jsonl` 和本地任务账本；聚合使用每条记录的 `last_token_usage`，并按 `5h`、`24h`、`7d` 和 model/project/session/task 输出 input、cached input、output、average/P50/P95。增量索引还会按任务生命周期时间窗保留 lifetime 累计，任务表展示 input、cached input、output、reasoning 和 total；原始事件仍只保留 7 天，共享或重叠 Session 无法唯一归属时计入 `unattributed`，因此任务值是流程分析用估算而非账单数据。历史独立 Session 的用量归属仅作被动统计，不建立新的委派关系。报告支持注入 `sessionsRoot`、`ledger`、`rates`、`now`；全部未知费率时标记为 `unestimable`，混合已配置与未知费率（包括未配置的 Spark）时保留可估算部分并标记为 `partial`。

费率表位于 `config/model-rates.json`，只应填写模型提供方正式公布并经操作者确认的每百万 Token Credits；禁止用相近模型价格代填 Spark。`taskcenter_usage_report`、`taskcenter_session_lifecycle` 和 `taskcenter_governance_metrics` 分别提供用量、会话建议与试点指标。治理指标同时返回 Token 任务归属覆盖率；只有显式调用 `taskcenter_task_diagnostic_report` 的案例才进入调试观察聚合，记录根因耗时、假设数、失败修复、回滚和新鲜验证。这些数据只用于发现流程瓶颈和检验改进，不参与个人绩效、任务门禁或自动模型路由。生命周期建议不会强制中断，且“新建 Codex Session”不等于“新建 TaskCenter task”：同一交付继续复用原任务并携带 1–2KB handoff。

普通闭环可用 `taskcenter_task_close` 一次提交最终报告、Requirement Results 与 Verification Claims，并直接取得 readiness；同一 `event_id` 重试幂等。它把典型的 verification、requirements、report、readiness 四次往返压缩为一次，同时保留原有细粒度接口和 OCR 独立 Session/attestation 路径。

Review 过程使用 `taskcenter_review_cycle_report` 按稳定 `cycle_id` 增量记录 `pending_review/reviewing/fixing/verifying/completed` 阶段、墙钟时间和调用方明确测得的 active time。`taskcenter_task_review_report` 的 v3 Attestation 通过 `cycle_id`、`review_scope=full|incremental`、`base_attestation_id`、文件集合与带 fingerprint 的 finding 关联复审；旧 Attestation 保持 `legacy` 或 v2 原样读取，不补造新字段。治理快照和 Completion Packet 会输出轮次、漏斗、P50/P95、finding 质量、fallback 与 `reviewLoopWarnings`；缺少阶段事件或 active time 时返回“数据不足”，这些指标只用于团队流程诊断，不用于 reviewer、模型或个人排名。

任务阶段使用 `taskcenter_task_phase_report` 追加 `planning/implementing/verifying/reviewing/reworking/waiting_external` 的 `started/paused/resumed/finished` 事件。每条事件必须显式携带 `task_id`、`session_id`、`event_id`、`occurred_at`、`subject_ref`、`reason` 与 `activity_source`；同一执行跨 Session 续接时必须复用稳定的 `activity_id`，且新 Session 必须通过既有 Session merge 或 Review Cycle 身份获得任务授权。阶段账本只追加，重复 `event_id` 仅在语义完全相同时幂等。

`phaseTiming.task_wall_ms` 是所有已观测阶段区间的并集，多个已记录活动重叠时只计算一次；`executor_active_ms` 按历史活动身份累计，因此并行时总和可以大于任务墙钟。`phase_wait_ms` 与 `wait_breakdown_ms` 只统计明确上报的暂停、构建等待、外部等待和 Review 排队区间，不用 Token 或“墙钟减 active”猜测有效工时。Review、返工和 Review 后验证继续以现有 Review Cycle 时间为权威来源，阶段事件只补充边界与活动归因，不重复计账。指定 `as_of` 时只聚合截止时刻已经发生的边界，跨越截止时间的区间会截断并标记 `partial`。旧任务或缺失字段返回 `unknown`/`partial` 和 `null`，不会把缺失数据伪装为零；这些数据只用于流程诊断，不参与绩效、任务门禁或验收。

创建正式任务前可调用 `taskcenter_task_reuse_check`。Advisor 只读取已登记 Session 与可见任务投影，候选包含 `planned/in_progress/blocked/done_claimed`，默认排除取消、已验收、归档、移除、被替代和 Context 影子任务。相同 `context_task_id + workspace` 是最高优先级的召回证据，但只有同 Session 或可验证的同 Owner 同时成立时才会形成强复用建议；身份无法确认时保持 `uncertain`。同项目、文本相似和 Subject/Worktree 关系只参与排序。语义相似度使用本地、确定性的 Unicode token overlap，不调用远程模型；同仓库、同 Session 或标题相似都不能单独产生强复用建议。请求的 `project_id` 必须与已登记 Session 一致；旧 Session 没有项目身份时明确降级为 `unknown`，不会采信调用方值或用目录名推断。返回结果始终标记 `advisory_only=true`，不会自动创建、合并、阻断或修改任务。

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

### 同一 Codex Session 顺序承载任务

普通顺序任务无需切换或压缩：关闭或取消当前任务后，直接调用 `taskcenter_task_begin` 创建下一任务。TaskCenter 保留每个独立 `task_id` 的合同、证据和用量归属；Hook 始终绑定该 Session 最新的唯一活跃任务。

仅当上下文已经过大并且需要恢复检查点与显式压缩时，才使用下面的会话切换协议。

`task_close` 的生命周期建议不会执行压缩，也不会授权第二个任务。显式切换使用 `taskcenter-session-switch/v2`（旧版请求和 receipt 不再授权重绑）：

1. 先关闭原任务。`done_claimed` 必须满足当前 `completionReadiness.completionClaim.allowed`；`cancelled` 必须有 `evidence` 和取消原因 `retrospective`。这不新增或替代独立验收。两条路径均要求当前 Subject 是 Git HEAD、工作区干净。
2. 调用 `taskcenter_session_switch_prepare`，提供 `task_id`、下一任务的 `next_task_id` / `next_goal` 和幂等 `event_id`。Session 身份从 MCP 宿主取得。完整任务恢复内容、task/client_session 归属、generation、Subject/revision、状态、下一目标和 15 分钟有效期持久化在检查点中，以 SHA-256 绑定，写入 flush 后必须重新读回校验。准备成功不代表压缩或恢复成功。
3. 控制服务通过 `TASKCENTER_CODEX_APP_SERVER_URL` 显式配置**已有本机 App Server** 的 WebSocket 地址，例如 `ws://127.0.0.1:4500`；默认未配置，返回 `HOST_COMPACTION_CAPABILITY_UNAVAILABLE`。仅接受 `127.0.0.1` / `[::1]`，不接受凭据、查询参数或远端地址。适配器不会启动另一个 Codex 进程、恢复卸载的 Session 或读取认证信息；目标 thread 必须已加载、Session 身份及工作区一致，且支持实验接口 `thread/inject_items`。当前 Codex 桌面是否暴露这样的地址需由宿主确认，不能把示例地址当作已运行服务。
4. 调用 `taskcenter_session_switch_confirm`，仅提供 `switch_id`，返回 `pending` 后结束当前 Turn，让宿主等待 Session 空闲。后台操作先从持久化存储读回检查点、实际注入完整恢复内容证明恢复接口可用，然后调用 `thread/compact/start`。只有同一 thread/turn/item 的 `contextCompaction` started/completed 和成功的 turn completion 才算压缩完成，`{}` 只表示启动确认。完成后的第一步重新读回同一检查点并验证 digest/generation，再注入完整内容；并发普通 Turn、错配、过期、损坏、断连或恢复错误均失败关闭。最后核对实际启动之后的本地 Session 压缩日志，才持久化绑定预检、恢复结果和完整性摘要的 receipt。后续调用可查询 `ready` / `failed`；`pending` 绝不授权重绑。自动压缩记录、Agent 自述、伪造启动回执均不能跳过宿主恢复链。
5. 用原 Session 调用 `taskcenter_task_create`，携带 `session_switch_id`，并使用请求绑定的 task ID、goal 和 workspace。服务端再次核验快照、HEAD、工作区和活动任务。成功创建事件及新任务保留 `previous_task_id` / `previousTaskId` 和切换 ID；旧任务封存，不得再次修改或恢复。新任务沿用原有合同和验证门禁。

准备、执行开始、失败和 receipt 审计位于运行态数据目录的 `session-switch.jsonl`；消费证据位于任务事件账本。记录损坏、receipt 过期、关闭证据变化或工作区变脏均拒绝。执行开始后中断或恢复失败不自动重试压缩；旧绑定保留，等待检查点过期后重新准备，先排除宿主故障。账本写入中断而消费事件已持久化时返回 `SWITCH_LEDGER_RECOVERY_REQUIRED`，需恢复一致账本后重试，不能重发一个新目标绕过。部署会保留运行态数据；测试使用独立目录。协议信任明确配置的本机 App Server、Session 文件和本地控制面，不声称防御可任意篡改这些文件的本机进程。

宿主接口依据：[官方 Codex App Server — Trigger thread compaction](https://learn.chatgpt.com/docs/app-server#trigger-thread-compaction)；调用字段同时使用本机 `codex app-server generate-json-schema --experimental` 核对。适配器的隔离协议测试不是桌面宿主实测；未配置真实端点时，能力仍不可用，原绑定保持不变。

### 多 Agent 基础接入

客户端模块集中在 `scripts/harnesses/`，`index.mjs` 静态注册并提供统一调用；`scripts/agent-clients.mjs` 保留兼容导出，MCP schema 与会话页面共用能力信息。接入范围、调用契约、迁移与回滚见 [Harness 适配层](docs/harness-adapters.md)。agent 名称不授予权限，provider/model 仍独立上报。

- `taskcenter_agent_capabilities`：查询 TaskCenter 的 task_protocol、hooks、resume、usage、operations、用量口径与可信身份要求。结果是静态适配支持，运行可用性未经探测时明确为 unknown，不表示当前客户端已经配置或连接。
- `taskcenter_client_context`：查询宿主注入的可信当前 Session。通用入口 `_meta["taskcenter/sessionId"]` 或每会话独立进程的 `TASKCENTER_CALLER_SESSION_ID`；保留 Codex 入口，并拒绝格式错误或冲突。
- [Kimi Code CLI 接入与验收](integrations/kimi/README.md)：提供 Hook + ACP 受管入口、PCA 生命周期、真实身份绑定与上下文用量快照；原生 Hook 需用户配置，费用缺失保持 unknown。

保留任务核心、现有身份数据和 UUID 校验，无数据迁移；回滚代码提交即可撤回新增查询与配置。客户端能力声明不参与授权或绕过任务门禁。

部署成功后在同一部署锁内强制清理旧构建，保留当前版本与上一不同的成功版本（重复部署同一 revision 不挤掉回滚版本）。`npm run service:prune` 可清理存量，`-- --dry-run` 仅预览。清理失败使命令非零退出并记录 cleanup 事件，但不停止或回滚已经健康的新实例；异常目录、符号链接和含用户改动的 worktree 不删除。更早版本需要从 Git 重新构建。

部署先准备不可变候选构建，再执行 lint 和完整测试；npm 安装优先离线缓存（60 秒总时限），仅 ENOTCACHED 时联网一次（180 秒总时限、单请求 30 秒、最多一次请求重试）。缓存可被清理，不作为正确性前提；缺包按锁文件由 npm 下载与校验，失败在切换前终止并保留原服务。依赖安装不触发隐式 audit/fund 网络请求，独立依赖安全审计仍可按需执行。

运行依赖不再包含 Codex SDK 或原生 CLI。方案 A 保留 vinext/React 页面和 Node 服务，移除 Next 编译器、Cloudflare/Wrangler/Workerd 及未使用的 Drizzle、Worker、Sites 模板链；页面直接引用 vinext 导出的兼容 API。类型检查使用 TypeScript，lint 使用已有 React、Hooks、无障碍和 TypeScript 插件。release 在完整构建后检查开发依赖预算，再裁剪开发/可选依赖，通过生产体积预算与隔离候选验证。详见 [轻量化方案及实施证据](docs/lightweight-tool-plan.md)。

`npm run size:check` / `size:report` 检查已有构建，不重复构建或自动更新基线；全部资产、JS/CSS gzip、最大 JS chunk、服务端和完整开发依赖分别受累计 2% 预警、5% 失败约束。开发依赖统计排除 npm 根安装元数据及 Vite 缓存，真实包文件仍全部计入。release 额外检查实际生产依赖与单版本总量，复用旧 release 也重测目录和报告；锁文件、直接依赖和安装树禁止被移除的重依赖重新进入。`npm run verify:production -- --install` 在临时目录验证裁剪后的六个页面、控制面、MCP、同步与 watcher，不读取真实 Codex 数据。未知平台/Node/npm 版本缺基线时失败，不能跳过检查；当前基线及未覆盖平台见方案文档。
