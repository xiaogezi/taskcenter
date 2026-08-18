import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  beginReflectionExecution,
  buildReflectionExecutionPrompt,
  decideReflectionProposal,
  generateReflection,
  hydrateReflectionState,
  reconcileReflectionSessionSelection,
} from "../scripts/reflection-engine.mjs";

const now = "2026-08-17T02:00:00.000Z";

test("反思只生成聚合证据，不复制任务或 Session 正文", () => {
  const secret = "private blocker detail must not persist";
  const state = generateReflection({
    now,
    sessionSelection: { mode: "allowlist", threadIds: ["019f0000-0000-7000-8000-000000000001"] },
    tasks: [
      { id: "task-a", status: "done_claimed", title: secret, tests: [], evidence: [] },
      { id: "task-b", status: "done_claimed", blocker: secret, tests: ["unit"], evidence: [] },
    ],
  });
  const serialized = JSON.stringify(state);
  assert.ok(state.proposals.some((proposal) => proposal.id === "reflection-evidence-gap"));
  assert.equal(state.proposals.find((proposal) => proposal.id === "reflection-evidence-gap")?.evidence[0].count, 1);
  assert.doesNotMatch(serialized, /private blocker detail/);
  assert.match(serialized, /task-a/);
});

test("空白名单产生边界提示，采纳决策在相同证据下保留", () => {
  const first = generateReflection({ now, sessionSelection: { mode: "allowlist", threadIds: [] }, tasks: [] });
  const accepted = decideReflectionProposal(first, "reflection-empty-allowlist", "accepted", "人工确认");
  assert.equal(accepted.proposals[0].executionPolicy, "manual_only");
  assert.throws(
    () => beginReflectionExecution(accepted, "reflection-empty-allowlist", { id: "execution-manual", requestId: "request-manual", taskId: "task-manual" }, []),
    /需要人工操作/,
  );
  const rerun = generateReflection({ now: "2026-08-17T03:00:00.000Z", sessionSelection: { mode: "allowlist", threadIds: [] }, tasks: [], previousState: accepted });
  assert.equal(rerun.proposals[0].status, "accepted");
  assert.equal(rerun.proposals[0].decisionReason, "人工确认");
});

test("配置非空白名单后人工配置提示立即消失", () => {
  const empty = generateReflection({ now, sessionSelection: { mode: "allowlist", threadIds: [] }, tasks: [] });
  const reconciled = reconcileReflectionSessionSelection(
    empty,
    { mode: "allowlist", threadIds: ["019f0000-0000-7000-8000-000000000001"] },
    "2026-08-17T03:00:00.000Z",
  );
  assert.equal(reconciled.dataBoundary.allowedSessionCount, 1);
  assert.equal(reconciled.proposals.some((proposal) => proposal.id === "reflection-empty-allowlist"), false);
  assert.equal(reconcileReflectionSessionSelection(reconciled, { mode: "allowlist", threadIds: ["019f0000-0000-7000-8000-000000000001"] }), reconciled);
});

test("反思输入变化后已处理提案重新进入审核", () => {
  const selection = { mode: "allowlist", threadIds: ["019f0000-0000-7000-8000-000000000001"] };
  const task = { id: "task-a", status: "done_claimed", tests: [], evidence: [] };
  const first = generateReflection({ now, sessionSelection: selection, tasks: [task] });
  const rejected = decideReflectionProposal(first, "reflection-evidence-gap", "rejected");
  const rerun = generateReflection({ now, sessionSelection: selection, tasks: [task, { ...task, id: "task-b" }], previousState: rejected });
  assert.equal(rerun.proposals.find((proposal) => proposal.id === "reflection-evidence-gap").status, "proposed");
});

