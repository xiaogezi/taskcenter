import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DispatchError,
  loadDispatchTarget,
} from "./dispatch-core.mjs";
import {
  defaultSessionsRoot,
  inspectSessionState,
  resumeSession,
} from "./session-cli.mjs";
import {
  completeContextTasks,
  completeTasksByReconciliation,
  ensureContextTask,
  getSessionStatuses,
  loadTasks,
  loadVisibleTasks,
  reconcileContextShadowTasks,
  reconcileTasks,
  recordTaskEvent,
  supersedeContextShadowTask,
  taskEventsPath,
  taskLedgerPath,
  TaskLedgerError,
} from "./task-ledger.mjs";
import { syncContextEvent } from "./context-bridge.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const dashboardPath = resolve(process.env.TASKCENTER_DASHBOARD_PATH || join(projectRoot, "data", "dashboard.json"));
const dispatchesPath = resolve(process.env.TASKCENTER_DISPATCHES_PATH || join(projectRoot, "data", "dispatches.json"));
const overridesPath = resolve(process.env.TASKCENTER_OVERRIDES_PATH || join(projectRoot, "data", "requirement-overrides.json"));
const inboxDecisionsPath = resolve(process.env.TASKCENTER_INBOX_DECISIONS_PATH || join(projectRoot, "data", "inbox-decisions.json"));
const sessionSelectionPath = resolve(process.env.TASKCENTER_SESSION_SELECTION_PATH || join(projectRoot, "data", "session-selection.json"));
const watcherHeartbeatPath = resolve(process.env.TASKCENTER_WATCHER_HEARTBEAT_PATH || join(projectRoot, ".local", "runtime", "watcher-heartbeat.json"));
const host = "127.0.0.1";
const port = Number(process.env.TASKCENTER_CONTROL_PORT || 3001);
const dryRun = process.env.TASKCENTER_DISPATCH_DRY_RUN === "1";
const reconcileLiveSessions = process.env.TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION !== "1";
const sessionsRoot = defaultSessionsRoot();
const allowedOrigins = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://[::1]:3000",
]);
const dispatches = loadDispatches();
const requirementOverrides = loadJsonObject(overridesPath);
const inboxDecisions = loadJsonObject(inboxDecisionsPath);
const activeThreadDispatches = new Set();
let lastDispatchAt = 0;
let processingQueue = false;
let syncing = null;

mkdirSync(dirname(dispatchesPath), { recursive: true });
migrateLegacyDispatches();
const startupContextReconciliation = reconcileContextShadowTasks();
if (startupContextReconciliation.reconciled.length) {
  console.log(`[TaskCenter] 已收敛 ${startupContextReconciliation.reconciled.length} 条 Context 影子任务。`);
}
const queueTimer = setInterval(() => void processQueue(), 5_000);
queueTimer.unref();
void processQueue();

