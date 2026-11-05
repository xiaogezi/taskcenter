# CI 验证成本与最小分级候选

状态：2026-11-05 格子已选择 A，保持当前全量基线，暂时不做 CI 分级。CI 与部署门禁不变。

取证日期：2026-11-05。源码基线：`ab6cf3ebb6a7f7ae3868fe456bbced5ba20631fe`，取证前工作区干净；package 0.1.5，CI Node 22.13.0。
机器可读记录：[历史运行及计时](evidence/ci-cost-2026-11-05.json)。本提案只分析 ReqRadar，不涉及其他项目。

## 结论与事实

目前没有证据支持立即引入跳过策略。最近 30 个本地提交中，纯 `docs/**/*.md` 提交为 0；这只是本地提交样本，不代表 PR 分布。全量测试确有成本，但历史 CI 暴露的是实际检查失败，不能将它们当作可删的冗余。

现有 `.github/workflows/ci.yml` 对 PR 和 main push 均运行 Ubuntu/Windows 两个 job，`fail-fast: false`、20 分钟超时、只读 contents 权限、完整 Git 历史；尚无路径分类器。

每个 job 依次执行 npm ci、lint、typecheck、npm test、生产闭包、空白检查、生产依赖审计、pack dry-run。生产闭包为 `if: always()`；后续空白/审计/打包在前面失败时通常跳过，失败运行不能证明这些检查通过。

`npm test` = fixture sync + production build + `scripts/run-tests.mjs`，后者收集全部顶层 `tests/*.test.mjs`，Node test concurrency=4。测试子进程禁用 Jev 路由/AI observer 并移除 Jev 凭据，当前不需要增加模型回放。

`verify:production -- --install` 拷贝受版本管理的源码与 dist，隔离安装 production dependencies，启动独立 runtime/Codex home/端口/数据，验证页面、健康、watcher、MCP、无 Codex 调用及 release budget。它依赖真实 build 和 fixture，不能把“只跑单测”称为生产闭包。

## 已有成本与失败数据

GitHub API 全量可见记录共 22 次，日期 2026-08-13 至 2026-10-15：14 success、8 failure；最近 5 次均失败。最新记录 SHA 为 `bf124bf631c5eafe3d452217d43aaa416df519b1`，与本次基线不同。未触发新运行。

取最近 5 次失败加最近一次成功，共 6 runs / 12 jobs 的 latest attempt step 数据：8 jobs 在 npm test 失败，2 jobs 在 audit 失败，2 jobs 成功。此为选择性样本的步骤分布，不是当前失败概率；较旧 workflow 没有 typecheck/closure 步骤，不能混合当作同版本基准。

| 最近两次 CI 日期/SHA | Ubuntu job / npm test | Windows job / npm test |
|---|---:|---:|
| 10-15 / bf124bf | 137s / 103s | 192s / 129s |
| 10-15 / f1c2bb8 | 84s / 60s | 169s / 105s |

job 时长按 started/completed 计算；npm test 包含 sync/build/测试。不能将两平台时间求和后称为用户等待时间，也不是账单分钟。最新一轮 run started 到 updated 为 196s，仅是粗略跨度，不能拆出排队时间。