test("逾期计划质量提案会聚焦持续超期与会话内依赖聚类", () => {
  const selection = { mode: "allowlist", threadIds: ["019f0000-0000-7000-8000-000000000001", "019f0000-0000-7000-8000-000000000002"] };
  const taskNow = Date.parse(now);
  const overdue = new Date(taskNow - 4 * 24 * 60 * 60 * 1000).toISOString();
  const stillOverdue = new Date(taskNow - 12 * 60 * 60 * 1000).toISOString();
  const fresh = new Date(taskNow - 30 * 60 * 1000).toISOString();
  const state = generateReflection({
    now,
    sessionSelection: selection,
    tasks: [
      { id: "task-overdue-old-1", status: "planned", dueAt: overdue, sessionId: "019f0000-0000-7000-8000-000000000001" },
      { id: "task-overdue-old-2", status: "blocked", dueAt: overdue, sessionId: "019f0000-0000-7000-8000-000000000001" },
      { id: "task-overdue-long", status: "in_progress", dueAt: overdue, sessionId: "019f0000-0000-7000-8000-000000000002" },
      { id: "task-overdue-new", status: "planned", dueAt: stillOverdue, sessionId: "019f0000-0000-7000-8000-000000000002" },
      { id: "task-fresh", status: "planned", dueAt: fresh, sessionId: "019f0000-0000-7000-8000-000000000002" },
    ],
  });
  const proposal = state.proposals.find((item) => item.id === "reflection-overdue-work");
  assert.equal(proposal?.status, "proposed");
  assert.equal(proposal?.evidence.find((item) => item.metric === "planning_quality")?.count, 5);
  assert.equal(proposal?.evidence.find((item) => item.metric === "planning_split_candidates")?.count, 3);
  assert.equal(proposal?.evidence.find((item) => item.metric === "planning_dependency_clusters")?.count, 1);
  assert.equal(proposal?.evidence.find((item) => item.metric === "planning_max_overdue_hours")?.count, 96);
  assert.equal(proposal?.evidence.find((item) => item.metric === "planning_median_overdue_hours")?.count, 96);
  assert.equal(proposal?.summary.includes("同会话高风险依赖簇"), true);
  const prompt = buildReflectionExecutionPrompt(proposal, "task-planning-improvement");
  assert.match(prompt, /记录偏差属于范围膨胀、依赖阻塞、风险遗漏还是执行效率偏差/);
  assert.match(prompt, /更新 expected_at.*拆成可独立验收的小任务/);
});

test("反思逾期复盘输出活跃耗时方差与阻塞占比", () => {
  const selection = { mode: "allowlist", threadIds: ["019f0000-0000-7000-8000-000000000001"] };
  const state = generateReflection({
    now,
    sessionSelection: selection,
    tasks: [
      {
        id: "task-active-overdue",
        status: "in_progress",
        dueAt: "2026-08-13T00:00:00.000Z",
        estimatedEffortMs: 1800000,
        actualElapsedMs: 3600000,
        activeElapsedMs: 3600000,
        wallElapsedMs: 4000000,
        firstStartedAt: "2026-08-13T01:00:00.000Z",
        statusHistory: [
          { status: "in_progress", at: "2026-08-13T01:00:00.000Z" },
          { status: "blocked", at: "2026-08-13T02:00:00.000Z" },
          { status: "in_progress", at: "2026-08-13T02:30:00.000Z" },
        ],
      },
      {
        id: "task-blocked-overdue",
        status: "blocked",
        dueAt: "2026-08-13T00:00:00.000Z",
        estimatedEffortMs: 1200000,
        actualElapsedMs: 2400000,
        activeElapsedMs: 1200000,
        wallElapsedMs: 3600000,
        firstStartedAt: "2026-08-13T00:30:00.000Z",
        statusHistory: [
          { status: "in_progress", at: "2026-08-13T00:30:00.000Z" },
          { status: "blocked", at: "2026-08-13T01:30:00.000Z" },
        ],
      },
    ],
  });
  const proposal = state.proposals.find((item) => item.id === "reflection-overdue-work");
  assert.equal(proposal?.status, "proposed");
  const variance = proposal?.evidence.find((item) => /active.*effort.*variance/i.test(item.metric));
  const blockedRatio = proposal?.evidence.find((item) => /blocked.*ratio/i.test(item.metric));
  assert.ok(variance, "反思证据应包含活跃耗时方差");
  assert.ok(blockedRatio, "反思证据应包含阻塞占比");
  assert.equal(typeof variance.count, "number");
  assert.equal(typeof blockedRatio.count, "number");
});