const server = createServer(async (request, response) => {
  try {
    setCors(request, response);
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      const dashboard = inspectFile(dashboardPath);
      const heartbeat = inspectFile(watcherHeartbeatPath, true);
      const watcherFresh = heartbeat.readable && Date.now() - Date.parse(heartbeat.updatedAt) < 30_000;
      sendJson(response, 200, { ok: true, dryRun, syncing: Boolean(syncing), control: { uptimeSeconds: Math.round(process.uptime()) }, dashboard, ledger: { readable: inspectFile(taskLedgerPath).readable, eventsReadable: inspectFile(taskEventsPath).readable }, watcher: { ...heartbeat, healthy: watcherFresh } });
      return;
    }
    if (request.method === "POST" && request.url === "/sync") {
      verifyActionRequest(request);
      sendJson(response, syncing ? 202 : 200, await syncNow());
      return;
    }
    if (request.method === "GET" && request.url === "/dashboard") {
      sendJson(response, 200, loadDashboard());
      return;
    }
    if (request.method === "GET" && request.url === "/session-selection") {
      const dashboard = loadDashboard();
      sendJson(response, 200, {
        selection: loadSessionSelection(),
        availableThreads: dashboard.source?.availableThreads ?? dashboard.threads ?? [],
      });
      return;
    }
    if (request.method === "GET" && request.url === "/session-status") {
      if (reconcileLiveSessions) reconcileTasks(availableSessionIds());
      sendJson(response, 200, { sessions: getSessionStatuses(availableSessionIds(), loadVisibleTasks()) });
      return;
    }
    if (request.method === "POST" && request.url === "/session-selection") {
      verifyActionRequest(request);
      const body = await readJsonBody(request);
      const mode = body.mode === "selected" ? "selected" : body.mode === "all" ? "all" : "";
      const threadIds = Array.isArray(body.threadIds)
        ? [...new Set(body.threadIds.filter((id) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)))]
        : [];
      if (!mode) throw new DispatchError(400, "会话选择模式无效。");
      persistJsonObject(sessionSelectionPath, { mode, threadIds, updatedAt: new Date().toISOString() });
      const result = await syncNow();
      sendJson(response, 200, { ...result, selection: { mode, threadIds } });
      return;
    }
    if (request.method === "GET" && request.url === "/dispatches") {
      sendJson(response, 200, { dispatches: dispatches.slice(-30).reverse() });
      return;
    }
    if (request.method === "GET" && request.url === "/tasks") {
      if (reconcileLiveSessions) reconcileTasks(availableSessionIds());
      sendJson(response, 200, { tasks: loadVisibleTasks().slice().reverse() });
      return;
    }
    if (request.method === "POST" && request.url === "/context-tasks/ensure") {
      verifyTaskRequest(request);
      const body = await readJsonBody(request);
      const result = ensureContextTask(body);
      sendJson(response, result.created ? 201 : 200, { accepted: true, ...result });
      return;
    }
    if (request.method === "POST" && request.url === "/context-tasks/complete") {
      verifyTaskRequest(request);
      const body = await readJsonBody(request);
      const result = completeContextTasks(body);
      sendJson(response, 200, { accepted: true, ...result });
      return;
    }
    if (request.method === "POST" && request.url === "/maintenance/context-tasks/reconcile") {
      verifyManualTaskAction(request);
      const body = await readJsonBody(request);
      if (body.confirm !== true) throw new TaskLedgerError(400, "生命周期清理需要显式 confirm=true。");
      const replacements = Array.isArray(body.shadowReplacements) ? body.shadowReplacements.slice(0, 50) : [];
      const superseded = replacements.map((item) => supersedeContextShadowTask(
        String(item?.shadowTaskId || ""),
        String(item?.replacementTaskId || ""),
        String(item?.reason || "人工确认内部影子任务已被正式任务接管。"),
      ).task);
      const automatic = reconcileContextShadowTasks();
      const completed = completeTasksByReconciliation(
        Array.isArray(body.completeTaskIds) ? body.completeTaskIds.slice(0, 50) : [],
        String(body.completionEvidence || "人工核对本地 Session final_answer 与 task_complete 后补齐完成上报。"),
      );
      sendJson(response, 200, {
        accepted: true,
        superseded,
        automaticallySuperseded: automatic.reconciled,
        completed: completed.completed,
      });
      return;
    }
    const taskEventsMatch = request.method === "GET" ? request.url?.match(/^\/tasks\/([A-Za-z0-9._-]+)\/events(?:\?limit=(\d+))?$/) : null;
    if (taskEventsMatch) {
      const taskId = taskEventsMatch[1];
      const limit = Math.min(100, Math.max(1, Number(taskEventsMatch[2] || 50)));
      const events = readTaskEvents(taskId).slice(-limit).reverse();
      sendJson(response, 200, { taskId, events });
      return;
    }
    if (request.method === "POST" && request.url === "/task-events") {
      verifyTaskRequest(request);
      const body = await readJsonBody(request);
      if (body.type === "task.review" || body.status === "verified") {
        throw new TaskLedgerError(403, "人工审核必须通过本机任务操作入口完成。");
      }
      const sessionIds = availableSessionIds();
      if (reconcileLiveSessions) reconcileTasks(sessionIds);
      const result = recordTaskEvent(body, {
        ...(reconcileLiveSessions ? { availableSessionIds: sessionIds } : {}),
        requireRegistered: true,
      });
      // 本地账本事件幂等不等于外部同步已成功。重复投递仍使用同一派生 event_id
      // 重试 Context MCP，由 Context 侧幂等键消除已成功的副作用并补偿超时/失败。
      const contextSync = await syncContextEvent(result.event, result.task);
      // 幂等重投递（重复 event_id）返回 200，只有真正新建任务时才用 201。
      sendJson(response, body.type === "task.create" && !result.idempotent ? 201 : 200, {
        accepted: true,
        idempotent: Boolean(result.idempotent),
        event: result.event,
        task: result.task,
        contextSync,
      });
      return;
    }
    // 人工操作端点：本机 UI 对任务的状态变更（开始/阻塞/声明完成/取消/移除）
    const taskActionMatch = request.method === "POST"
      ? request.url?.match(/^\/tasks\/([A-Za-z0-9._-]+)\/actions$/)
      : null;
    if (taskActionMatch) {
      verifyManualTaskAction(request);
      const taskId = taskActionMatch[1];
      const body = await readJsonBody(request);
      const action = String(body.action || "");
      if (!["start", "block", "done", "cancel", "remove", "verify", "reject", "archive", "unarchive", "schedule"].includes(action)) {
        throw new TaskLedgerError(400, "任务操作无效。");
      }
      const currentTask = loadTasks().find((item) => item.id === taskId);
      if (action === "verify" && currentTask?.requirementId) verifyRequirementExists(currentTask.requirementId.replace(/^promoted-/, ""));
      const result = applyManualTaskAction(taskId, action, body.reason, body.expectedAt);
      const contextSync = await syncContextEvent(result.event, result.task);
      if (action === "verify" && result.task.requirementId) {
        const requirementId = result.task.requirementId.replace(/^promoted-/, "");
        verifyRequirementExists(requirementId);
        requirementOverrides[requirementId] = {
          ...(requirementOverrides[requirementId] || {}),
          status: "verified", hidden: false, source: "manual", updatedAt: result.task.reviewedAt,
        };
        persistJsonObject(overridesPath, requirementOverrides);
      }
      if (action === "reject" && result.task.requirementId) {
        const requirementId = result.task.requirementId.replace(/^promoted-/, "");
        verifyRequirementExists(requirementId);
        requirementOverrides[requirementId] = {
          ...(requirementOverrides[requirementId] || {}),
          status: "needs_validation", hidden: false, source: "manual", updatedAt: result.task.reviewedAt,
        };
        persistJsonObject(overridesPath, requirementOverrides);
      }
      sendJson(response, 200, {
        accepted: true,
        action,
        task: result.task,
        contextSync,
        actor: "manual",
      });
      return;
    }
    if (request.method === "GET" && request.url === "/requirement-overrides") {
      sendJson(response, 200, { overrides: requirementOverrides });
      return;
    }
    if (request.method === "GET" && request.url === "/inbox-decisions") {
      sendJson(response, 200, { decisions: inboxDecisions });
      return;
    }
    const inboxBatchMatch = request.method === "POST" && request.url === "/inbox-decisions/batch";
    if (inboxBatchMatch) {
      verifyActionRequest(request);
      const body = await readJsonBody(request);
      const ids = Array.isArray(body.ids) ? [...new Set(body.ids)] : [];
      validateInboxIds(ids);
      const decision = body.decision === "clear" ? undefined : body.decision;
      validateInboxDecision(body.decision);
      const nextDecisions = { ...inboxDecisions };
      for (const id of ids) {
        if (decision) nextDecisions[id] = decision;
        else delete nextDecisions[id];
      }
      persistJsonObject(inboxDecisionsPath, nextDecisions);
      Object.keys(inboxDecisions).forEach((id) => delete inboxDecisions[id]);
      Object.assign(inboxDecisions, nextDecisions);
      sendJson(response, 200, { decisions: inboxDecisions });
      return;
    }
    const inboxDecisionMatch = request.method === "POST"
      ? request.url?.match(/^\/inbox-decisions\/([A-Za-z0-9._-]{1,160})$/)
      : null;
    if (inboxDecisionMatch) {
      verifyActionRequest(request);
      const id = inboxDecisionMatch[1];
      const body = await readJsonBody(request);
      validateInboxIds([id]);
      validateInboxDecision(body.decision);
      const nextDecisions = { ...inboxDecisions };
      if (body.decision === "clear") delete nextDecisions[id];
      else nextDecisions[id] = body.decision;
      persistJsonObject(inboxDecisionsPath, nextDecisions);
      Object.keys(inboxDecisions).forEach((existingId) => delete inboxDecisions[existingId]);
      Object.assign(inboxDecisions, nextDecisions);
      sendJson(response, 200, { id, decision: inboxDecisions[id] });
      return;
    }
    const decisionMatch = request.method === "POST"
      ? request.url?.match(/^\/requirements\/([A-Za-z0-9._-]{1,160})\/decision$/)
      : null;
    if (decisionMatch) {
      verifyActionRequest(request);
      const requirementId = decisionMatch[1].replace(/^promoted-/, "");
      const body = await readJsonBody(request);
      const action = String(body.action || "");
      if (!["complete", "remove", "restore"].includes(action)) {
        throw new DispatchError(400, "需求操作无效。");
      }
      verifyRequirementExists(requirementId);
      const current = requirementOverrides[requirementId] || {};
      requirementOverrides[requirementId] = {
        ...current,
        ...(action === "complete" ? { status: "verified", hidden: false } : {}),
        ...(action === "remove" ? { hidden: true } : {}),
        ...(action === "restore" ? { hidden: false } : {}),
        source: "manual",
        updatedAt: new Date().toISOString(),
      };
      persistJsonObject(overridesPath, requirementOverrides);
      sendJson(response, 200, {
        requirementId,
        override: requirementOverrides[requirementId],
      });
      return;
    }
    const cancelMatch = request.method === "POST"
      ? request.url?.match(/^\/dispatches\/([0-9a-f-]+)\/cancel$/i)
      : null;
    if (cancelMatch) {
      verifyActionRequest(request);
      const record = dispatches.find((item) => item.id === cancelMatch[1]);
      if (!record) throw new DispatchError(404, "找不到这条投递记录。");
      if (record.status !== "queued") {
        throw new DispatchError(409, "只有仍在等待的队列任务可以取消；已经开始执行的任务不能强制中断。");
      }
      finishDispatch(record, "cancelled", "已人工取消自动投递，可复制任务信息后手动发送。");
      sendJson(response, 200, { dispatch: record });
      return;
    }
    if (request.method === "POST" && request.url === "/dispatch") {
      verifyActionRequest(request);
      const body = await readJsonBody(request);
      const mode = String(body.mode || "new_session");
      if (!["new_session", "existing_session"].includes(mode)) {
        throw new DispatchError(400, "投递模式无效。");
      }
      const target = loadDispatchTarget(
        dashboardPath,
        String(body.requirementId || ""),
        String(body.threadId || ""),
      );
      const duplicate = dispatches.find(
        (item) =>
          item.requirementId === body.requirementId &&
          (item.contextThreadId || item.sourceThreadId || item.threadId) === body.threadId &&
          item.mode === mode &&
          ["queued", "delivering", "running"].includes(item.status),
      );
      if (duplicate) {
        throw new DispatchError(409, "这条需求正在投递到该 Session，请稍候。");
      }
      if (Date.now() - lastDispatchAt < 5_000) {
        throw new DispatchError(429, "发送过于频繁，请稍后再试。");
      }
      lastDispatchAt = Date.now();
      const record = {
        id: randomUUID(),
        requirementId: body.requirementId,
        requirementTitle: target.requirement.title,
        contextThreadId: body.threadId,
        threadId: mode === "new_session" ? "" : body.threadId,
        threadTitle: mode === "new_session"
          ? `新任务：${target.requirement.title}`
          : target.thread.title,
        mode,
        status: dryRun ? "dry_run" : "delivering",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: "",
      };
      dispatches.push(record);
      persistDispatches();
      if (!dryRun) {
        try {
          if (mode === "existing_session") {
            record.pendingPrompt = target.prompt;
            record.workingDirectory = target.cwd;
            const state = inspectSessionState(record.threadId, sessionsRoot);
            if (state.busy || activeThreadDispatches.has(record.threadId)) {
              const reason = state.busy
                ? `目标 Session 正在处理 ${state.activeTurns.length} 个 turn`
                : "同一 Session 已有一条 TaskCenter 消息正在投递";
              finishDispatch(record, "queued", `${reason}，完成后自动投递。`, false);
            } else {
              void startExistingDispatch(record);
            }
          } else {
            const result = await sendToCodex(mode, record.threadId, target.prompt, target.cwd);
            record.threadId = result.threadId;
            finishDispatch(record, "delivered");
          }
        } catch (error) {
          const reason = safeError(error);
          finishDispatch(record, "failed", `投递失败：${reason}`);
          throw new DispatchError(502, `消息未能投递到目标 Session：${reason}`);
        }
      }
      sendJson(response, dryRun || ["queued", "delivering", "running"].includes(record.status) ? 202 : 200, { dispatch: record });
      return;
    }
    sendJson(response, 404, { error: "接口不存在。" });
  } catch (error) {
    const statusCode = error instanceof DispatchError || error instanceof TaskLedgerError ? error.statusCode : 500;
    if (!(error instanceof DispatchError) && !(error instanceof TaskLedgerError)) {
      console.error("TaskCenter control error:", safeError(error));
    }
    sendJson(response, statusCode, {
      error: error instanceof DispatchError || error instanceof TaskLedgerError ? error.message : "本地 Session 投递服务失败，请查看控制服务日志。",
    });
  }
});

