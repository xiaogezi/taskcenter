# TaskCenter（任务中心）

### 可见 Bug 派发（本地事件协议）

Bug 详情页可以加入独立修复队列。每个业务 task 只有一条持久派发，默认最多两路；独占资源键相同则排队。记录与传统 SDK/CLI dispatch 分开，SDK 创建结果不能冒充桌面可见会话。未配置或不支持 `codex queue` 的机器显示事件入口不可用，不自动改走隐藏执行器。

控制面路径：`GET /bug-dispatches`、`GET/POST /tasks/:id/bug-dispatch`、`POST /tasks/:id/bug-dispatch/control`。加入队列必须明确提供用户授权的完整 `baselineCommit`，服务端核实 commit 存在；另可传 `dispatcherSessionId`（默认业务任务关联的已登记会话）与 `resources: string[]`。目标合入分支不等于用户授权创建基线，不能默认从它或仓库默认分支创建。控制输入为 `{action: "supplement" | "cancel" | "open", eventId, message}`。POST 只接受当前页面来源和既有操作确认标记，浏览器不能调用宿主回执路径。

宿主使用运行时绑定身份的 `taskcenter_bug_dispatch_host`，对应受 MCP 凭据保护的 `POST /bug-dispatches/host`：

1. `operation: "snapshot"` 获取记录。事件通过固定 argv 的 `codex queue --thread ID --message TEXT` 唤醒主脑；HTTP 请求持久化后即返回，不等修复结束。部署不会自动重放不确定的创建操作，也不轮询唤醒主脑。
2. `operation: "claim", id` 原子占位。没有名额/资源则返回 `record:null`。任何已登记主脑均可领取；`resumed:true` 表示既有 claim，只能核实先前结果，**不得重新创建**。不确定 claim 保留名额，需人工核实，不能 TTL 到期后重复创建。
3. 主脑按集中角色路由用实际 `list_projects/create_thread` 创建所属项目独立 worktree，`startingState` 使用已授权的 `baselineCommit` 既有 ref。创建提示携带派发 id，要求执行会话先发送真实 ID/workspace 给派发者、自行登记并等待核实再改代码。若宿主只返回 `clientThreadId`，立即回写 `{operation:"receipt", id, claimToken, eventId, status:"creating", clientThreadId, evidence}` 并返回；该记录持久占位，重启后只恢复核实，不重建。`clientThreadId` 不得当作真实 threadId 调用 `read_thread`。收到执行方带派发 id 的身份回报后，用 `read_thread` 核实真实会话、项目和 workspace，再回写 `{operation:"receipt", id, claimToken, eventId, status:"running", threadId, projectId, visible:true, evidence}`。服务端另查 Session 登记、Git 根目录/common-dir 和初始 HEAD 必须等于授权基线，拒绝父会话、其他仓库、相同工作树及子目录、重复会话和错误基线。身份映射不明时保持 creating/unknown，不猜测。`evidence` 是宿主操作回执引用；服务端不能独立调用桌面 API 验证该声明。
4. 派发回执后主脑返回。执行会话只在阻塞、待验收或完成时向主脑报告，并以同一 `id` 回写 `blocked/awaiting_acceptance/done_claimed` 与稳定 `eventId/evidence`；`done_claimed` 不是验收。待验收或完成释放执行名额，并事件唤醒排队项。恢复执行仍需名额与资源通过。
5. 主脑处理 `commands`：补充/运行中取消用实际 `send_message_to_thread`，打开用 `navigate_to_codex_page`；用 `{operation:"control_receipt", id, eventId, outcome:"sent"|"unavailable", evidence}` 回写。排队取消原子撤回，后续 claim 不会领取；已领取或运行的取消只是请求，不释放名额，不声称停止。暂停、继续没有已核实通道，UI 禁用。任何缺失宿主能力必须明确报告不可用。
6. 外部合入前，已绑定执行会话在业务任务 `bugClosure.status=awaiting_merge` 时用 `{operation:"merge_lease", id}` 领取仓库级串行租约，完成或失败后以 `release:true` 释放。租约不执行、不授权 Git 合并，也不能约束绕过协议的外部合并；仍需原有人工授权和合入核验。

