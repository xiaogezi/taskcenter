 > 历史设计记录：模型路由、委派与托管 Reviewer 已退役。本文不构成当前执行规则；现行边界见 README 的「主线治理边界」。

# CLI 执行器试点评估口径（MiMo / K3）

> 目标：用真实执行数据判断是否扩大 MiMo/K3 的默认分工，而不是凭印象或单次结果决定。

## 数据来源

| 数据 | 来源 | 位置 |
|---|---|---|
| 主代理消耗 | usage-report（estimatedCredits、24h 窗口） | `.local/runtime/usage-report.json` |
| 执行器运行与回执 Token | delegation store（evidence.usage） | `data/delegations.json` |
| 治理指标 | governance-metrics（completedTasks、reworkRate、durationMs、comparisons、cliRuns） | `.local/runtime/governance-metrics.json` |
| 运行状态 | routing-control（熔断、租约、限流恢复） | `data/routing-control.json` |

## 口径

- **合格任务**：验收通过（accepted）或已验证（verified）且非 removed 的任务。待验收、退回、取消不计入成功组。
- **主代理消耗**：`usage-report.overall.estimatedCredits`，仅当 `creditsEstimation === "complete"` 时按实际值比较，否则标注不可估算，不推断为 0。
- **执行器消耗**：delegation 回执证据中可解析的 usage（输入/输出 Token），按执行器模型分组；无回执用量的运行计入运行次数但不计入 Token，并标注报告比例 `reported/runs`。不同提供商的 Token 不换算为 credits，与主代理消耗并列展示。
- **质量**：合格任务占比、返工率（`reworkRate`：有返工标记的任务/已完成任务）、验收轮次（reviews 指标）。
- **耗时**：`durationMs` 分布（平均/P50/P95）。
- **对比**：`comparisons`（matched_task_type_or_alternating_windows）对同类任务进行试点组/对照组匹配比较。

## 决策规则

1. 固定观察窗口（建议 ≥ 14 天，或至少积累到每执行器 ≥ 若干合格任务样本），窗口内不中途变更分工策略。
2. 试点组（MiMo/K3 合格任务）与对照组（同类别主代理任务）比较时，按**合格任务**口径筛选，不看中途失败或取消。
3. 只有当试点组在**质量不劣于对照组**（验收通过率、返工率）的前提下，总消耗（主代理 + 执行器）或耗时具备明确优势时，才提出扩大默认分工的变更；否则维持现状。
4. 任何决策变更（model-roles.json、路由策略）必须走既有配置与发布流程，不静默替换。

## 当前实现

- 指标聚合：`governance-metrics.mjs` 的 `buildCliRunMetrics`（运行次数、状态分布、按模型分组、回执 Token 累计），由 metrics-worker 定期写入快照。
- 展示：模型调度页（/routing）"CLI 执行器消耗"与"今日用量"两个区块；任务详情 CLI 执行记录显示每次运行的回执用量。
- 额度：MiMo/K3 无官方余额查询接口（已实测 kimi/claude CLI 均无 balance/quota 命令），额度池按 `runtime-signal` 标注，余额未知，仅限流信号（retry-after / quota_retry_after_at）与本地累计；Codex 池按官方 rate_limits 标注。
