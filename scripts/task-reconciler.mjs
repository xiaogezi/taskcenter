// 轻量确定性对账器：读取实际运行事实与任务账本，识别不一致并执行允许的机械修复，
// 或生成明确的缺项。只对账，不重跑代码、不换模型、不因超时关闭任务、不伪造验收。
//
// 触发点：运行结束 / 回执到达时立即处理；服务启动时恢复未处理记录；低频扫描补漏。
// 日常只读查询不经过本模块，不会出现“打开任务页面就改变账本”的副作用。
import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { taskReconcilePath } from "./task-ledger.mjs";
import { reconcileTasks, loadTasks } from "./task-ledger.mjs";

const ACTIVE_TASK_STATUSES = new Set(["planned", "in_progress", "blocked"]);
const CONFIRMED_STATUSES = new Set(["done_claimed", "verified", "cancelled"]);

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
// 返回 { reconciled, findings }；reconciled 为本次被收口运行的任务。
export function runReconciliation({ availableSessionIds = [] } = {}) {
  const reconciled = reconcileTasks(availableSessionIds);
  const findings = loadTasks()
    .filter((task) => !task.archivedAt)
    .flatMap((task) => findingsForTask(task));
  const now = new Date().toISOString();
  if (reconciled.length || findings.length) {
    mkdirSync(dirname(taskReconcilePath), { recursive: true });
    appendFileSync(taskReconcilePath, `${JSON.stringify({
      type: "reconciliation.run",
      observedAt: now,
      reconciled: reconciled.map((task) => ({ id: task.id, sessionId: task.sessionId })),
      findings,
    })}\n`, { mode: 0o600 });
  }
  return { reconciled, findings, observedAt: now };
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