当前是部分交付：事件队列、回执、并发/资源锁与 UI 能力边界。新增 MCP 工具需要宿主加载新版本；真实“事件→桌面创建→身份核实→回执”尚需在获准业务场景中验收，不能用隔离测试回执冒充真实业务验收。旧 `/dispatch` 路径保持原语义。取消后的同一 task 不自动重派，避免重复执行。

隔离验证可以设置 `TASKCENTER_BUG_DISPATCHES_PATH` 和独立 `TASKCENTER_CONTROL_PORT`；同源代理仅连接该端口的 loopback。其他运行态仍按现有隔离变量设置，不能连接正式数据做测试。

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

## Bug 验收与合入闭环

进入「任务工作区 → 某个任务 → Bug 闭环」可将已核实的缺陷登记到现有 v2 任务。填写反馈来源、受影响版本、前置条件、复现步骤、实际行为、预期依据、验收步骤、测试入口和目标本地分支。MCP 创建/更新任务也支持同名 `bug` 对象；使用字段 `source/version/preconditions/steps/actual/expected/acceptanceSteps/testArtifact/targetBranch`。反馈是否成立仍由项目会话核实，本入口不会自动认定 Bug 或新建修复会话。

修复会话继续使用原有任务合同、Session、验证和独立审查机制。执行器声明完成后，验证与必要审查全部就绪，用户才可在 Bug 详情勾选确认、填写结果并办理验收。验收通过进入「待合入」；退回保留原任务与原因，恢复执行中。任务页提供 Bug、待合入、已合入 Bug 筛选。

「核验合入结果」只读运行 Git，检查 `currentSubject` 的完整修复提交是否包含于目标本地分支，并要求已有测试、构建或设备验证回执绑定该分支的当前提交及同一仓库。非快进合并会产生新提交，项目会话须先上报该提交的验证。按钮不执行合并、推送或发布；squash/cherry-pick 暂不支持等价变更自动认定。记录表示核验时刻的结果，包含目标提交、验收记录和验证 ID。

Bug 的执行就绪与最终关闭分开：`completionReadiness.ready` 表示可办理验收；`completionClaim.allowed` 还要求验收及合入核验。修改 Bug 资料或当前修订后，旧验收不能继续用于关闭。普通任务行为不变。当前反馈入口仍使用项目反馈文档，完整资料、事件和合入记录均在原任务账本中保存；不创建第二套问题数据库。

人工入口复用本地 UI 操作来源检查，验收身份由服务端固定为 `human/local-user`，继续受任务 Workspace Policy 的来源/身份约束。它不接收 Agent 自填的人类身份；核心/MCP 事件不能提交合入证据。此本机信任模型不用于防御同一 OS 用户的恶意进程，不开放远程访问。

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

主会话也可通过 [可选 CLI 执行入口](docs/delegated-cli.md) 在原任务下授权 Kimi／Claude 执行；型号与推理档位集中配置，默认角色不变。

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

设置页的 Astra `context_management` 试点区按 TaskCenter 实际登记的 project/workspace 逐项读取项目级 `.codex/config.toml`，展示采集时间、仅新任务生效边界，以及启用后连续三个、带资格证据的自然长 Astra 任务指标。缺失、不可读或存在歧义时保持 `unknown`，不会推断成停用。启用、停用和刷新只写入 append-only intent 并唤醒现有 DevWorkbench 主脑；TaskCenter 不直接修改外部项目或 `~/.codex`。停用对当前任务属于软回退，关闭项目配置并新建 Astra 任务后才完成硬回退。目标项目以 TaskCenter MCP/Hook 协议向本机 `POST /context-management-pilots/intents/:intentId/result` 回写结果，并可用 `POST /context-management-pilots/trials` 提交试点证据。

后续整合优先复用稳定 task/context 关联和摘要投递，避免 Agent 手动维护两套执行状态。Context 投递失败保留 TaskCenter 已落账事实并走补偿，不能回滚或伪造验收。现有 Context 语义任务和生命周期适配仍保留；删除重复接口或迁移状态机需要独立设计与兼容性验证。

