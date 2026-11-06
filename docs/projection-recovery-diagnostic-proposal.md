# 现存任务投影落后：只读诊断输出提案

状态：2026-11-06 用户已明确采用新增 `projectionDiagnostics` 的只读契约，继续完成修复与验证；不做恢复写回或自动重放。方案取证基线 `c366eb38753a564345b077eda5d1d54ce643baf4`，实现起点 `0c220c38ee355b6003866e1f0005a3b378e066fb`，开始前工作区干净。下列基线复现记录保留原时点含义，不代表新增实现的验证结论。

目标是让人工能沿现有只读入口看到“持久事件比现存投影更新”的线索；不提供完整重建、apply、自动重放、任务/Run 重开或外部验收推断。CI 全量基线继续保留。

## 已证实的断点和边界

`scripts/task-ledger.mjs` 的幂等重试先核对原事件身份，再通过 event-store `projectionBehind` 比较持久 seq，发现 journal 先于投影落盘时返回 `409 TASK_LEDGER_RECOVERY_REQUIRED`。但 `task-recovery-preview.mjs` 跳过所有现存且非 removed 任务，因此推荐入口无法展示该问题。直接消费者只找到 CLI、自身测试和恢复文档，没有当前 HTTP/MCP 接口；CLI 的 JSON 仍是对外契约。

隔离探针使用 0400 账本/事件文件：existing/owner/planned，lastEventId=create-1；journal 为 create-1 → update-2，后者带 in_progress 及 current_step。结果 `complete=true,tasks=[]`。9 个固定序列场景重复查询结果一致，源字节均不变；正常一致、派生事件、未知锚点和未来类型目前也都被跳过，missing/removed 仍有输出，损坏行/尾行使 complete=false。

可提交的脱敏结果见[9个基线场景](evidence/projection-preview-baseline-2026-11-05.json)；本机完整隔离结果位于 `.local/verification/projection-preview-baseline-20261105.json`。其成功含义是确认旧行为和诊断缺口，**不是修复通过**。既有 preview/event-store 13 项测试通过，日志 `.local/verification/projection-preview-existing-tests-20261105.log`。未跑完整测试，当前没有运行代码改动。

不能将 lastEventId 与 journal 最后一条简单比较：

- `derivedCompletionEvents` 在原事件后追加 verification.staled/review.staled/acceptance.ready，但投影标记仍指向原事件。
- `review.reported` 明确有单独补偿路径；不能把它转换成通用重放指令或推断验收通过。
- detach 可生成不在 journal 中的标记；旧 journal、缺锚点及未知版本只能显示未知。
- 当前 auditState 只含执行/Run/验证/review/验收/Subject 摘要，不是完整任务快照；即使能比较位置，也不能重建全部字段。
- retention 只删除 tool_details；关键 journal 与工具非空事实、storage_fingerprint 仍保留。只读诊断不得调用 `eventStore()`/`TaskEventStore`，它们会创建/同步 SQLite/WAL、改权限；不能用索引写入冒充预览只读。
- `complete` 仅表示当前扫描完整且未检测变化；未知事件语义不应假装“可恢复”，稳定 JSON 也不保证语义完整。

## 已选定：独立诊断段，不改变现有 tasks 语义

保留当前入口、参数、退出码、missing/removed 的 tasks 结构和 mode=preview_only；新增根字段 `projectionDiagnostics`，与恢复候选分开。它只列出 behind/unknown 的现存非 removed 任务，已知一致任务不列出；没有条目不能证明完整投影等价。无新依赖/持久化/服务/API。未知情况呈现线索，继续保留原请求拒绝。

新增输出契约（所有列均必有；未知位置/ID用 null，issues为字符串数组）：

| 字段 | 类型/含义 |
|---|---|
| projectionDiagnostics | array，下述行的集合，按账本顺序 |
| id | string，账本任务 ID |
| state | behind 或 unknown，仅表示事件位置诊断 |
| projectedEventId / projectedOrdinal | string或null / 正整数或null，当前任务锚点及源中的位置 |
| latestSourceEventId / latestSourceOrdinal | string或null / 正整数或null，最后可解释的原始投影事件（排除派生摘要、reminder） |
| issues | array，稳定诊断码；不含任务正文、prompt、外部证据或凭据 |