最新两平台日志在 [run 38725140887](https://github.com/xiaogezi/taskcenter/actions/runs/38725140887) 可复查：Linux 测试摘要 fail=1，artifact environment 未校准（linux-x64/Node22.13.0/npm10.9.2），随后 closure 同类失败；Windows fail=14，涵盖环境预算、权限、工作区、Hook、文件观察、release 隔离及 HTTP 协议。这里仅确认旧版本日志信号，不把历史错误归因于当前代码，也不在本任务修复。不能为提速关闭平台预算、权限或 Windows 测试。

本机既有 549 用例记录，取 test runner 的 duration，不含 sync/build：

| 日志（均位于本机 .local/verification） | 秒 | pass / fail |
|---|---:|---:|
| reqradar-ssh-full-tests.log | 87.545 | 549 / 0 |
| ssh-controlled-deploy-20261105.log | 156.745 | 549 / 0 |
| no-active-task-full-20261105.log | 397.640 | 549 / 0 |
| recovery-controlled-deploy-20261105.log | 415.000 | 548 / 1 |
| recovery-controlled-deploy-retry-20261105.log | 168.203 | 549 / 0 |

同一 ab6cf3e 的后三次在 168–415s 间变化；跨版本、重试和同机负载存在混杂，不能将它作为 CI p95 或优化对照。最近成功记录最慢单例为“L0 路径探测跨客户端放行，但不能借 command 包装执行”23.795s，次为 scheduled_readonly 精确能力检查18.231s；失败记录中同类 Hook 用例可达51–64s。它们包含安全/所有权行为，耗时不构成跳过依据；并发单例时间不能直接相加估算墙钟节省。

唯一所选本地失败是同 event_id 补偿重放：旧诊断已观察到 2000ms fixture deadline 先于首个请求完成，未改代码/放宽超时的后续完整受控部署通过。CPU 竞争是可能解释，未建立因果。完整证据仍保留本机，不提交原始运行日志或会话。

## 必要检查映射与最小候选

当前所有路径仍全量。本表仅保留未采用的 B 候选分析，不是执行计划或已生效规则；不引入 normal/kernel 等没有本仓依赖依据的层级。

| 改动路径/事件 | 候选检查 |
|---|---|
| PR 仅修改已有普通文件 `docs/ci-validation-cost-proposal.md`、`docs/security-audit-2026-11-05.md`、`docs/open-source-improvement-proposal.md` 之一或多个 | 可候选 docs；保留双 OS npm ci、lint、typecheck、fixture sync、build、版本一致性测试、分类器自身测试、always production closure/budget、完整 diff 空白检查、audit、pack；只考虑减少其余全量 Node 用例 |
| docs 下其他路径（包括 claude-lifecycle.md、evidence JSON、新增文件）、README/AGENTS/CONTRIBUTING/SECURITY/CHANGELOG/LICENSE、project-context | full，逐文件核实后才可扩白名单；不能按扩展名自动升级为 docs |
| scripts、tests/fixtures、tests、config、integrations、data | full；涉及任务、持久化、权限、Hook、跨平台、构建和运行态 |
| app、features、lib、public、package manifests/lock、构建/lint/TS配置、.github | full；UI 与共享协议/闭包存在连接，不另设前端快速层 |
| 未知路径、空 diff、取差异失败、base 不存在/历史不足/分类异常、删除/改名/复制/类型改变/符号链接 | full；不把错误或未知算 docs |
| main push、非 PR 事件、部署或正式发布前验证 | full；本机 service:deploy 完整门禁保持独立且不变 |

选择这三个文档作为候选的事实依据：限定搜索 scripts/app/features/lib/config/integrations/tests 未发现其内容读取；`buildInputHash` 不包含 docs，TS include 不含 Markdown，npm files 未列 docs。不过 productionFixture 会复制所有 tracked 文档，未来也可能新增读取；因此这是受依赖变化约束的有限候选，非“所有 Markdown 永远安全”的证明。Hook 明确指向 docs/claude-lifecycle.md，README 被 version.test 消费，根目录规范与安全说明均不适合照搬上游 docs 白名单。

最小分类器若被选中，建议用现有 Node/Git，不加依赖或插件。PR 以事件固定 base/head SHA 的 merge-base 至 head 得到完整差异；验证两个提交可读，不采用仅最后一个提交的差异。NUL 分隔 name-status、`--no-renames`；识别不支持的状态立即 full，改名/删除保守 full；混合改动取 full。不可从 PR 控制的环境或路径文本执行 shell。required check 名称和矩阵不随 scope 消失，结构化输出只含 base/head、scope、reason、路径计数及将运行检查清单，避免正文和秘密。

## 可选方案、验证与退出

**A（已选择）：保持基线。** 不改 workflow、不增加分类器。现有门禁、生产闭包和平台检查已覆盖；本次只新增成本证据和候选说明。收益是避免未经证明的分级维护成本，不宣称提速。后续有当前版本的自然 CI/PR 数据再重评，不为本任务重跑全量基线。

**B（未采用）：先影子分类，达标后另行确认启用有限 docs 检查。** 修改范围仅 `.github/workflows/ci.yml`、一个 Node 分类脚本与定向测试、必要 CHANGELOG；无服务/API/数据格式变更。影子阶段所有现有检查照跑，输出预计 scope 与完整检查结果；不立即跳过任何步骤。成本是两平台分类维护及数据观察，当前 0/30 样本暗示短期收益可能很小，但不能外推到未来 PR。

若选择 B，验收必须覆盖：多提交 PR 的早期核心改动、混合路径、未知文件、base/head 缺失、浅克隆、删除、改名（尤其核心移入 docs）、换行路径、类型变更、main。确定性测试使用本地临时 Git fixture；无模型回放。影子窗口至少收集10个自然 PR或14天；没有至少3个实际 docs 候选则停止扩展并保留 A。记录候选比例、对应 build/test/closure 墙钟、实际非候选检查失败、分类原因与维护量；观察期完成不自动授权跳过。

漏检检测：影子阶段 docs 候选仍全量，比对其拟省略用例是否失败；任何相关失败都回 full 并查依赖。未来经确认启用后，main 仍全量且不用 cancel-in-progress 淘汰未验证提交；每第5个 docs 候选 PR 强制全量，手工 full 覆盖入口保持可用。任一候选省略检查在影子、抽检或 main 发现相关失败，立即撤销 docs 快速层并全量复验涉及提交；main 事后检测不等于阻止合入前漏检，接受该风险需单独确认。

回滚仅撤销 scope 条件恢复当前完整 job，不停服务、不改预算/超时/权限、不清历史证据。只有当前两平台全量自然运行成功且影子没有漏检信号、实际 eligible 比例和时间足以覆盖维护成本，才值得讨论启用；当前尚无这些证据，不承诺百分比收益或节省金额。

## 参考、判断和边界

- 已读取 [agent-autoloop ci-scope.sh](https://github.com/KKKKhazix/agent-autoloop/blob/ad0384f7ee91f7e6d0b6b65453f4659eef3add23/scripts/ci-scope.sh)，版本固定为该完整 SHA。只借鉴确定性分类、未知/差异失败全量、main全量、移动保留源路径和先证明测试覆盖的思路；其 kernel/protocol/sim 及目录分级不适用本仓。未复制代码或引入依赖，其注释中的成本/故障实验不视为本仓证据。
- Engineering Reference：索引 schema6，2026-10-26构建；《DevOps实战笔记》“持续集成：你说的CI和我说的CI是一回事吗？”第2节，sourceRelpath=`DevOps实战笔记/12-持续集成：你说的CI和我说的CI是一回事吗？.md`，chunk=`chunk_af6504111a32c1fe2aee`。该参考支持按分支集成目标选择检查，不能单独证明本仓省略测试安全或有效。
- Agent 判断：分析时推荐保留 A，用户现已确认；B 未采用，不是已经优化。Jev 1.14.0 建议 keep_baseline，call `18bba5bb-8865-4eb0-9663-7b714ddda478`，主代理采纳；自动调用日志已落盘。检索重排仅用于选参考，与技术决策调用不同。本次明确选择直接记录，无新增语义决策或模型调用。
- 未知：当前 SHA 的托管 CI 结果、PR 构成、排队/账单与金额、减少用例的真实耗时和漏检率、旧平台失败是否仍存在。API成功和本次静态分析不证明这些未知项。
- 本次交付验证：历史统计、workflow/调用链/文件消费者核对、JSON解析与 diff检查。没有功能行为变更，不运行 sync/build/full tests，不要求新增运行日志；已有日志为成本分析来源。changelog: not required（仅待选分析文档，没有改变检查或发布规则）。独立验收仍由授权主体完成。

## 已确认决定

2026-11-05，格子明确选择：“按 A 保持全量基线，暂时不做 CI 分级。”因此不启动 B 的影子分类或省略检查；相关内容仅作历史候选保留。需要重新评估时，须由新的明确授权接续，不因观察期或数据积累自动启用。

本次仅记录决定；CI workflow、检查集合和本机受控部署门禁均保持原状，无需部署或重跑完整测试。PCA 当前连接未完成，本决定先记录在本仓文档和 TaskCenter，不宣称已同步 PCA。