server.listen(port, host, () => {
  console.log(`TaskCenter control server is listening on http://${host}:${port}.`);
});

async function sendToCodex(mode, threadId, prompt, workingDirectory) {
  const moduleName = process.env.TASKCENTER_CODEX_SDK_MODULE || "@openai/codex-sdk";
  const { Codex } = await import(moduleName);
  const codex = new Codex();
  const options = {
    workingDirectory: validCwd(workingDirectory),
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
  };
  const thread = mode === "new_session"
    ? codex.startThread(options)
    : codex.resumeThread(threadId, options);
  const { events } = await thread.runStreamed(prompt);
  const iterator = events[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) throw new Error("Codex SDK 未返回任务启动事件");
  if (first.value?.type === "error" || first.value?.type === "turn.failed") {
    throw new Error(first.value.message || "目标 Session 拒绝接收消息");
  }
  const startedThreadId = first.value?.type === "thread.started"
    ? first.value.thread_id
    : threadId;
  if (mode === "new_session" && !startedThreadId) {
    throw new Error("Codex SDK 未返回新 Session ID");
  }
  void drainDelegation(iterator);
  return { threadId: startedThreadId };
}

async function drainDelegation(iterator) {
  try {
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      if (next.value?.type === "error" || next.value?.type === "turn.failed") {
        console.error("TaskCenter delegated turn failed after delivery:", safeError(next.value.message));
      }
    }
  } catch (error) {
    console.error("TaskCenter delegated stream failed after delivery:", safeError(error));
  }
}

