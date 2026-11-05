# 本地事件存储与日志保留

格子于 2026-11-05 选择完整方案：运行日志约 100 MB；工具明细 30 天且约 200 MB；保留关键事实、建立完整 SQLite 索引，旧账本只读归档。本次实现属于该选择，不改变任务契约、授权或独立验收。

## 日志

- Pino 10.4.0 负责结构化记录，rotating-file-stream 3.2.10 负责异步写入与持续轮转；均为 MIT。监督进程单独持有文件，子进程通过管道写入，原有退出自动恢复不变。
- `.local/logs/runtime/runtime.log` 为当前文件，最多另留 7 个约 10 MiB 文件。加上现有最多两个约 10 MiB 的 `web.log` 启动诊断文件，总计约 100 MiB。单条写入不拆文件，因此可能超过阈值一条记录；历史大文件不会由本次启动批量删除。
- 单行最多 16 Ki 字符；写入队列最多约 1 MiB。超过时丢弃运行诊断并记录固定告警与恢复后的丢弃字节数，避免日志洪峰拖住控制面；它不承载权威任务事实。正常退出排空日志，进程崩溃或断电仍可能丢失尚未写出的运行诊断。
- 结构化子进程记录位于 `data`，外层保留 source、stream、revision、time，子进程不能覆盖外层身份。常见凭据字段遮蔽；不增加原始会话、命令参数或正文采集。
- 原拟采用的 pino-roll 4.0.0 因 date-fns 导致依赖体积超过现有固定预算，已换用零传递依赖的轮转器，没有调高预算。
- 生产仅运行现有 Rolldown 构建的 `dist/runtime/logger.cjs`，Pino、轮转器和构建器作为开发依赖，不在 production 中保留完整测试/文档安装树。产物与第三方许可证随整个 dist 参与构建指纹及完整 release 体积校验；不排除计量。只暴露固定的监督日志入口，不支持动态 Pino transport/worker 插件。源码测试与移除开发依赖后的生产栈分别验证。
- 安全核对必须同时检查完整 lockfile 审计；`npm audit --omit=dev` 单独不能覆盖已经打包进产物的日志依赖。本次完整审计没有新增日志组件漏洞。

## 事实、明细与完整索引

`TASKCENTER_TASK_EVENTS_PATH` 定位 JSONL 关键事实文件。其相邻 `.sqlite` 是可重建的完整索引，`.storage.json` 是版本与归档清单。生产与候选由 `buildReleaseEnvironment` 分别绑定数据目录；旧测试启动显式保留传入的隔离路径。

- 普通任务、合同、完成、验收、切换、恢复事件原样保留。工具事件保留事件/任务/Session 身份、时间、actor、全部任务变更事实、实际状态变化与 SHA-256 重放摘要。未改变的前后状态快照不重复保存。
- tool_name、tool_use_id、agent/provider/model、工作区/项目/Git 归属等工具诊断明细及规范化空字段保存在独立 SQLite 明细表：按记录时间保留 30 天，再按从旧到新缩至 200 MiB。身份和摘要不受这两个上限影响，不因明细过期允许重复副作用。
- 明细存在时任务活动接口返回完整记录；过期后仅返回关键事实与 `storage_format=tool-facts-v1`、`storage_fingerprint`。这不是恢复已过期的原始工具明细。SQLite 计数是完整历史，不是原先 24 小时/每任务 100 条的展示缓存。
- 200 MiB 限制针对明细载荷字节，非整个 SQLite 文件。关键事实、B-tree、页开销、WAL 及安全归档另计；不能把它宣传成全部数据目录 200 MiB。写入时执行载荷上限，监督进程每分钟执行过期清理和最多 256 页增量回收，避免一次大回收占住前台写锁。首次预建可使用完整 VACUUM。
- 关键事实文件和完整身份索引随真实任务历史增长；它们按契约永久保留。一次性原始归档也保留，因此迁移后总磁盘占用可能增加，收益是活动明细有界、控制面不再反复扫全历史。后续关键事实分层归档需另行决策，不静默删除。

## 迁移、崩溃与回滚

1. 验证、提交并创建隔离候选后，受控部署在旧实例保持健康时预建索引和紧凑事实文件。准备文件绑定实现摘要、原 inode、完整前缀 SHA-256、事件计数与偏移。
2. 停止旧实例后的启动只核对完整前缀并导入切换增量；源文件发生替换、截断或前缀变化时拒绝激活。原文件重命名为 `task-events.jsonl.<摘要>.archive.jsonl`，设置 `0400`，不删除、不开放其他用户读取。
3. 准备、归档、事实文件替换、数据库替换任一边界中断可按持久清单接续。清单与激活标记通过 fsync 和原子替换发布。未完成切换而需回滚时，先从只读归档恢复可写原文件，再启动旧 release。
4. JSONL 仍包含完整关键事实及工具身份，旧恢复预览、Session 合并修复与只观察新事件的 Jev tail 继续读取同一路径。旧 release 不识别过期工具摘要；遇到旧缓存命中的紧凑工具事件可能拒绝重放，不能据此恢复已过期明细或重复执行。任务创建、切换及验收事实不受明细清理影响。
5. 新写入先 fsync JSONL，再提交 WAL 索引，最后沿用原投影更新。崩溃留下的已写事实可补入索引；索引损坏或来源不完整时拒绝把“没查到”作为不存在的证明。持久事件领先任务投影时返回恢复提示，不盲目重放 POST 或静默宣布更新完成。

SQLite 仅用于本机，`busy_timeout=1500`，写入串行；WAL 允许读写并行，但不保证任意负载都无等待。原 HTTP 预算与授权检查未放宽。

## 验证与观察

测试：`tests/task-event-store.test.mjs`、`tests/runtime-logger.test.mjs`，以及现有 task/history、Session switch、生命周期和完整回归。

查询 `.local/logs/runtime/runtime*.log` 中 `data.event`：`task_tool_retention` 给出 deleted、detail_bytes、max_bytes、retention_days、elapsed_ms；`control_request_slow` 仍给出脱敏 request_id、endpoint、elapsed_ms。首次迁移的 `task_event_storage_migrated` 位于启动日志 `web.log`，含版本、事件计数、源与紧凑文件字节。运行诊断并非任务验收证据本身，应结合对应 revision 的测试和实际入口结果。

官方来源：

- [Pino 及其传输文档](https://github.com/pinojs/pino/blob/main/docs/transports.md)
- [rotating-file-stream API、轮转及限制](https://github.com/iccicci/rotating-file-stream)
- [Node 22.13.0 内置 SQLite](https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html)
- [SQLite WAL 的并发与限制](https://sqlite.org/wal.html)