ordinal 定义为本次扫描的非空 JSONL 记录序号，与当前 lastEventOrdinal 同一口径，**不是 SQLite seq 或物理行号**。出现 skipped oversized 时序号不再作为完整位置证据。不得混用旧/compact/archive 三份文件的序号；调用者只对输入的同一 journal 核对，必要时人工另取归档完整副本。

原探针期望（既有 tasks 仍为空）：

```json
{"projectionDiagnostics":[{"id":"existing","state":"behind","projectedEventId":"create-1","projectedOrdinal":1,"latestSourceEventId":"update-2","latestSourceOrdinal":2,"issues":["persisted_event_after_projection"]}]}
```

## 判断规则与故障语义

1. 仍以只读文件读取/流式扫描为准，不加载账本执行器、调用网络或创建索引。先验证账本唯一 ID；JSON错误、权限错误保持明确失败，不能输出空成功。
2. 先构建每个任务的事件位置与 ID 重复/冲突证据，排序只按输入 journal，不用 occurred_at/created_at 猜顺序。只有同任务、唯一可核对的 projectedEventId 能作锚点；其他情况 state=unknown，issues=projection_anchor_missing 或 ambiguous_event_identity。
3. 原始已知事件集合以本基线 normalizeEvent 的 allowedTypes 为准（除 session.register 和 task.reminder），但 review.reported 单独处理。必须能识别 text_format 缺省的旧格式或 multiline-v1、tool-facts-v1 的保留事实；其他显式 text/storage format、未知类型或缺 event_id 为 unknown_event_semantics。旧格式虽可列位置，但缺乏必要状态/身份信息则 unknown，不补默认成功。
4. 三种派生类型仅在 event_id 精确为同任务已见原事件 ID加冒号类型、前后 auditState 与原事件相同且记录连续时视为该原事件的摘要；不独立推动 latestSourceOrdinal。结构无法证实为 derived 时标 unknown_derived_event，而不是静默忽略。
5. task.reminder 仅是提醒，不更新 task.lastEventId；它不推动位置。review.reported 晚于锚点时标 state=unknown、review_evidence_requires_check，交人工沿既有 review 专用契约核对，不调用专用补偿或宣称任务落后已确认。
6. 对完全相同的重复 ID/事件可保留首位置并标记重复事实；同 ID 不同规范载荷、跨任务重用 ID 或无法证明等价时 unknown。不能在重复 ID 存在歧义时拿最后出现的位置误报 ahead/behind。规范比较需涵盖 auditState，不能仅用幂等业务指纹忽略审计差异。
7. 在源稳定、完整、该任务相关事件语义/身份可核对、锚点可定位且晚于锚点存在已知原始投影事件时才 behind。issues=persisted_event_after_projection；这仅确认持久事件位置领先，不声称字段完整、可写回或已恢复。锚点等于最后源事件且无歧义时不输出该任务。
8. 源变化、损坏/超长/尾行不完整，沿用 complete=false，所有现存任务位置结论降为 unknown，issues=incomplete_or_changing_source，不保留 behind 的确定口吻。比较前后 inode/dev/size/mtime/ctime 及账本内容；仍明确“未检测到变化”不是防恶意篡改保证。

具体保护场景均来自本次故障：缺锚点/派生/review 可能误报，损坏和未来格式可能漏掉事件，重复 ID 可能破坏位置顺序，因此不引入默认状态、吞异常或通用 fallback。源读取没有新授权能力，仍依赖调用者合法取得的备份。

## 实施、验证与回滚边界

用户选择后才改 `scripts/task-recovery-preview.mjs`、原测试、`docs/task-retention-recovery.md` 和 CHANGELOG Unreleased；不改 ledger/event-store 的写入或拒绝逻辑。只在现有扫描内做诊断，不复制上游 evolve 或创建可重放状态机。新增算法需要保存 ID/任务的必要位置和冲突摘要，内存随任务/事件ID规模增长；不复制全部原始事件正文，CLI成功输出只保留现有必要摘要与新诊断码，详细历史由调用者查输入文件。