function finishDispatch(record, status, error, clearPending = true) {
  record.status = status;
  delete record.pid;
  if (clearPending) {
    delete record.pendingPrompt;
    delete record.workingDirectory;
  }
  record.error = String(error || "").slice(0, 500);
  record.updatedAt = new Date().toISOString();
  persistDispatches();
}

function validCwd(candidate) {
  if (candidate && existsSync(candidate)) return candidate;
  throw new Error("解析出的项目工作目录已不存在，请重新同步看板。");
}

async function startExistingDispatch(record) {
  if (activeThreadDispatches.has(record.threadId)) return;
  activeThreadDispatches.add(record.threadId);
  finishDispatch(record, "delivering", "", false);
  try {
    await resumeSession({
      threadId: record.threadId,
      prompt: record.pendingPrompt,
      workingDirectory: validCwd(record.workingDirectory),
      sessionsRoot,
      onStarted: () => finishDispatch(record, "running", "消息已写入原 Session，Codex 正在处理。", false),
    });
    finishDispatch(record, "completed", "原 Session 已完成本次 turn。");
  } catch (error) {
    finishDispatch(record, "failed", `投递失败：${safeError(error)}`);
  } finally {
    activeThreadDispatches.delete(record.threadId);
  }
}

async function processQueue() {
  if (processingQueue) return;
  processingQueue = true;
  try {
    for (const record of dispatches.filter((item) => item.status === "queued")) {
      try {
        if (activeThreadDispatches.has(record.threadId)) continue;
        const state = inspectSessionState(record.threadId, sessionsRoot);
        if (state.busy) continue;
        void startExistingDispatch(record);
      } catch (error) {
        finishDispatch(record, "failed", `队列检查失败：${safeError(error)}`);
      }
    }
  } finally {
    processingQueue = false;
  }
}