任务契约使用结构化 `AcceptanceCriterion { id, description, required }`。验证和审查绑定 `SubjectReference`，支持 `git_commit`、`git_worktree_snapshot`、`pull_request_head`、`artifact`、`document_version`、`external` 和 `none`。主体变化后旧证据自动 stale。参与者使用 `ActorIdentity`，审查独立性与验收身份由版本化 Workspace Policy 决定，而不是硬编码 Session 是否相同。绝对本地路径不能作为 standard/strict 的唯一跨团队证据。

以下步骤是 Codex/Hook 适配器的门禁流程，不是 TaskCenter Core 的通用前置条件：

默认情况下，每个 Session 按以下顺序执行：

1. `taskcenter_task_begin`：一次完成 Session 登记和 v2 任务创建，默认只返回任务状态、下一步和本地上下文引用。同一 Session 可在上一任务关闭或取消后顺序创建下一任务，但同一时间只允许一个活跃任务。已有客户端可继续分别调用 `taskcenter_session_register` 和 `taskcenter_task_create`；`standard/strict` 仍须提交验证计划。
2. 收到 `accepted=true` 与独立 `task_id` 后才能执行写操作。
   Codex 或 Git 创建关联 worktree 后，适配器会从 `.git` 指针自动识别主仓库、当前分支和 `execution_environment=worktree`。每个 worktree 保留独立 `workspace` 与 Subject，稳定 `project_id` 归并到同一项目；TaskCenter 不负责创建、合并或删除 worktree。Context bridge 同时把稳定 `project_id` 和具体 worktree workspace 传给 ProjectContext，使项目知识共享、执行证据隔离。
3. 使用 `taskcenter_task_update` 更新进度，使用 `taskcenter_task_report` 上报结果。
4. TaskCenter 可用时，当前主窗口模型在派发执行器前调用 `taskcenter_routing_select`。它会原子检查模型并发、`Closed/Open/Half-Open` 熔断状态并发放有 TTL 的执行租约；执行结束后调用 `taskcenter_routing_result` 释放租约并回报原始错误。TaskCenter 只给出强建议，不启动 CLI，也不取代当前主窗口模型的风险判断、整合和验收。
   `/routing` 页面复用 `/usage-report` 与任务账本展示真实额度窗口、重置时间和最近调度记录；模型卡片的并发数字仅表示当前活跃租约，不是历史调用次数。模型未绑定额度池也不等于额度充足，缺失或过期快照会按未知状态展示。
   主窗口负责理解、编排、整合和验收；普通执行通过 Codex 原生会话派发。`roles.executor.dispatch_channel=native` 禁止新 CLI 路由与授权，包含显式 CLI 请求和 Jev 失败降级。候选由 `config/model-roles.json` 统一定义：MiMo 四款优先，Kimi 三款与 GPT-6 Luna 共八款；具体型号由 Jev 按任务和宿主可用能力选择。默认 MiMo 2.6 Flash；其余候选、共享额度池和并发限制沿用集中配置，Luna 同样受执行器全局并发限制。
   `native_models` 与 `roles.executor.native_models` 合并声明 canonical → runtime ID 与可用档位（同键以 executor 为准），调用方必须传入本轮实际派发工具支持的 `available_native_models`。模型选择器可见不等于工具可派发；没有可用候选时明确返回不可用，不退回 CLI。既有 MiMo 映射保留在顶层，新会话映射位于 executor 字段内；旧版本忽略新字段，避免热读配置时因 high 档位校验失败，也不丢失原有 MiMo 映射。两款 Kimi Coding 通过用户授权的 `model_reasoning_efforts` 使用 high，其余保持 low/medium，K3 原生采用 low。路由报告 canonical、runtime 与配置档位；原生 grant/claim 校验 canonical/runtime 对应的独立 Session 和有效租约，宿主按路由指定档位启动。
   正式实例的 `TASKCENTER_MODEL_ROLE_CONFIG_PATH` 固定指向控制器工作区的可编辑 `config/model-roles.json`，release worktree 只承载代码，不成为模型策略副本。显式 `preferred_model` 仍优先于 task class 映射；retired 模型沿用既有归一化行为。`manual_only_models` 不进入自动角色池或普通 fallback，只有任务持久化 `execution_model_policy.mode=quota_preferred` 后才能使用。TaskCenter 按 `quota_limit_id` 读取独立额度池：新鲜且未耗尽时选择首选模型，明确耗尽时回到既有 executor 策略，缺失或过期时只在新派发边界做一次受并发限制的探测；额度失败不增加模型质量熔断计数。推理强度也由该配置控制：角色默认值为 `low`，仅 `task_class_reasoning_efforts` 或用户明确授权的 `model_reasoning_efforts` 可提升，路由结果与审计会保留实际强度。Reviewer 始终使用 reviewer 主模型并 fail closed，OCR 继续要求同一 Subject、Bundle 和规则证据，不接受 task class 映射或容量回退。
   回滚时删除对应 `task_class_models` 映射并恢复原 JSON；新派发立即回到 executor 主模型，已发放租约按原策略结算。
