# SQLite 互斥锁的离线协议迁移

本次升级将启动器锁和复用决策写入锁改为 `node:sqlite` 的 `BEGIN IMMEDIATE` 事务。持锁期间连接保持打开；正常释放回滚事务并关闭连接，进程崩溃时由操作系统释放 SQLite 文件锁。不会根据 PID、时间戳或二次检查删除共享锁路径，也不删除 mutex 数据库。需要项目要求的 Node 22.13+ 和可靠的本地文件系统锁，不支持网络共享文件系统。

## 必须先安排一次离线升级

**未初始化的新协议默认拒绝受保护操作，包含首次安装。迁移不是普通在线 `service:deploy` 的替代，也不会自动停止健康实例。**

旧版本并不认识 SQLite 锁；它的 stale-lock 删除逻辑无法被新版本安全兼容。保留一个旧锁“桥”也不能阻止已经读到旧 owner 的进程删除新桥。因此不能混跑协议版本，不能把 `--offline-confirmed` 当作旧进程已停止的证明。

操作人需自行安排维护窗口：

1. 在旧版本仍可运行时，按既有明确停机授权流程停止服务，以及所有启动器、自动重启器、复用决策写者和会使用同一数据目录的旧进程。保留数据备份，确保它们不会自动重启。
2. 核对实际 `TASKCENTER_RUNTIME_DIR` 与 `TASKCENTER_TASK_REUSE_DECISIONS_PATH`。每个不同的运行/数据目录均需初始化；候选或测试目录也是独立目标。
3. 仅在确认离线后检查旧 `launcher.lock` 与 `<decisions>.lock`。如果仍存在，核对所有者和数据后由操作人处置；迁移工具不自动清理，连断开的符号链接也拒绝。
4. 使用新版本，在同样的环境路径下执行：

   ```sh
   node scripts/migrate-locks.mjs --offline-confirmed
   ```

   可用 `--target launcher` 或 `--target reuse` 分别处理。两个目标不构成一个原子事务；部分成功会输出已完成目标，保持离线、修正另一目标后可重复初始化。没有参数时不会迁移。
5. 在**包含本次能力声明的、已提交且干净的新版本工作区**中，保持所有旧写者离线，再执行：

   ```sh
   node scripts/taskcenter-control.mjs start --offline-upgrade --offline-confirmed
   ```

   两个参数必须一起使用且仅允许 `start`。此路径不采用旧 `active-release.json`，而是对当前 HEAD 执行原有 lint/test/工作区干净门禁，创建不可变 release，构建并验证隔离候选，最后才启动正式服务；健康后更新 active。这是真正的离线首次升级入口，不需要先让新版服务运行，也不需要手动删除旧 active 文件。所有这些命令由操作人安排执行，本次修复未运行。

   正式 service 固定使用当前控制器项目下 `data/task-reuse-decisions.jsonl`；运行前必须初始化这一路径，以及同一个 `TASKCENTER_RUNTIME_DIR`。若第 4 步给独立 CLI 设置过 `TASKCENTER_TASK_REUSE_DECISIONS_PATH`，请在清除此覆盖变量后对正式路径再执行 `--target reuse`，不要误把另一套数据目录的锁当作已迁移。

   升级会拒绝仍存活的受管理进程/子进程、启动意图或占用端口，不会自动停止健康服务。这些检查不能证明没有独立 CLI 写者。残留启动意图须由操作人离线确认对应进程不存在后处理。失败不会自动启动旧协议 release；保留离线状态排障后重试同一路径。若正式新服务已部分启动，先按新版本停机流程确认全部新进程停止再重试。
6. 只启用支持新协议的版本。正常启动不会隐式迁移。不得在任何进程持锁时删除、替换或搬迁 `.mutex.sqlite` 及其 journal 文件。

新协议数据库分别为 `<runtime>/launcher.mutex.sqlite` 与 `<decisions>.mutex.sqlite`。初始化并不证明环境没有旧进程，代码也不能防止旧程序以后重新启动；禁止混跑是本次迁移的必要操作前提。新代码发现旧锁路径仍存在会拒绝进入，但这不是对任意旧程序的互斥保证。

## 崩溃与回滚

迁移后的新版本崩溃不需要重新确认离线或手工删除数据库；下一持有者由 SQLite 获取事务锁。锁忙时有界等待后报错，不删除正在使用或身份未知的文件。

回滚到使用旧文件锁的版本不是在线回滚：必须重新安排离线窗口，停止所有新版本写者，再恢复与旧版本兼容的服务/数据状态；绝不能让旧启动器和新启动器并行。通常优先回滚到同样支持 SQLite 锁的修复版本。此升级未自动执行停机、迁移或回滚。

## 验收重点（本次未执行）

- 未迁移、旧锁存在（含断链）、迁移无确认时拒绝且不删数据。
- 多进程竞争时仅一个进入临界区；持有者强杀后下一新版本进程可取得锁。
- 两处业务锁均采用同一协议，超时不抢锁；临界区异常后正常释放。
- 独立 macOS、Linux、Windows 环境及受控发布/恢复流程的人工验证。

依据：[SQLite 事务说明](https://www.sqlite.org/lang_transaction.html)。代码设计不等于验证通过。

## Release 能力和候选隔离

源版本的 `config/runtime-capabilities.json` 必须同时声明 launcher/reuse 的 `taskcenter-sqlite-mutex-v1`，构建时复制至 release marker。启动与回滚同时核对源声明、marker 与 revision；缺失声明的旧 release 保守拒绝，不能通过新控制器给旧源码补贴能力。正常 start 即使健康端口有响应，也核对受管理实例的 sourceRoot/revision 与已检查的 release 一致。在线 deploy 对当前版本、候选和回滚版本均检查兼容性，在停止原服务前阻止旧协议回滚。

离线升级不会修改或删除旧 active 作为绕过方式；普通 start 仍拒绝选择旧协议 active。禁止用编辑能力 JSON/marker 的方式绕过拒绝，它们是防误操作的版本声明，不是针对恶意篡改源码的安全签名。旧控制器不认识这些新门禁，因此仍必须退役旧入口、定时任务与自动重启器。

每个新建、从未启动的隔离 candidate 和 production verification fixture 显式初始化自己的 SQLite mutex；这一操作只针对空白临时环境，绝不借候选验证隐式迁移正式 runtime/data。正式路径未初始化则启动拒绝，不自动创建协议。