function migrateLegacyDispatches() {
  let changed = false;
  for (const record of dispatches) {
    if (["running", "delivering"].includes(record.status)) {
      record.status = "failed";
      record.error = "控制服务曾在投递过程中停止。为避免重复执行，系统没有自动重发；请先检查原 Session 再决定是否重试。";
      record.updatedAt = new Date().toISOString();
      delete record.pendingPrompt;
      delete record.workingDirectory;
      changed = true;
      continue;
    }
    if (record.status === "queued" && (!record.pendingPrompt || !record.workingDirectory)) {
      record.status = "failed";
      record.error = "历史记录：缺少可恢复的队列上下文，请重新发送。";
      record.updatedAt = new Date().toISOString();
      delete record.pid;
      changed = true;
      continue;
    }
    if (
      record.mode !== "session_message"
      && ["failed", "completed"].includes(record.status)
      && !String(record.error || "").startsWith("历史记录：")
    ) {
      record.error = record.status === "completed"
        ? "历史记录：旧版嵌套执行曾结束，但不代表需求完成或已验收。"
        : "历史记录：旧版嵌套执行失败，现已改为 Session 消息投递。";
      record.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) persistDispatches();
}

function safeError(error) {
  return String(error instanceof Error ? error.message : error || "未知错误").replace(/\s+/g, " ").slice(0, 300);
}

function inspectFile(path, parseJson = false) {
  try {
    const stat = statSync(path);
    const mtime = new Date(stat.mtimeMs).toISOString();
    if (!parseJson) return { readable: true, exists: true, generatedAt: mtime };
    try {
      return { readable: true, exists: true, generatedAt: mtime, updatedAt: JSON.parse(readFileSync(path, "utf8")).updatedAt || mtime };
    } catch {
      return { readable: false, exists: true, generatedAt: mtime, updatedAt: mtime };
    }
  } catch {
    return { readable: false, exists: false, generatedAt: "", updatedAt: "" };
  }
}

function readTaskEvents(taskId) {
  try {
    return readFileSync(taskEventsPath, "utf8").split("\n").flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const event = JSON.parse(line);
        return event.task_id === taskId ? [event] : [];
      } catch { return []; }
    });
  } catch { return []; }
}

