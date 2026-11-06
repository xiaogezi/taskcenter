# 任务保留与历史恢复

2026-09-20 用户选定继续使用现有 JSON 账本，不引入数据库或冷归档。

- 账本不再截断至 500 条；归档和已移除记录仍保留，列表继续按现有规则隐藏它们。
- `/tasks`、`/session-status` 和普通任务事件不再因 Session 不在当前会话源中而自动移除历史任务。已登记身份及任务归属校验保持生效。
- `task.create` 在 5,000 条快速去重窗口之外仍核对原始事件。历史任务已缺失或移除时返回 `409 TASK_LEDGER_RECOVERY_REQUIRED`，不通过重新创建覆盖历史状态。已有任务的相同事件重放仍幂等，改变原事件内容仍拒绝。

## 只读恢复预览

对一致的账本与事件备份运行：

```sh
node scripts/task-recovery-preview.mjs /backup/task-ledger.json /backup/task-events.jsonl
```

命令只输出 JSON，不修改源文件。结果列出缺失或已移除任务的创建事件、最近事件、最后已知执行状态及活跃 Session 冲突。损坏行、超长行、未完成尾行或读取期间源文件变化会使 `complete=false`；这时应重新取得一致备份。

2026-11-06 已选定新增独立的 `projectionDiagnostics`，诊断现存且非 removed 的任务，原 `tasks` 候选含义不变。它不调用事件存储索引、不创建 SQLite/WAL、不写入账本、事件、Session 或 Run；任务请求的 `TASK_LEDGER_RECOVERY_REQUIRED` 拒绝仍生效。

| 字段 | 含义 |
|---|---|
| id / state | 任务 ID；`behind` 表示已知持久原始事件的位置领先投影，`unknown` 表示不能可靠判断 |
| projectedEventId / projectedOrdinal | 账本 lastEventId 与其在输入 journal 中的位置；缺失或歧义位置为 null |
| latestSourceEventId / latestSourceOrdinal | 最后可解释的原始投影事件 ID/位置；未知值为 null |
| issues | 有界诊断码集合，不包含任务正文或原始事件载荷 |

位置是本次扫描非空 JSONL 记录序号，不是 SQLite seq 或物理行号；空行不计入，损坏非空行计入。跳过超长行后，新增诊断中的位置均为 null。只能在同一输入 journal 内比较，不能跨 compact/归档文件混用位置。

只有源完整稳定、同任务锚点明确、相关格式/类型/事件身份可解释且存在后续原始投影事件，才报告 `behind`（`persisted_event_after_projection`）。合法连续派生的 verification.staled/review.staled/acceptance.ready 摘要与 task.reminder 不推进位置；时间戳不用于猜测先后。完全相同的重复事件保留首次位置，报告落后时可带 `duplicate_event`；同 ID 冲突或跨任务/Session 重用报告 `ambiguous_event_identity`。未知锚点、未知类型/格式、信息不足的旧记录、无法核对的派生摘要保持 unknown；晚于锚点的 review.reported 标记 `review_evidence_requires_check`，不调用专用补偿或推断验收通过。完整性失败时全部现存任务的结论降为 unknown，并带 `incomplete_or_changing_source`。

一致的任务不列入 diagnostics，但空数组不证明投影全部字段等价。当前事件的 auditState 不是完整任务快照，tool-facts-v1 也只保留关键事实和身份；诊断不会重建任务，不能把输出直接写回。

契约、已知限制与故障验证范围见[只读诊断方案](projection-recovery-diagnostic-proposal.md)。代表 CLI 场景的脱敏结果由调用者在隔离环境落盘；此命令自身不为预览创建日志或索引。

`complete=true` 仅表示源文件完整读取且未检测到变化，不代表任务可自动恢复。预览不是可直接写回的完整任务投影；Session 别名、字段演进、外部验收与合入证据必须人工核对。没有明确状态证据的任务保持未知，不能默认标记完成。

恢复前保留完整账本、事件、Session 登记/别名与 reconcile 日志备份，先在隔离副本核对候选。当前交付不自动恢复生产数据，也不提供覆盖现有任务的 apply 操作。旧 `recover-session-merge-tasks.mjs` 仅用于 Session 别名合并的历史特殊场景，会直接写入，不能当作通用恢复入口。

## 容量与回滚边界

保留完整 JSON 会增加账本读写量，创建事件的历史核对仍为线性扫描；有实际容量瓶颈时再评估完整事件索引或冷归档。当前摘要索引每任务仅保留 100 条，不用于恢复或永久去重判断。

数据格式兼容，无自动迁移。不能把已增长的账本直接交给仍含 500 条截断逻辑的旧版本继续写入。需要代码回退时应安排维护窗口，保留完整备份，并确保回退版本仍保留取消截断及禁止隐式移除的保护；不要将生产账本裁剪作为回滚办法。