固定序列回归：正常一致→journal更新但投影未写→重复预览；合法派生事件不误报；review专用未知；缺/跨任务锚点、重复/冲突 ID、未来类型/格式、旧格式信息缺失、压缩 tool 事实；missing/removed不变；坏行/超长/尾行与读取中变化。fixture输入只读，重复请求不写源、不创建Session/Run、不触发外部调用。通过现有 CLI 的隔离成功/异常场景将脱敏结构化结果写入 `.local/verification/`，逐次比较源 hash；JSON结果是运行证据，不把“命令exit0”当效果正确。

代码交付前按项目运行 sync、lint、完整测试和 diff 检查；不改变 CI 全量决定，不部署、不重启。回滚只撤销新增诊断输出及对应测试/文档，原拒绝与只读恢复候选仍在；无生产迁移或数据回滚。

## 参考与已选定方案

[上游 evolve.ts](https://github.com/KKKKhazix/agent-autoloop/blob/ad0384f7ee91f7e6d0b6b65453f4659eef3add23/kernel/evolve.ts) 用显式事实/变化与投影位置；[simulation.test.ts](https://github.com/KKKKhazix/agent-autoloop/blob/ad0384f7ee91f7e6d0b6b65453f4659eef3add23/tests/simulation.test.ts) 验证故障顺序和重放不变量。本仓 journal 不是它的完整 Fact，不复制表结构、调度或20万步预算。Engineering Reference《分布式金融架构课》“春节策划第3期-如何运用架构知识解读春运买票和手游案例？”（sourceRelpath=`分布式金融架构课/春节策划第3期-如何运用架构知识解读春运买票和手游案例？.md`，chunk_02a98b51a19d68c7ded6，索引schema6/2026-10-26）支持重放依赖确定语义与顺序，不证明本仓可以通用重建。

Jev call `40ff039e-38ac-4c0b-83db-8f5ca213fe19`、jev-1.14.0 对窄只读诊断的证据支持返回0.92，主代理采纳为提案依据，不代替用户选定。

2026-11-06 用户已采用上述契约并授权修复与验证；无需重复选择。不授权 apply、自动重放、生产数据修复或部署。原方案提交 `8f6bad4` 仅含文档和基线证据；本次代码变更须另附实际 CLI 与全量验证证据，CHANGELOG Unreleased 同步记录行为变化。

## 本次实现验证（2026-11-06）

实际结果见[脱敏验证证据](evidence/projection-diagnostics-validation-2026-11-06.json)，绑定本次脚本与测试的 SHA-256。原探针现输出 `behind`；一致状态不输出诊断，review、缺失锚点和不完整源输出 `unknown`，非法账本明确失败。7 组真实 CLI 场景各执行两次，输入文件 `0400`、目录 `0500`，输出一致、源 hash 与权限不变、无索引或旁文件。

`npm run sync`、`npm run lint`、`npm test` 全部通过（581 项，含预览回归 33 项）；真实写入重试在隔离 fixture 连续两次保持 `TASK_LEDGER_RECOVERY_REQUIRED`，账本和 journal 未变。完整日志为 `.local/verification/projection-diagnostics-final-20261106.log`，CLI 结构化结果为 `.local/verification/projection-diagnostics-cli-20261106.json`；可查询 `projectionDiagnostics`、`issues`、`sources_unchanged` 与测试汇总核对预期信号。验证仅覆盖本机 macOS，不代表 hosted CI、独立验收或部署；未读取生产输入、执行恢复写回或自动重放。

验证方案选择复用既有工程参考；Jev call `0f04d877-7da8-4d1f-b14c-92e6624a811b`（jev-1.14.0，支持度 0.79）支持真实只读 CLI、实际拒绝行为及全量回归组合，主代理采纳并按上述证据执行。
