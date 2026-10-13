// 轻量确定性对账器：读取实际运行事实与任务账本，识别不一致并执行允许的机械修复，
// 或生成明确的缺项。只对账，不重跑代码、不换模型、不因超时关闭任务、不伪造验收。
//
// 触发点：运行结束 / 回执到达时立即处理；服务启动时恢复未处理记录；低频扫描补漏。
// 日常只读查询不经过本模块，不会出现“打开任务页面就改变账本”的副作用。
import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { createHash } from "node:crypto";
import { taskReconcilePath } from "./task-ledger.mjs";
import { reconcileTasks, loadTasks, recordTaskEvent, isContextShadowTask } from "./task-ledger.mjs";
import { inspectSessionStateAsync } from "./harnesses/codex-session.mjs";
import { computeCompletionReadiness, sameSubject } from "./completion-state.mjs";
import { isProcessTreeAlive } from "./process-tree.mjs";

const ACTIVE_TASK_STATUSES = new Set(["planned", "in_progress", "blocked"]);

function activeRuns(task) {
  return (task.runs || []).filter((run) => !run.ended_at);
}

// 计算单条任务的对账发现（只读，不写任务）。
function findingsForTask(task) {
  const findings = [];
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
let reconciling = false;
export async function runReconciliation({ availableSessionIds = [], inspectSession = inspectSessionStateAsync, maintenancePath = join(resolve(process.env.TASKCENTER_RUNTIME_DIR || join(import.meta.dirname, "../.local/runtime")), "ai-maintenance-state.json") } = {}) {
  if (reconciling) return { reconciled: [], findings: [], actions: [], observedAt: new Date().toISOString() };
  reconciling = true;
  try {
    const reconciled = reconcileTasks(availableSessionIds);
    const actions = [];
    const candidates = loadTasks().filter(task => !task.archivedAt && !isContextShadowTask(task) && ACTIVE_TASK_STATUSES.has(task.status)).map(task => task.id);
    for (const taskId of candidates) {
      await setImmediate();
      const task = loadTasks().find(task => task.id === taskId);
      if (!task || task.archivedAt || !ACTIVE_TASK_STATUSES.has(task.status)) continue;
      // A live maintenance host owns execution just like any other client.
      try {
        const action = JSON.parse(readFileSync(maintenancePath, "utf8")).actions?.[task.id];
        if (action?.status === "running" && isProcessTreeAlive(action.pid)) continue;
      } catch (error) { if (error.code !== "ENOENT") continue; }
      // CLI Runs are owned by their host; the session reconciler cannot terminate them.
      if (task.cliRuns?.some(run => run.status === "active")) continue;
      const runs = task.runs || [], running = activeRuns(task);
      const startedAt = runs.at(-1)?.started_at || task.activeStartedAt || task.createdAt;
      let terminal = null, basis = "";
      if (running.length || !runs.length) {
        let session;
        try { session = await inspectSession(task.sessionId); } catch { session = null; }
        // Session I/O yields; a concurrent task update invalidates the inspected snapshot.
        const current = loadTasks().find(item => item.id === task.id);
        if (!current || current.lastEventId !== task.lastEventId) continue;
        if (session?.busy) continue;
        if (session?.lastTerminal && Number.isFinite(Date.parse(startedAt))
          && Date.parse(session.lastTerminal.at) >= Date.parse(startedAt)) {
          terminal = session.lastTerminal;
          basis = `session:${task.sessionId}/turn:${terminal.turn_id}/${terminal.type}@${terminal.at}`;
        } else basis = !runs.length ? "legacy_run_missing" : "session_end_unconfirmed";
      } else basis = task.executionReconciliation?.terminal?.at === runs.at(-1).ended_at
        ? task.executionReconciliation.basis
        : `run:${runs.at(-1).run_id}/${runs.at(-1).ended_reason}@${runs.at(-1).ended_at}`;
      const state = terminal || (!running.length && runs.length) ? "execution_unconfirmed" : "recovery_pending";
      const nextAction = "在原契约内核对当前交付证据；未完成时由宿主恢复原任务继续执行，权限缺口仅暂停相关动作。";
      const id = `reconcile-${createHash("sha256").update(JSON.stringify([task.id, startedAt, basis, task.currentSubject])).digest("hex")}`;
      const completion = computeCompletionReadiness({ ...task, status: "done_claimed" });
      const fresh = [...(task.requirementResults || []), ...(task.verificationClaims || [])]
        .filter(item => item.status === "passed" || item.status === "not_applicable")
        .every(item => Date.parse(item.checked_at || item.observed_at) >= Date.parse(startedAt)
          && sameSubject(item.subject_ref, task.currentSubject));
      const completedRun = terminal?.type === "task_complete" || (!running.length && runs.at(-1)?.ended_reason === "completed");
      try {
        if (completedRun && task.currentSubject?.type !== "none" && task.currentSubject && task.evidence?.length && fresh && completion.completionClaim.allowed) {
          const result = recordTaskEvent({ type: "task.close", event_id: `${id}-close`, task_id: task.id, session_id: task.sessionId, status: "done_claimed", subject_ref: task.currentSubject, tests: task.tests || [], evidence: task.evidence, current_step: "自动对账：当前版本交付证据满足契约，补齐完成声明", next_action: "由独立授权主体验收；自动对账不代替验收。" });
          if (!result.idempotent) actions.push({ event_id: result.event.event_id, task_id: task.id, action: "delivery_reconciled", status: "succeeded", basis });
        } else if (task.executionReconciliation?.basis !== basis) {
          const result = recordTaskEvent({ type: "task.execution_reconciled", event_id: id, task_id: task.id, session_id: task.sessionId, execution_observation: { state, basis, terminal, next_action: nextAction } }, { internalReconciliation: true });
          if (!result.idempotent) actions.push({ event_id: result.event.event_id, task_id: task.id, action: state, status: "succeeded", basis });
        }
      } catch (error) {
        actions.push({ task_id: task.id, action: state, status: "failed", basis, error: error.message });
      }
      const action = actions.at(-1);
      if (action?.task_id === task.id) {
        mkdirSync(dirname(taskReconcilePath), { recursive: true });
        appendFileSync(taskReconcilePath, `${JSON.stringify({ type: "reconciliation.action", observedAt: new Date().toISOString(), actions: [action] })}\n`, { mode: 0o600 });
      }
    }
    const findings = loadTasks()
      .filter((task) => !task.archivedAt)
      .flatMap((task) => findingsForTask(task));
    const now = new Date().toISOString();
    if (reconciled.length || actions.length) {
      mkdirSync(dirname(taskReconcilePath), { recursive: true });
      appendFileSync(taskReconcilePath, `${JSON.stringify({
        type: "reconciliation.run",
        observedAt: now,
        reconciled: reconciled.map((task) => ({ id: task.id, sessionId: task.sessionId })),
        findings,
      })}\n`, { mode: 0o600 });
    }
    return { reconciled, findings, actions, observedAt: now };
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
  const lines = readFileSync(taskReconcilePath, "utf8").split("\n").filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const record = JSON.parse(lines[index]);
      if (record.type === "reconciliation.run") return record;
    } catch {
      // 忽略损坏行继续向前找。
    }
  }
  return null;
}
