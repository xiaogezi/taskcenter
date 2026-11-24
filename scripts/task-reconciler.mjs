// 轻量确定性对账器：读取实际运行事实与任务账本，识别不一致并执行允许的机械修复，
// 或生成明确的缺项。只对账，不重跑代码、不换模型、不因超时关闭任务、不伪造验收。
//
// 触发点：运行结束 / 回执到达时立即处理；服务启动时恢复未处理记录；低频扫描补漏。
// 日常只读查询不经过本模块，不会出现“打开任务页面就改变账本”的副作用。
import { evidenceFollowUp } from "../lib/task-workspace.mjs";
import { readFileSync, existsSync, appendFileSync, mkdirSync, openSync, closeSync, fstatSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { createHash } from "node:crypto";
import { taskReconcilePath } from "./task-ledger.mjs";
import { reconcileTasks, loadTasks, loadTaskById, recordTaskEvent, isContextShadowTask, taskSessionAgent, inactiveOwnerArchiveReady } from "./task-ledger.mjs";
import { inspectSessionStateAsync } from "./harnesses/codex-session.mjs";
import { computeCompletionReadiness, sameSubject } from "./completion-state.mjs";
import { isProcessTreeAlive } from "./process-tree.mjs";

const ACTIVE_TASK_STATUSES = new Set(["planned", "in_progress", "blocked"]);
const RECONCILABLE_TASK_STATUSES = new Set([...ACTIVE_TASK_STATUSES, "done_claimed", "verified", "cancelled"]);

function activeRuns(task) {
  return (task.runs || []).filter((run) => !run.ended_at);
}

// 计算单条任务的对账发现（只读，不写任务）。
function findingsForTask(task) {
  const followUp = evidenceFollowUp(task);
  const findings = followUp ? [{ ...followUp, task_id: task.id }] : [];
  const running = activeRuns(task);
  const hasRuns = (task.runs || []).length > 0;
  if (hasRuns && !running.length) {
    // 会话已脱离且任务仍处于活跃状态：运行已收口，执行状态待确认（不判定成功/失败/可接管）。
    if (task.sessionDetachedAt && ACTIVE_TASK_STATUSES.has(task.status)) {
      findings.push({
        code: "execution_unconfirmed",
        label: "执行状态待确认",
        detail: `会话于 ${task.sessionDetachedAt} 脱离，运行已收口；请确认是否继续或验收。`,
        task_id: task.id,
      });
    } else if (task.status === "in_progress") {
      // 任务声称执行中，但没有进行中的 Run 且未标记会话脱离：执行事实与账本不一致。
      findings.push({
        code: "execution_ended",
        label: "执行已结束未收尾",
        detail: "没有进行中的运行记录，且未收到结束事件；请核对执行事实。",
        task_id: task.id,
      });
    }
  }
  if (task.status === "done_claimed" && !task.currentSubject && !task.revision && !task.currentRevision) {
    findings.push({
      code: "delivery_missing",
      label: "待补交付记录",
      detail: "任务已声明完成，但没有交付版本（subject/revision）；请补充固定版本与交付声明。",
      task_id: task.id,
    });
  }
  return findings;
}

// 运行一次对账：收口脱离会话的运行（幂等），并生成缺项清单。
// 返回 { reconciled, findings, actions }；逐条让出事件循环，不阻塞控制请求。
function fingerprint(fields) {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

let reconciling = false;
export async function runReconciliation({ availableSessionIds = [], inspectSession = inspectSessionStateAsync, recordEvent = recordTaskEvent, maintenancePath = join(resolve(process.env.TASKCENTER_RUNTIME_DIR || join(import.meta.dirname, "../.local/runtime")), "ai-maintenance-state.json") } = {}) {
  if (reconciling) return { reconciled: [], findings: [], actions: [], notifications: [], observedAt: new Date().toISOString() };
  reconciling = true;
  try {
    const reconciled = reconcileTasks(availableSessionIds);
    const actions = [];
    const previous = lastReconciliation();
    const priorKeys = new Set(previous?.noticeKeys || []);
    const failures = [];
    const candidates = loadTasks().filter(task => !task.archivedAt && !isContextShadowTask(task) && RECONCILABLE_TASK_STATUSES.has(task.status)).map(task => task.id);
    for (const taskId of candidates) {
      await setImmediate();
      const task = loadTaskById(taskId);
      if (!task || task.archivedAt || !RECONCILABLE_TASK_STATUSES.has(task.status)) continue;
      // A live maintenance host owns execution just like any other client.
      try {
        const action = JSON.parse(readFileSync(maintenancePath, "utf8")).actions?.[task.id];
        if (action?.status === "running" && isProcessTreeAlive(action.pid)) continue;
      } catch (error) { if (error.code !== "ENOENT") continue; }
      // CLI Runs are owned by their host; the session reconciler cannot terminate them.
      if (task.cliRuns?.some(run => run.status === "active")) continue;
      const runs = task.runs || [], running = activeRuns(task);
      const startedAt = runs.at(-1)?.started_at || task.activeStartedAt || task.createdAt;
      let terminal = null, basis = "", sessionMissing = false, sessionReadFailed = false;
      if (running.length || !runs.length || taskSessionAgent(task) === "codex") {
        let session;
        // 已结束任务只判断会话缺失；无需重读历史内容推断执行结果。
        try {
          if (taskSessionAgent(task) === "codex" || inspectSession !== inspectSessionStateAsync)
            session = await inspectSession(task.sessionId, undefined, { presenceOnly: !ACTIVE_TASK_STATUSES.has(task.status) });
        }
        catch (error) { sessionReadFailed = true; sessionMissing = taskSessionAgent(task) === "codex" && error.code === "CODEX_SESSION_NOT_FOUND"; session = null; }
        // Session I/O yields; a concurrent task update invalidates the inspected snapshot.
        const current = loadTaskById(task.id);
        if (!current || current.lastEventId !== task.lastEventId) continue;
        if (session?.busy) continue;
        if (sessionMissing) basis = "session_missing";
        else if (session?.lastTerminal && Number.isFinite(Date.parse(startedAt))
          && Date.parse(session.lastTerminal.at) >= Date.parse(startedAt)) {
          terminal = session.lastTerminal;
          basis = `session:${task.sessionId}/turn:${terminal.turn_id}/${terminal.type}@${terminal.at}`;
        } else basis = !runs.length ? "legacy_run_missing" : running.length ? "session_end_unconfirmed" : task.executionReconciliation?.terminal?.at === runs.at(-1).ended_at ? task.executionReconciliation.basis : `run:${runs.at(-1).run_id}/${runs.at(-1).ended_reason}@${runs.at(-1).ended_at}`;
      } else basis = task.executionReconciliation?.terminal?.at === runs.at(-1).ended_at
        ? task.executionReconciliation.basis
        : `run:${runs.at(-1).run_id}/${runs.at(-1).ended_reason}@${runs.at(-1).ended_at}`;
      if (!ACTIVE_TASK_STATUSES.has(task.status) && !sessionMissing) continue;
      const inactiveOwner = !sessionMissing && !sessionReadFailed && inactiveOwnerArchiveReady(task, terminal);
      if (inactiveOwner) basis = "owner_inactive";
      const state = sessionMissing ? "recovery_pending" : terminal || (!running.length && runs.length) ? "execution_unconfirmed" : "recovery_pending";
      const archive = !ACTIVE_TASK_STATUSES.has(task.status) && !evidenceFollowUp(task) && (inactiveOwner || (sessionMissing && task.executionReconciliation?.basis === "session_missing" && Date.now() - Date.parse(task.updatedAt || task.createdAt) >= 300_000));
      const nextAction = evidenceFollowUp(task) ? "执行已收尾，待补证据仍保留在需处理；请补齐当前契约要求后再进行最终验收。" : ACTIVE_TASK_STATUSES.has(task.status) ? "执行是否结束尚待确认，任务保留在需处理；请核对宿主运行事实，在原契约内收尾或恢复，也可由人工明确处置。" : archive ? "原执行承载已失效且无活跃执行者，任务已自动归档；契约、证据及未完成状态保留，需要继续时先取消归档并绑定真实 Session。" : sessionMissing ? "原会话文件缺失，等待五分钟静默核对；无活跃执行者时默认归档，保留契约、证据及未完成状态。" : "在原契约内核对当前交付证据；未完成时由宿主恢复原任务继续执行，权限缺口仅暂停相关动作。";
      const id = `reconcile-${fingerprint([task.id, task.sessionId, startedAt, basis, task.currentSubject, task.contractRevision, task.executionReconciliation?.event_id, terminal, nextAction, archive ? task.lastEventId : ""])}`;
      const completion = computeCompletionReadiness({ ...task, status: "done_claimed" });
      const fresh = [...(task.requirementResults || []), ...(task.verificationClaims || [])]
        .filter(item => item.status === "passed" || item.status === "not_applicable")
        .every(item => Date.parse(item.checked_at || item.observed_at) >= Date.parse(startedAt)
          && sameSubject(item.subject_ref, task.currentSubject));
      const completedRun = terminal?.type === "task_complete" || (!running.length && runs.at(-1)?.ended_reason === "completed");
      try {
        if (!archive && !sessionMissing && completedRun && task.currentSubject?.type !== "none" && task.currentSubject && task.evidence?.length && fresh && completion.completionClaim.allowed) {
          const result = recordEvent({ type: "task.close", event_id: `${id}-close`, task_id: task.id, session_id: task.sessionId, status: "done_claimed", subject_ref: task.currentSubject, tests: task.tests || [], evidence: task.evidence, current_step: "自动对账：当前版本交付证据满足契约，补齐完成声明", next_action: "由独立授权主体验收；自动对账不代替验收。" });
          if (!result.idempotent) actions.push({ event_id: result.event.event_id, task_id: task.id, action: "delivery_reconciled", status: "succeeded", basis });
        } else if (archive || task.executionReconciliation?.basis !== basis) {
          const result = recordEvent({ type: "task.execution_reconciled", event_id: id, task_id: task.id, session_id: task.sessionId, ...(archive ? { archived_at: new Date().toISOString() } : {}), execution_observation: { state, basis, terminal, next_action: nextAction } }, { internalReconciliation: true });
          if (!result.idempotent) actions.push({ event_id: result.event.event_id, task_id: task.id, action: archive ? "orphan_archived" : state, status: "succeeded", basis });
        }
      } catch (error) {
        const key = fingerprint([task.id, id, error.message]);
        failures.push({ task_id: task.id, code: "reconciliation_failed", label: "对账失败", detail: error.message, key });
        if (!priorKeys.has(key)) actions.push({ task_id: task.id, action: state, status: "failed", basis, error: error.message });
      }
      const action = actions.at(-1);
      if (action?.task_id === task.id) {
        mkdirSync(dirname(taskReconcilePath), { recursive: true });
        appendFileSync(taskReconcilePath, `${JSON.stringify({ type: "reconciliation.action", observedAt: new Date().toISOString(), actions: [action] })}\n`, { mode: 0o600 });
      }
    }
    const findings = loadTasks().filter(task => !task.archivedAt).flatMap(task =>
      findingsForTask(task).map(finding => ({ ...finding, key: fingerprint([
        task.id, task.sessionId, task.contractRevision, task.currentSubject, finding,
        task.requirementResults, task.verificationClaims,
      ]) })));
    findings.push(...failures);
    const noticeKeys = findings.map(item => item.key);
    const notifications = findings.filter(item => !priorKeys.has(item.key));
    const now = new Date().toISOString();
    if (reconciled.length || actions.length || notifications.length || noticeKeys.length !== priorKeys.size) {
      mkdirSync(dirname(taskReconcilePath), { recursive: true });
      appendFileSync(taskReconcilePath, `${JSON.stringify({
        type: "reconciliation.run",
        observedAt: now,
        reconciled: reconciled.map((task) => ({ id: task.id, sessionId: task.sessionId })),
        noticeKeys, failures, findings: notifications,
      })}\n`, { mode: 0o600 });
    }
    return { reconciled, findings, actions, notifications, observedAt: now };
  } finally { reconciling = false; }
}

// 纯查询：当前账本的对账发现（不写任何文件）。
export function queryFindings() {
  return loadTasks()
    .filter((task) => !task.archivedAt)
    .flatMap((task) => findingsForTask(task));
}

export function lastReconciliation() {
  if (!existsSync(taskReconcilePath)) return null;
  const descriptor = openSync(taskReconcilePath, "r");
  try {
    let position = fstatSync(descriptor).size;
    let suffix = Buffer.alloc(0), oversized = false;
    const chunk = Buffer.allocUnsafe(64 * 1024);
    while (position > 0) {
      const length = Math.min(position, chunk.length);
      position -= length;
      const count = readSync(descriptor, chunk, 0, length, position);
      const block = Buffer.concat([chunk.subarray(0, count), suffix]);
      let end = block.length;
      for (let index = block.length - 1; index >= -1; index--) {
        if (index === -1 && position > 0) break;
        if (index >= 0 && block[index] !== 10) continue;
        if (!oversized) try {
          const record = JSON.parse(block.subarray(index + 1, end).toString("utf8"));
          if (record?.type === "reconciliation.run") return record;
        } catch { /* Ignore corrupt audit rows and continue backwards. */ }
        oversized = false;
        end = index;
      }
      // Match the JSONL reader's 2 MiB row budget; audit history itself is never truncated.
      oversized ||= end > 2 * 1024 * 1024;
      suffix = oversized ? Buffer.alloc(0) : Buffer.from(block.subarray(0, end));
    }
  } finally { closeSync(descriptor); }
  return null;
}