5. 当前主窗口模型有理由偏离建议，或 TaskCenter 暂时不可用而外部项目允许继续时，按静态规则执行并用 `taskcenter_routing_record` 记录 override；服务恢复后补录执行结果。TaskCenter 不得成为外部项目 build、test、commit 或 release 的单点依赖。本仓库自身启用 Hook 门禁时仍遵循 fail-closed 维护边界。
6. OCR 独立审查保持 reviewer 独立性：TaskCenter 固定使用集中配置中的 reviewer 主模型并 fail closed，同时记录 `fallback_from`、`fallback_reason`、`retry_after_at` 及同一 Subject、OCR Bundle、规则的引用或 fingerprint。TaskCenter 只返回建议和写入审计；独立只读 Reviewer Session、相同 Bundle/规则加载和实际审查仍由 Agent/OCR Skill 完成。普通实现 CLI Run 不能冒充独立 OCR 审查通过。
7. Agent 的 `done_claimed` 仅代表执行声明，提交时必须附带 `tests` 或 `evidence`；随后通过验收条件结果、Verification Claim 和独立 Review Attestation 计算 `completion_readiness`。
8. `accepted` 只能由携带 `TASKCENTER_ACCEPTANCE_TOKEN` 的独立验收适配器通过 `taskcenter_task_acceptance_report` 上报；来源可以是 human、pull_request、ci、task_platform、context_agent、manual 或 other。普通执行 Agent、`task_report` 和浏览器操作均不能直接设置最终验收。

### Jev 参与派发前判断

服务进程设置 `TASKCENTER_JEV_ROUTING=1` 并通过环境提供 `TYPESAFE_API_KEY` 后，普通 `/routing/select` 请求先让 Jev 判断任务类别与 `delegate/direct/needs_context`，再消费集中模型配置。请求可提供稳定的 `phase_id` 和简短 `phase_summary`；不发送代码、日志或完整会话。相同任务与阶段语义输入在进程内复用结果（包含失败与并发中的请求）；服务重启后可重新判断。

普通自动路由使用 `channel=other`，由 Jev 的 `delegate/direct/needs_context` 判断决定原生会话或主模型通道。显式 `direct` 必须携带 `direct_reason`；若 Jev 建议 `delegate`，还须提供 `direct_exception_kind`（`device_interaction`、`atomic_git` 或 `shared_dirty_workspace`）和以 `device:`、`git:` 或 `git-status:` 开头的对应 `direct_exception_evidence`，否则返回 `JEV_DELEGATE_OVERRIDE_DENIED`。尚未刷新 MCP 工具 schema 的客户端可在旧字段中使用 `[atomic_git] git:commit ...` 等同格式。这是可审计的例外声明，证据真实性仍需主会话核对；泛化的速度理由不能直接覆盖 Jev。Jev 选中 direct 时路由记录真实主模型，不占用执行器容量；`needs_context` 要求补足目标或范围。超时、缺失密钥、敏感输入或无效响应沿用集中配置的原生执行策略（没有可用能力即不可用），不循环重试。`jev_decision` 保存有界摘要、判断、例外和用量；模型调度页另列最近 24 小时 Jev 建议、实际路由与 CLI 授权的独立计数。Codex Hook 仍要求项目执行前有匹配的活动路由。