function runSync() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, "sync-codex.mjs")], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `同步进程退出码 ${code}`));
        return;
      }
      try {
        const dashboard = JSON.parse(readFileSync(dashboardPath, "utf8"));
        resolve({
          syncing: false,
          generatedAt: dashboard.generatedAt,
          threadCount: dashboard.source?.threadCount ?? dashboard.threads?.length ?? 0,
          messageCount: dashboard.source?.messageCount ?? 0,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function syncNow() {
  if (syncing) return { syncing: true, message: "已有一次扫描正在执行，请稍候刷新看板。" };
  syncing = runSync();
  try {
    return await syncing;
  } finally {
    syncing = null;
  }
}

function verifyActionRequest(request) {
  const origin = request.headers.origin;
  if (!origin || !allowedOrigins.has(origin)) {
    throw new DispatchError(403, "请求来源不是本机 TaskCenter 页面。");
  }
  if (request.headers["x-taskcenter-action"] !== "delegate") {
    throw new DispatchError(403, "缺少 Session 投递确认标记。");
  }
  if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
    throw new DispatchError(415, "请求必须使用 JSON。");
  }
}

function validateInboxIds(ids) {
  if (!ids.length || ids.some((id) => typeof id !== "string" || !/^[A-Za-z0-9._-]{1,160}$/.test(id))) {
    throw new DispatchError(400, "Inbox 需求 ID 无效。");
  }
}

function validateInboxDecision(decision) {
  if (!["continue", "discard", "clear"].includes(decision)) {
    throw new DispatchError(400, "Inbox 决策无效。");
  }
}

function verifyTaskRequest(request) {
  // MCP/Hook 请求只允许本机客户端携带协议标记，不开放给浏览器跨域调用。
  if (["mcp", "hook"].includes(request.headers["x-taskcenter-task"])) {
    if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
      throw new TaskLedgerError(415, "任务事件必须使用 JSON。");
    }
    return;
  }
  // 人工操作：需要浏览器来源和确认标记
  const origin = request.headers.origin;
  if (!origin || !allowedOrigins.has(origin)) {
    throw new TaskLedgerError(403, "请求来源不是本机 TaskCenter 页面。");
  }
  if (request.headers["x-taskcenter-action"] !== "delegate") {
    throw new TaskLedgerError(403, "缺少任务操作确认标记。");
  }
  if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
    throw new TaskLedgerError(415, "任务事件必须使用 JSON。");
  }
}