test("已有活跃改进任务时拒绝重复创建，声明完成后按复查结果解决或重开", () => {
  const selection = { mode: "allowlist", threadIds: ["019f0000-0000-7000-8000-000000000001"] };
  const issue = { id: "task-a", status: "done_claimed", tests: [], evidence: [] };
  let state = generateReflection({ now, sessionSelection: selection, tasks: [issue] });
  state = decideReflectionProposal(state, "reflection-evidence-gap", "accepted");
  const execution = { id: "execution-a", requestId: "request-a", taskId: "task-improvement", status: "preparing" };
  state = beginReflectionExecution(state, "reflection-evidence-gap", execution, []).state;
  assert.throws(
    () => beginReflectionExecution(state, "reflection-evidence-gap", { ...execution, id: "execution-b", requestId: "request-b" }, [{ id: "task-improvement", status: "in_progress" }]),
    /已有未结束的改进任务/,
  );
  const completedImprovement = { id: "task-improvement", status: "done_claimed", tests: ["npm test"], evidence: [] };
  const resolved = generateReflection({ now, sessionSelection: selection, tasks: [completedImprovement], previousState: state });
  assert.equal(resolved.proposals[0].status, "resolved");
  const reopened = generateReflection({ now, sessionSelection: selection, tasks: [issue, completedImprovement], previousState: state });
  assert.equal(reopened.proposals.find((proposal) => proposal.id === "reflection-evidence-gap").status, "proposed");
});

test("原生 Agent 完成后需再次反思确认问题仍存在才允许重复派发", () => {
  const selection = { mode: "allowlist", threadIds: ["019f0000-0000-7000-8000-000000000001"] };
  const issue = { id: "task-a", status: "done_claimed", tests: [], evidence: [] };
  let state = decideReflectionProposal(
    generateReflection({ now, sessionSelection: selection, tasks: [issue] }),
    "reflection-evidence-gap",
    "accepted",
  );
  const nativeTask = {
    id: "task-native-improvement",
    requirementId: "reflection:reflection-evidence-gap",
    sessionId: "019f0000-0000-7000-8000-000000000001",
    status: "done_claimed",
    updatedAt: now,
  };
  assert.throws(
    () => beginReflectionExecution(state, "reflection-evidence-gap", { id: "execution-b", requestId: "request-b", taskId: "task-b" }, [nativeTask]),
    /已有未结束的改进任务/,
  );
  state = generateReflection({ now, sessionSelection: selection, tasks: [issue, nativeTask], previousState: state });
  assert.equal(state.proposals[0].status, "proposed");
  const execution = hydrateReflectionState(state, [issue, nativeTask], []).proposals[0].executions.at(-1);
  assert.equal(execution.mode, "native");
  assert.equal(execution.taskStatus, "done_claimed");
  state = decideReflectionProposal(state, "reflection-evidence-gap", "accepted");
  assert.equal(
    beginReflectionExecution(state, "reflection-evidence-gap", { id: "execution-b", requestId: "request-b", taskId: "task-b" }, [nativeTask]).execution.taskId,
    "task-b",
  );
});

