# 跨客户端共享任务接手

## 决策与范围

采用方案 A：复用 `taskcenter_task_resume`，让已启动的 Codex、Claude、Kimi 或其他已接入客户端接手同一任务。不增加调度器，不自动启动客户端。任务不归创建它的产品独占，任一时刻只有一个主执行 Session。

## 调用顺序

1. 原执行者在可恢复检查点停止操作，记录下一步；结束或撤销仍有效的 delegation。
2. 接手客户端使用自己的真实 Session ID，在任务的同一 workspace 登记。不要复用原 Session ID 或自拟前缀。
3. 用 `taskcenter_task_query({task_id})` 读取合同、当前 `sessionId`、Subject、证据和下一步。
4. 调用 `taskcenter_task_resume({session_id: 当前真实Session, task_id, expected_session_id: 查询得到的sessionId})`。成功返回该任务的 prepare 结果，再开始执行。
5. 使用 Context 的客户端先 attach，再用 `execution_task_id` 关联这个 TaskCenter task；不要为同一交付另建 TaskCenter task。继续正常 prepare_turn、commit_turn 和 task_close。

接手后的任务 ID 不变。`ownerActor` 保持兼容，`creatorActor` 记录原创建者；`executorActor` 和 `sessionId` 表示当前执行者；`handoffs` 按事件记录双方 Session、客户端和时间。普通更新不会把创建者改成接手人。合同、Subject 和原证据保留；后续代码变化仍按现有新鲜度规则使证据过期。

## 冲突与边界

- workspace 必须完全一致；跨 worktree 搬移不在本方案范围。
- 目标 Session 已有其他活跃任务、原任务有未过期的 issued/active delegation 时拒绝接手。先正常结束相应工作或撤销委派，再重试。
- 两个不同目标用同一个旧绑定抢接，只有一个成功；另一方收到 `SESSION_BINDING_CHANGED`，必须重新读取状态。当前绑定检查不提供跨多次换手的版本锁。
- 已接手 Session 重复调用不追加交接记录；已完成任务会重新进入 `in_progress`。取消或移除任务不能接手。
- 旧 Session 后续 Hook 写入和普通任务更新被拒绝，包括伪造 `manual-` 事件前缀。接手不会杀死已运行的 shell/客户端，因此原执行者必须先停止操作；这是本地协作门禁，不是进程隔离。
- 历史账本不批量迁移。新字段在事件应用时逐步补充；缺少字段的旧任务仍使用既有 `ownerActor`、`sessionId`、`sessionHistory` 和事件记录，不能把缺失交接明细解释为从未交接。

## 验证与回滚

`node --test --test-name-pattern='跨客户端共享|共享任务阻止' tests/hook.test.mjs` 使用隔离控制服务验证六个方向的接手、证据保留、旧身份拒绝、并发冲突及委派阻止。实际客户端端到端验收另行执行，不以模拟 Hook 验证替代。

无新依赖或独立存储。回滚使用上一已验证 release，停止新的跨客户端接手；新增账本字段为兼容字段，不需要删除历史事件。旧版本不具有本次补齐的委派冲突检查及手动前缀防绕过。