function verifyManualTaskAction(request) {
  const origin = request.headers.origin;
  if (!origin || !allowedOrigins.has(origin)) {
    throw new TaskLedgerError(403, "人工操作请求来源不是本机 TaskCenter 页面。");
  }
  if (request.headers["x-taskcenter-action"] !== "delegate") {
    throw new TaskLedgerError(403, "缺少人工操作确认标记。");
  }
  if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
    throw new TaskLedgerError(415, "人工操作请求必须使用 JSON。");
  }
}

function applyManualTaskAction(taskId, action, reason = "", expectedAt = "") {
  const tasks = loadTasks();
  const task = tasks.find((item) => item.id === taskId);
  if (!task) {
    throw new TaskLedgerError(404, "任务不存在。");
  }
  if (action === "verify" && task.status !== "done_claimed") {
    throw new TaskLedgerError(409, "只有已声明完成的任务可以验收。");
  }
  if (action === "archive" && !["done_claimed", "verified", "cancelled"].includes(task.status)) {
    throw new TaskLedgerError(409, "只有已完成、已验收或已取消任务可以归档。");
  }
  if (action === "schedule" && (!expectedAt || !Number.isFinite(Date.parse(expectedAt)))) {
    throw new TaskLedgerError(400, "预计完成时间必须是可解析的 ISO 时间。");
  }
  if (action === "reject" && !["done_claimed", "verified"].includes(task.status)) {
    throw new TaskLedgerError(409, "只有待验收或已验收任务可以打回。");
  }
  const event = {
    event_id: `manual-${randomUUID()}`,
    type: ["remove", "verify", "reject", "archive", "unarchive"].includes(action) ? "task.review" : "task.update",
    task_id: taskId,
    session_id: task.sessionId,
    status: action === "start" ? "in_progress" : action === "block" ? "blocked" : action === "done" ? "done_claimed" : action === "cancel" ? "cancelled" : action === "remove" ? "removed" : action === "verify" ? "verified" : action === "reject" ? "in_progress" : undefined,
    archived_at: action === "archive" ? new Date().toISOString() : action === "unarchive" ? "__UNARCHIVE__" : undefined,
    expected_at: action === "schedule" ? expectedAt : undefined,
    review_reason: action === "reject" ? String(reason || "人工打回，需补充证据").slice(0, 1_000) : action === "verify" ? String(reason || "人工验收通过").slice(0, 1_000) : "",
    reviewed_at: ["verify", "reject"].includes(action) ? new Date().toISOString() : "",
    created_at: new Date().toISOString(),
  };
  const result = recordTaskEvent(event);
  return { event, task: result.task };
}

async function readJsonBody(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 16_384) {
      throw new DispatchError(413, "请求内容过大。");
    }
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new DispatchError(400, "请求 JSON 无效。");
  }
}

function setCors(request, response) {
  const origin = request.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-TaskCenter-Action");
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function loadDispatches() {
  if (!existsSync(dispatchesPath)) return [];
  try {
    const value = JSON.parse(readFileSync(dispatchesPath, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function loadJsonObject(path) {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function loadSessionSelection() {
  if (!existsSync(sessionSelectionPath)) return { mode: "all", threadIds: [] };
  try {
    const value = JSON.parse(readFileSync(sessionSelectionPath, "utf8"));
    if (value?.mode === "selected" && Array.isArray(value.threadIds)) {
      return { mode: "selected", threadIds: value.threadIds.filter((id) => typeof id === "string") };
    }
  } catch {
    // Use the safe default when a local selection file is incomplete.
  }
  return { mode: "all", threadIds: [] };
}

function persistJsonObject(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function verifyRequirementExists(requirementId) {
  const dashboard = JSON.parse(readFileSync(dashboardPath, "utf8"));
  if (!(dashboard.requirements || []).some((item) => item.id === requirementId)) {
    throw new DispatchError(404, "需求不存在或已被重新整理。");
  }
}

function loadDashboard() {
  try {
    return JSON.parse(readFileSync(dashboardPath, "utf8"));
  } catch {
    return { source: {}, threads: [] };
  }
}

function availableSessionIds() {
  const dashboard = loadDashboard();
  const threads = dashboard.source?.availableThreads ?? dashboard.threads ?? [];
  return threads.flatMap((thread) => [thread.id, ...(thread.sessionIds ?? [])]).filter(Boolean);
}

function persistDispatches() {
  const next = dispatches.slice(-200);
  const temporaryPath = `${dispatchesPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, dispatchesPath);
}

function shutdown() {
  clearInterval(queueTimer);
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