test("控制服务支持运行反思和人工审核并持久化", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "taskcenter-reflection-"));
  const port = 3_900 + Math.floor(Math.random() * 100);
  const dashboardPath = join(directory, "dashboard.json");
  const ledgerPath = join(directory, "task-ledger.json");
  const selectionPath = join(directory, "session-selection.json");
  const reflectionPath = join(directory, "reflection-proposals.json");
  const dispatchesPath = join(directory, "dispatches.json");
  const capturePath = join(directory, "sdk-capture.json");
  const fakeSdkPath = join(directory, "fake-codex-sdk.mjs");
  const newSessionId = "019f9000-0000-7000-8000-000000000001";
  await writeFile(fakeSdkPath, `
import { writeFileSync } from "node:fs";
export class Codex {
  startThread() {
    return { runStreamed: async (prompt) => {
      writeFileSync(process.env.TASKCENTER_SDK_CAPTURE, JSON.stringify({ prompt }));
      return { events: (async function* () {
        yield { type: "thread.started", thread_id: "${newSessionId}" };
        yield { type: "turn.completed" };
      })() };
    } };
  }
  resumeThread() { throw new Error("测试不应恢复已有 Session"); }
}
`);
  await writeFile(dashboardPath, JSON.stringify({ source: { availableThreads: [] }, threads: [] }));
  await writeFile(ledgerPath, JSON.stringify([{ id: "task-proof", status: "done_claimed", tests: [], evidence: [], sessionId: "session-local" }]));
  await writeFile(selectionPath, JSON.stringify({ version: 2, mode: "allowlist", threadIds: [] }));
  const child = spawn(process.execPath, ["scripts/control-server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TASKCENTER_CONTROL_PORT: String(port),
      TASKCENTER_DASHBOARD_PATH: dashboardPath,
      TASKCENTER_TASK_LEDGER_PATH: ledgerPath,
      TASKCENTER_TASK_EVENTS_PATH: join(directory, "task-events.jsonl"),
      TASKCENTER_TASK_EVENT_IDS_PATH: join(directory, "task-event-ids.json"),
      TASKCENTER_SESSION_REGISTRY_PATH: join(directory, "session-registry.json"),
      TASKCENTER_DELEGATIONS_PATH: join(directory, "delegations.json"),
      TASKCENTER_SESSION_SELECTION_PATH: selectionPath,
      TASKCENTER_REFLECTION_PROPOSALS_PATH: reflectionPath,
      TASKCENTER_DISPATCHES_PATH: dispatchesPath,
      TASKCENTER_CODEX_SDK_MODULE: fakeSdkPath,
      TASKCENTER_SDK_CAPTURE: capturePath,
      TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION: "1",
    },
    stdio: "ignore",
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const headers = { Origin: "http://localhost:3000", "Content-Type": "application/json", "X-TaskCenter-Action": "delegate" };
  let response = await fetch(`${base}/reflections/run`, { method: "POST", headers, body: "{}" });
  assert.equal(response.status, 200);
  let state = await response.json();
  assert.ok(state.proposals.some((proposal) => proposal.id === "reflection-evidence-gap"));
  response = await fetch(`${base}/reflections/reflection-evidence-gap/actions`, { method: "POST", headers, body: JSON.stringify({ decision: "accepted" }) });
  assert.equal(response.status, 200);
  state = await response.json();
  assert.equal(state.proposals.find((proposal) => proposal.id === "reflection-evidence-gap").status, "accepted");
  assert.equal(JSON.parse(await readFile(reflectionPath, "utf8")).proposals.find((proposal) => proposal.id === "reflection-evidence-gap").status, "accepted");

  const requestId = "019f9000-0000-7000-8000-000000000099";
  response = await fetch(`${base}/reflections/reflection-evidence-gap/execute`, {
    method: "POST",
    headers,
    body: JSON.stringify({ requestId, mode: "new_session" }),
  });
  assert.equal(response.status, 200, await response.text().then((text) => text || "execute failed"));
  state = await (await fetch(`${base}/reflections`)).json();
  const proposal = state.proposals.find((item) => item.id === "reflection-evidence-gap");
  assert.equal(proposal.executions.length, 1);
  assert.equal(proposal.executions[0].sessionId, newSessionId);
  assert.equal(proposal.executions[0].taskStatus, "in_progress");
  assert.equal(proposal.executions[0].dispatchStatus, "delivered");
  const taskId = proposal.executions[0].taskId;
  const tasks = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(tasks.filter((task) => task.id === taskId).length, 1);
  assert.equal(tasks.find((task) => task.id === taskId).requirementId, "reflection:reflection-evidence-gap");
  const capture = JSON.parse(await readFile(capturePath, "utf8"));
  assert.match(capture.prompt, new RegExp(taskId));
  assert.match(capture.prompt, /不得创建第二条任务/);

  response = await fetch(`${base}/reflections/reflection-evidence-gap/execute`, {
    method: "POST",
    headers,
    body: JSON.stringify({ requestId, mode: "new_session" }),
  });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(await readFile(ledgerPath, "utf8")).filter((task) => task.id === taskId).length, 1);
});

