import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { buildGovernanceMetrics } from "./governance-metrics.mjs";
import { delegationsPath, listDelegations } from "./delegation-store.mjs";
import { loadVisibleTasks, taskEventsPath, taskLedgerPath } from "./task-ledger.mjs";
import { updateTaskEventIndex } from "./task-event-index.mjs";
import { updateUsageIndex, writeJsonAtomic } from "./usage-index.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const runtimeDir = resolve(process.env.TASKCENTER_RUNTIME_DIR || join(projectRoot, ".local", "runtime"));
const sessionsRoot = resolve(process.env.TASKCENTER_SESSIONS_ROOT || join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions"));
const modelRatesPath = resolve(process.env.TASKCENTER_MODEL_RATES_PATH || join(projectRoot, "config", "model-rates.json"));
const usageIndexPath = resolve(process.env.TASKCENTER_USAGE_INDEX_PATH || join(runtimeDir, "usage-index.json"));
const usageReportPath = resolve(process.env.TASKCENTER_USAGE_REPORT_PATH || join(runtimeDir, "usage-report.json"));
const taskEventIndexPath = resolve(process.env.TASKCENTER_TASK_EVENT_INDEX_PATH || join(runtimeDir, "task-event-index.json"));
const governanceMetricsPath = resolve(process.env.TASKCENTER_GOVERNANCE_METRICS_PATH || join(runtimeDir, "governance-metrics.json"));
const usageHealthPath = resolve(process.env.TASKCENTER_USAGE_HEALTH_PATH || join(runtimeDir, "usage-worker-health.json"));
const governanceHealthPath = resolve(process.env.TASKCENTER_GOVERNANCE_HEALTH_PATH || join(runtimeDir, "governance-worker-health.json"));

let refreshingUsage = false;
let refreshingGovernance = false;

async function refreshUsage() {
  if (refreshingUsage) return;
  refreshingUsage = true;
  try {
    const { report, index } = await updateUsageIndex({
      sessionsRoot,
      indexPath: usageIndexPath,
      ledger: usageTasks(),
      rates: modelRatesPath,
    });
    await writeJsonAtomic(usageReportPath, {
      ...report,
      source: {
        mode: "incremental_jsonl",
        indexedFiles: Object.keys(index.files || {}).length,
        skippedOversizedLines: Object.values(index.files || {}).reduce((sum, item) => sum + Number(item.skippedOversizedLines || 0), 0),
      },
    });
    await writeWorkerHealth(usageHealthPath, "usage", true);
  } catch (error) {
    console.error(`[metrics-worker] usage refresh failed: ${safeError(error)}`);
    await writeWorkerHealth(usageHealthPath, "usage", false, safeError(error));
  } finally {
    refreshingUsage = false;
    globalThis.gc?.();
  }
}

function usageTasks() {
  const cliRunsByTask = new Map();
  for (const delegation of listDelegations()) {
    const runs = cliRunsByTask.get(delegation.taskId) || [];
    runs.push(delegation);
    cliRunsByTask.set(delegation.taskId, runs);
  }
  return loadVisibleTasks().map((task) => ({ ...task, cliRuns: cliRunsByTask.get(task.id) || [] }));
}

async function refreshGovernance() {
  if (refreshingGovernance) return;
  refreshingGovernance = true;
  try {
    const index = await updateTaskEventIndex({ sourcePath: taskEventsPath, indexPath: taskEventIndexPath });
    const tasks = loadVisibleTasks();
    const delegationEvents = listDelegations().flatMap((delegation) =>
      (delegation.events || []).map((event) => ({ ...event, task_id: delegation.taskId })));
    const usageReport = readJson(usageReportPath, emptyUsageReport());
    await writeJsonAtomic(governanceMetricsPath, {
      ...buildGovernanceMetrics({ tasks, events: [...(index.events || []), ...delegationEvents], usageReport }),
      generatedAt: new Date().toISOString(),
      source: { mode: "incremental_snapshot", taskEventOffset: index.offset, delegationStore: delegationsPath },
    });
    await writeWorkerHealth(governanceHealthPath, "governance", true);
  } catch (error) {
    console.error(`[metrics-worker] governance refresh failed: ${safeError(error)}`);
    await writeWorkerHealth(governanceHealthPath, "governance", false, safeError(error));
  } finally {
    refreshingGovernance = false;
    globalThis.gc?.();
  }
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function emptyUsageReport(now = Date.now()) {
  const generatedAt = new Date(now).toISOString();
  const window = (id, durationMs) => ({ id, durationMs, generatedAt, byModel: [], byProject: [], bySession: [], byTask: [], totals: { usage: { input: 0, cachedInput: 0, output: 0 }, statistics: { average: null, p50: null, p95: null }, cost: null, unestimable: false, costEstimation: "unestimable" }, modelContinuations: 0 });
  return { generatedAt, windows: { "5h": window("5h", 18_000_000), "24h": window("24h", 86_400_000), "7d": window("7d", 604_800_000) }, lifetime: { attribution: "estimated", method: "last_token_usage_by_task_lifecycle", byTask: [], totals: { id: "all", usage: { input: 0, cachedInput: 0, output: 0, reasoning: 0 }, totalTokens: 0, count: 0, attribution: "estimated" }, attributedTokenRatio: 0, missingTimestampEvents: 0 }, warnings: [], alerts: [], overall: { estimatedCredits: null, creditsEstimation: "unestimable", modelContinuations: 0, input: { average: null, p50: null, p95: null }, usage: { input: 0, cachedInput: 0, output: 0 } } };
}

function safeError(error) { return error instanceof Error ? error.message : String(error); }
async function writeWorkerHealth(path, kind, ok, lastRefreshError = "") {
  try {
    const now = new Date().toISOString();
    const previous = readJson(path, {});
    await writeJsonAtomic(path, {
      ...previous,
      kind,
      ok,
      refreshOk: ok,
      heartbeatAt: now,
      lastAttemptAt: now,
      lastSuccessAt: ok ? now : (previous.lastSuccessAt || ""),
      lastRefreshError,
      updatedAt: now,
    });
  } catch { /* 健康标记失败不能覆盖原始刷新结果。 */ }
}
async function writeWorkerHeartbeat(path, kind) {
  try {
    const previous = readJson(path, {});
    const now = new Date().toISOString();
    await writeJsonAtomic(path, { ...previous, kind, heartbeatAt: now, updatedAt: now });
  } catch { /* 心跳失败由 ageMs 超时体现。 */ }
}
function profile(label) {
  if (process.env.TASKCENTER_METRICS_PROFILE !== "1") return;
  const memory = process.memoryUsage();
  console.log(`[metrics-worker] ${label} rss=${memory.rss} heapUsed=${memory.heapUsed} external=${memory.external}`);
}

const runningChildren = new Map();
function runRefreshChild(mode) {
  if (runningChildren.has(mode)) return runningChildren.get(mode);
  const promise = new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1]], {
      cwd: projectRoot,
      env: { ...process.env, TASKCENTER_METRICS_CHILD: mode, TASKCENTER_METRICS_ONCE: "1" },
      stdio: "inherit",
    });
    child.once("error", (error) => {
      console.error(`[metrics-worker] ${mode} child failed: ${safeError(error)}`);
      resolve();
    });
    child.once("exit", (code, signal) => {
      if (code !== 0) console.error(`[metrics-worker] ${mode} child exited: ${signal || code}`);
      resolve();
    });
  }).finally(() => runningChildren.delete(mode));
  runningChildren.set(mode, promise);
  return promise;
}

