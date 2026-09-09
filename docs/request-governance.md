# 请求与上下文治理

本变更优先消除 L0 误拦截、请求超预算和默认巨型报告。治理计数不代表任务已经验收。

## Hook 与预算

- 已登记但无活动任务、任务关闭后的 Session 可以进行有界只读批处理。每批最多 32 段、命令文本最多 64 KiB，支持管道、`&&`、分号和换行；每一段分别检查。
- 保留引号中的正则；拒绝命令替换、重定向、后台运行及未支持的 shell 语法。`awk` 仅支持带简单条件的 `print`，不支持任意程序；`jq` 不加载外部程序文件。
- 完整、带引号定界符的 heredoc 是一次性输入。`cat` 的字面量 heredoc 可进入 L0；Python/Node/shell heredoc 是脚本执行，仍需活动任务。TTY 和显式交互选项仍被拒绝。Hook 不替代操作系统沙箱。
- `fast` 对应 L1：当前 Session 的当前阶段到第 8 次请求返回 `handoff_required`；其他 profile 为 35 次。同阶段重复 `started` 不重置预算。转入新 Session 后阶段预算重新计数，task 累计计数保留历史 Session。
- 从目标 Session JSONL 增量读取 `token_count`，相同累计用量通知去重；不把一次工具调用算作一次模型请求。第二次 `compacted/context_compacted` 后返回 `new_session_required`。缺失 Session 文件时返回 `source=unavailable` 和空计数，不将未知伪装为零。
- 到限后阻止实现和普通查询；确定性只读诊断、任务诊断报告、checkpoint 更新、验证报告、`task_close` 和 handoff 仍可用。checkpoint 只允许过程与证据字段，不能修改目标、合同或计划。
- 新 Hook 遇到旧服务的 prepare 404 时回退原门禁，不要求停机升级。新预算必须随已验证服务部署后才生效。

## 精简协议

`taskcenter_task_prepare(session_id)` 一次返回合同、当前绑定、Session/task/阶段请求计数、输入 Token 用量、压缩次数、handoff 与允许操作。输入 Token 硬额度没有配置时明确返回 `limit=null`。较大的合同使用响应游标，不默认展开。

`taskcenter_task_resume(session_id, task_id, expected_session_id)` 将同一目标恢复到已登记且 workspace 相同的新 Session，保留 task ID、合同、证据和 Session 历史。源绑定不匹配或目标 Session 已承担另一目标时拒绝。旧 Session 不能继续写该任务，也不能再创建新的独立任务。关闭后可补充、修复、验证原任务，但不能替换其目标；重新打开后仍保留此约束。

`taskcenter_usage_report` 支持以下参数：

| 参数 | 含义 |
| --- | --- |
| `project` | workspace 路径或项目 ID |
| `session` / `task` | 精确标识，可与 project 同时筛选 |
| `window` | `5h`、`24h`、`7d`、`lifetime` |
| `fields` | 返回的顶层字段数组：generatedAt、windows、lifetime、source、filters（须在当前窗口存在） |
| `top_n` | 明细分组按 count 降序，默认 10，最多 100 |
| `summary_only` | 默认 true，只返回汇总；false 才包含明细 |
| `cursor` | 显式读取之前截断结果的下一页 |

组合过滤在已有用量索引上筛选后重新聚合，不能把全局总数冒充过滤后的总数。索引保留最近 7 天事件及 lifetime 累计；归属仍标为 estimated。索引不可用时返回错误，不伪造空报告。

默认 MCP 文本响应上限为 4096 UTF-8 字节，超限返回摘要与 `continuation_cursor`。`taskcenter_response_continue` 读取其他响应或 prepare 合同的游标，usage_report 的游标也可传回 usage_report。分页为 `json_text_fragment`，按 offset 拼接后解析 JSON；不会自动续读。游标绑定五分钟的固定快照，过期或服务重启后重新发起原筛选查询。机器可读 handoff 上限为 2048 字节，大字段保留 task 引用。

普通任务推荐调用路径：登记 → 创建 → prepare（仅恢复时）→ 必要证据 → close。复用原子 close，不再为同一收尾结果依次 query/update/status/readiness/report/close。

## 部署后的真实观察验收

状态：**待部署、待采样；尚未取得十个真实新任务的验收证据。** 不创建虚假任务或循环调用来凑样本。

以本变更部署时间为起点，连续采集至少 10 个由新 Session 开始的真实任务，保留 task ID、Session ID、profile、阶段起止、prepare 计数、默认响应字节数与最终 Subject。记录完整序列，不筛掉失败或超限任务。

| 指标 | 验收 |
| --- | --- |
| L1 continuation | 每 Session ≤8 |
| 普通阶段 continuation | 每 Session 阶段 ≤35 |
| 主 Agent 显式 TaskCenter 调用 | 每任务 ≤10；Hook 内部 HTTP 往返单独记录 |
| 单次默认 MCP 文本 | ≤4096 字节 |
| Session 跨独立任务 | 0 |
| 二次压缩后继续实现 | 0；诊断、保存与交接单列 |
| 平均输入 Token | 与用户提供的 131600 基线比较，报告绝对值及下降比例；口径/样本不匹配时不宣称改善 |

现有 `taskCenterCallsPerTask` 统计的是账本事件，不等于真实 MCP 请求数，不能直接用来证明“≤10 次调用”。需以实际工具请求记录为证据，重复请求也计入。上下文中嵌套的调用若无法可靠识别，标为数据缺口。

全量自动化测试只证明边界行为，不替代这批真实任务观察；测试通过不等于已完成线上效果验收。