test("已采纳提案可先在已有 Session 建任务再派发", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "taskcenter-reflection-existing-"));
  const port = 4_000 + Math.floor(Math.random() * 100);
  const sessionId = "019f9100-0000-7000-8000-000000000001";
  const sessionsRoot = join(directory, "sessions");
  const sessionPath = join(sessionsRoot, `${sessionId}.jsonl`);
  const dashboardPath = join(directory, "dashboard.json");
  const ledgerPath = join(directory, "task-ledger.json");
  const reflectionPath = join(directory, "reflection-proposals.json");
  const fakeCliPath = join(directory, "fake-codex-cli.mjs");
  const capturePath = join(directory, "cli-capture.json");
  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(sessionPath, `${JSON.stringify({ type: "session_meta", timestamp: "2026-08-17T00:00:00.000Z", payload: { id: sessionId } })}\n`);
  await writeFile(dashboardPath, JSON.stringify({ source: { availableThreads: [{ id: sessionId, title: "已有会话" }] }, threads: [] }));
  const issue = { id: "task-source", status: "done_claimed", tests: [], evidence: [], sessionId };
  await writeFile(ledgerPath, `${JSON.stringify([issue])}\n`);
  let reflection = generateReflection({ now, sessionSelection: { mode: "allowlist", threadIds: [sessionId] }, tasks: [issue] });
  reflection = decideReflectionProposal(reflection, "reflection-evidence-gap", "accepted");
  await writeFile(reflectionPath, JSON.stringify(reflection));
  await writeFile(fakeCliPath, `
import { appendFileSync, writeFileSync } from "node:fs";
const [, , , , threadId, prompt, jsonFlag] = process.argv;
writeFileSync(process.env.TASKCENTER_CLI_CAPTURE, JSON.stringify({ threadId, prompt, jsonFlag }));
appendFileSync(process.env.TASKCENTER_TEST_SESSION_PATH, JSON.stringify({ type: "event_msg", timestamp: new Date().toISOString(), payload: { type: "user_message", message: prompt } }) + "\\n");
console.log(JSON.stringify({ type: "thread.started", thread_id: threadId }));
console.log(JSON.stringify({ type: "turn.started" }));
`);
  const child = spawn(process.execPath, ["scripts/control-server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TASKCENTER_CONTROL_PORT: String(port),
      TASKCENTER_DASHBOARD_PATH: dashboardPath,
      TASKCENTER_TASK_LEDGER_PATH: ledgerPath,
      TASKCENTER_TASK_EVENTS_PATH: join(directory, "task-events.jsonl"),
      TASKCENTER_TASK_EVENT_IDS_PATH: join(directory, "task-event-ids.json"),
      TASKCENTER_SESSION_REGISTRY_PATH: join(directory, "session-registry.json"),
      TASKCENTER_DELEGATIONS_PATH: join(directory, "delegations.json"),
      TASKCENTER_SESSION_SELECTION_PATH: join(directory, "session-selection.json"),
      TASKCENTER_REFLECTION_PROPOSALS_PATH: reflectionPath,
      TASKCENTER_DISPATCHES_PATH: join(directory, "dispatches.json"),
      TASKCENTER_SESSIONS_ROOT: sessionsRoot,
      TASKCENTER_CODEX_COMMAND: process.execPath,
      TASKCENTER_CODEX_PREFIX_ARGS: JSON.stringify([fakeCliPath]),
      TASKCENTER_CLI_CAPTURE: capturePath,
      TASKCENTER_TEST_SESSION_PATH: sessionPath,
      TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION: "1",
    },
    stdio: "ignore",
  });
  t.after(async () => { child.kill("SIGTERM"); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  const headers = { Origin: "http://localhost:3000", "Content-Type": "application/json", "X-TaskCenter-Action": "delegate" };
  const response = await fetch(`${base}/reflections/reflection-evidence-gap/execute`, {
    method: "POST",
    headers,
    body: JSON.stringify({ requestId: "019f9100-0000-7000-8000-000000000099", mode: "existing_session", threadId: sessionId }),
  });
  assert.equal(response.status, 202);
  let state;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    state = await (await fetch(`${base}/reflections`)).json();
    if (state.proposals[0].executions[0].dispatchStatus === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const execution = state.proposals[0].executions[0];
  assert.equal(execution.sessionId, sessionId);
  assert.equal(execution.taskStatus, "in_progress");
  assert.equal(execution.dispatchStatus, "completed");
  const capture = JSON.parse(await readFile(capturePath, "utf8"));
  assert.equal(capture.threadId, sessionId);
  assert.match(capture.prompt, new RegExp(execution.taskId));
});