function sourceSignature() {
  return [taskEventsPath, taskLedgerPath, delegationsPath, usageReportPath].map((path) => {
    try { const info = statSync(path); return `${info.dev || 0}:${info.ino || 0}:${info.size}:${info.mtimeMs}`; } catch { return "missing"; }
  }).join("|");
}

const childMode = process.env.TASKCENTER_METRICS_CHILD || "";
if (childMode === "usage") {
  await refreshUsage();
  profile("after-usage");
} else if (childMode === "governance") {
  await refreshGovernance();
  profile("after-governance");
} else if (process.env.TASKCENTER_METRICS_ONCE === "1") {
  await refreshUsage();
  profile("after-usage");
  await refreshGovernance();
  profile("after-governance");
  console.log("[metrics-worker] snapshots refreshed once.");
} else {
  await runRefreshChild("usage");
  await runRefreshChild("governance");
  let governanceSignature = sourceSignature();
  setInterval(() => {
    const next = sourceSignature();
    if (next === governanceSignature) {
      void writeWorkerHeartbeat(governanceHealthPath, "governance");
      return;
    }
    governanceSignature = next;
    void runRefreshChild("governance");
  }, 5_000);
  setInterval(() => void runRefreshChild("usage").then(() => runRefreshChild("governance")), 60_000);
  console.log("[metrics-worker] low-memory snapshot scheduler is active.");
}