这项能力只作用于实际提交的路由请求，不会替主代理启动进程，也不能拦截绕开路由的主模型操作。主代理须按项目规则在新执行阶段先请求判断。关闭环境开关只关闭 Jev 判断，仍遵守 native-only 配置；后续服务启动仍需提供开关和密钥环境，密钥不写入仓库。已连接的 MCP 客户端需要重新连接才能看到新增可选字段。

主 Agent 派发普通原生执行器时不另建正式子任务：先取得 native route，再签发绑定该 `route_id` 的短期授权。执行器使用真实独立 Codex Session 登记并 claim；`executor_model` 使用 canonical ID，Session 模型必须等于 `native_model`。生命周期和证据沿用 `taskcenter_cli_run_report`，该 API 名称兼容历史 CLI，但同时承载 native 回执。CLI 历史记录、报告和撤销保留；当前策略拒绝新 CLI 授权。只有独立交付物、生命周期或验收边界才创建正式子任务。

scope 为文件工具提供可执行的路径边界；可识别路径超出 scope 时 Hook 会阻断。任意 Shell 命令无法可靠静态证明实际写入路径，因此只有 scope 显式为整个 workspace（`.`）时才允许，同时仍受精确 workspace、Session、TTL 和 `allowed_tools` 约束。该机制是任务授权边界，不替代 Codex sandbox 或操作系统隔离。

完成闭环包含四层独立状态：执行 `done_claimed`、验证 `verification_status`、审查 `review_status`、最终验收 `acceptance_status`。`done_claimed` 在 UI 中显示为“已声明完成”，不能等同于真正完成。`CompletionReadiness` 还返回当前 subject、机器可读 reason codes、缺失/失败条件、过期证据、未解决 findings 与 `completionClaim.allowed`；只有该字段为 `true` 时，调用方才可以向用户宣称任务真正完成。`strict` 默认要求当前 subject 的独立审查，但 Workspace Policy 可以显式调整。历史记录只追加，不覆盖。

新版 Review Attestation 使用 `review_contract_version=v2`，由同一个独立 reviewer 按顺序提交 `spec_verdict`、`quality_verdict`、总体 `verdict` 和 `unverified_requirements`。总体 `approved` 仅在规格 `compliant`、质量 `approved`、没有未验证要求且没有未解决 finding 时成立。旧记录继续按 `legacy` 读取，不伪造缺失的双结论。

OCR Review 与业务任务生命周期分离：已登记的任务所属 Session 可对 `in_progress`、`done_claimed`、`blocked` Task 调用 `taskcenter_routing_select(ocr_review|independent_review)`，无需 active Task，也不创建审查子任务。`blocked` 仅允许报告问题；该限制在领取和报告时重验，不能通过解除阻塞后复用诊断 lease 来批准。`planned`、`cancelled` 和不存在的 Task 不允许进入新 Review。

路由请求必须提供 `review_artifacts.subject/bundle/rules`。Subject 的 ref 或 fingerprint 必须匹配当前 `SubjectReference.value`；路由冻结完整 SubjectReference，后续领取和报告对 type、value、repository、branch 精确比较。Bundle 和 Rules 使用不可变引用或 fingerprint，由独立 Reviewer 实际加载，报告中的三项证据必须与路由逐项一致；本地控制面不下载或执行引用内容。

路由返回独立 `review_record` 和领取 capability。宿主使用集中配置的 reviewer 模型及 `read-only` 沙箱启动独立 Reviewer；Reviewer 登记后调用 `taskcenter_review_claim(route_id, claim_token, sandbox="read-only")`，随后通过 `taskcenter_task_review_report` 携带同一 `route_id`、`review_artifacts`、完整 `subject_ref` 上报。最后 `taskcenter_routing_result` 释放租约。MCP 从可信宿主绑定实际 Session，领取同时校验工作区、模型及与实现 Session 的独立性。同一 Reviewer Session 可领取多个 Task 的 Review；Hook 和账本禁止它创建业务任务或写入实现。Hook 是生命周期守卫，宿主仍须提供真正的只读沙箱。

非交互 CLI Reviewer 使用 `node /path/to/ReqRadar/scripts/reviewer-cli.mjs PROMPT_FILE OUTPUT_FILE [REVIEWER_SESSION_UUID]`。宿主先取得 OCR route，再将 route、claim token、精确 Subject/Bundle/Rules 与验收条件写入 prompt；从受审工作区启动。入口固定集中 reviewer 模型和只读沙箱，仅为本进程的 Session 登记、review claim、review report 逐项授权，不改用户配置或全局审批。恢复已有 Reviewer 时填写其真实 UUID；路由结果及租约释放仍由宿主负责。

推荐使用统一入口 `node /path/to/ReqRadar/scripts/reviewer-cli.mjs --managed REQUEST_JSON OUTPUT_FILE`。请求文件包含 `route_id`、`claim_token`、精确 `workspace`、`prompt_path` 和已验证的 `native_unavailable_reason`；主代理先按原权限取得路由。已知原生通道缺少独立 Session 时不重复试错，保留同配置 Reviewer 并记录 CLI 原因。Reviewer 首次调用无参数 `taskcenter_review_start`，程序绑定真实 Session、登记、领取和建立周期；只需阅读返回的固定证据并用 `taskcenter_review_finish` 提交逐文件覆盖、findings 与规格/质量结论。漏文件不可批准，报告身份与 cycle 由程序填写，成功后自动释放租约。启动器只有实际 finish 回执与租约释放均成功才返回成功；失败时用父 Session 尝试释放，失败会明确提示父任务处理。旧裸 CLI 入口仍兼容，但不会自动获得统一流程。



`GET /tasks/:id/reviews` 返回 `pending/running/approved/changes_requested/failed` Review Record；记录保存在本地 routing-control 状态中，与 Task 状态分开。Task 的新 `review_status` 聚合为 `not_started/pending/approved/changes_requested`，旧 `reviewStatus` 和 Attestation 字段继续保留。失败、过期或只有路由成功而没有报告不会变为 approved；要求 Review 的任务在新审查未完成时不能最终通过。

拒绝响应保留旧客户端可读的 `error` 文本，新增 `code`（`SESSION_NOT_REGISTERED`、`TASK_NOT_FOUND`、`TASK_NOT_REVIEWABLE`、`SUBJECT_MISMATCH`、`REVIEW_ARTIFACTS_INCOMPLETE`、权限与证据不匹配码），并提供 `legacy_code=ACTIVE_FORMAL_TASK_REQUIRED` 兼容映射。模型/并发失败在路由的 `error_code` 中区分 `REVIEWER_UNAVAILABLE` 与 `REVIEWER_LEASE_UNAVAILABLE`，保留原始路由原因。正常 Review 不使用 `session_gate_exemption`。

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

### 同一 Codex Session 顺序承载任务

普通顺序任务无需切换或压缩：关闭或取消当前任务后，直接调用 `taskcenter_task_begin` 创建下一任务。TaskCenter 保留每个独立 `task_id` 的合同、证据和用量归属；Hook 始终绑定该 Session 最新的唯一活跃任务。

仅当上下文已经过大并且需要恢复检查点与显式压缩时，才使用下面的会话切换协议。

`task_close` 的生命周期建议不会执行压缩，也不会授权第二个任务。显式切换使用 `taskcenter-session-switch/v2`（旧版请求和 receipt 不再授权重绑）：

1. 先关闭原任务。`done_claimed` 必须满足当前 `completionReadiness.completionClaim.allowed`；`cancelled` 必须有 `evidence` 和取消原因 `retrospective`。这不新增或替代独立验收。两条路径均要求当前 Subject 是 Git HEAD、工作区干净、没有活动 delegation。
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

大依赖核查：`@openai/codex-sdk` 被 `scripts/harnesses/codex.mjs` 的新建会话入口使用，并传递依赖 Codex 原生 CLI；`@cloudflare/vite-plugin`、Wrangler/Workerd 被 `vite.config.ts` 构建链使用。它们不是无调用方的残留依赖；本次保留功能与依赖版本，不用删除依赖或共享可变 node_modules 来缩短部署。
