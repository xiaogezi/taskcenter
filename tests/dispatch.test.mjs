import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DispatchError,
  buildDispatchPrompt,
  loadDispatchTarget,
} from "../scripts/dispatch-core.mjs";
import { createPilotIntent, updatePilotIntent } from "../scripts/context-management-pilot.mjs";
import { inspectSessionState } from "../scripts/session-cli.mjs";
import { inspectSessionStateAsync } from "../scripts/harnesses/codex-session.mjs";

const threadId = "00000000-0000-4000-8000-000000000001";

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "taskcenter-dispatch-"));
  const taskCenterDirectory = join(directory, "TaskCenter");
  const projectDirectory = join(directory, "Atlas");
  const legacyDirectory = join(directory, "legacy-workspace");
  await mkdir(join(taskCenterDirectory, "data"), { recursive: true });
  await mkdir(join(projectDirectory, ".git"), { recursive: true });
  await mkdir(legacyDirectory, { recursive: true });
  const dashboardPath = join(taskCenterDirectory, "data", "dashboard.json");
  const dispatchesPath = join(directory, "dispatches.json");
  await writeFile(dashboardPath, JSON.stringify({
    threads: [{
      id: threadId,
      title: "测试任务",
      cwd: legacyDirectory,
    }],
    requirements: [
      {
        id: "partial-feature",
        title: "部分完成能力",
        status: "partial",
        summary: "主流程已经存在。",
        gap: "还缺失败反馈和回归测试。",
        evidence: ["Atlas/app/page.tsx"],
        sources: [{ threadId, threadTitle: "测试任务" }],
      },
      {
        id: "verified-feature",
        title: "已验收能力",
        status: "verified",
        sources: [{ threadId, threadTitle: "测试任务" }],
      },
    ],
  }));
  return { directory, dashboardPath, dispatchesPath, projectDirectory };
}

test("只允许部分完成需求发送回证据来源会话", async () => {
  const fixture = await createFixture();
  const target = loadDispatchTarget(fixture.dashboardPath, "partial-feature", threadId);
  assert.equal(target.thread.id, threadId);
  assert.equal(target.cwd, fixture.projectDirectory);
  assert.match(target.prompt, /还缺失败反馈和回归测试/);
  assert.match(target.prompt, /不执行 git add、commit 或 push/);

  assert.throws(
    () => loadDispatchTarget(fixture.dashboardPath, "verified-feature", threadId),
    (error) => error instanceof DispatchError && error.statusCode === 409,
  );
  assert.throws(
    () => loadDispatchTarget(
      fixture.dashboardPath,
      "partial-feature",
      "019f6f27-d228-7af0-b32b-c2daeed14031",
    ),
    (error) => error instanceof DispatchError && error.statusCode === 400,
  );
});

test("进行中需求也沿用来源 Session 投递契约", async () => {
  const fixture = await createFixture();
  const dashboard = JSON.parse(await readFile(fixture.dashboardPath, "utf8"));
  dashboard.requirements[0].status = "in_progress";
  await writeFile(fixture.dashboardPath, JSON.stringify(dashboard));
  const target = loadDispatchTarget(fixture.dashboardPath, "partial-feature", threadId);
  assert.equal(target.requirement.status, "in_progress");
  assert.match(target.prompt, /当前状态：进行中/);
});

test("续办提示词有长度上限且保留安全边界", () => {
  const prompt = buildDispatchPrompt({
    title: "超长需求",
    status: "partial",
    summary: "现状".repeat(1_000),
    gap: "缺口".repeat(1_000),
    evidence: Array.from({ length: 20 }, (_, index) => `证据-${index}`),
  });
  assert.ok(prompt.length <= 3_500);
  assert.match(prompt, /不要重复、回滚或重启已经完成的工作/);
  assert.match(prompt, /已验证结果/);
});

test("Session 生命周期按未结束 turn 判断忙碌状态", async () => {
  const fixture = await createFixture();
  const sessionsRoot = join(fixture.directory, "sessions");
  const sessionPath = join(sessionsRoot, `rollout-${threadId}.jsonl`);
  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(sessionPath, [
    JSON.stringify({ timestamp: "2026-07-19T00:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    JSON.stringify({ timestamp: "2026-07-19T00:00:01.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } }),
    JSON.stringify({ timestamp: "2026-07-19T00:00:02.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-2" } }),
    "",
  ].join("\n"));

  assert.equal(inspectSessionState(threadId, sessionsRoot).busy, true);
  assert.deepEqual(await inspectSessionStateAsync(threadId, sessionsRoot), inspectSessionState(threadId, sessionsRoot));
  await writeFile(sessionPath, `${await readFile(sessionPath, "utf8")}${JSON.stringify({
    timestamp: "2026-07-19T00:00:03.000Z",
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "turn-2" },
  })}\n`);
  assert.equal(inspectSessionState(threadId, sessionsRoot).busy, false);
  assert.deepEqual(await inspectSessionStateAsync(threadId, sessionsRoot), inspectSessionState(threadId, sessionsRoot));
});

test("人工完成、移除和恢复会持久化需求覆盖", async (context) => {
  const fixture = await createFixture();
  const overridesPath = join(fixture.directory, "requirement-overrides.json");
  const port = 37_000 + (process.pid % 1_000);
  const child = spawn(process.execPath, ["scripts/control-server.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      TASKCENTER_CONTROL_PORT: String(port),
      TASKCENTER_DELEGATIONS_PATH: join(fixture.directory, "delegations.json"),
      TASKCENTER_DASHBOARD_PATH: fixture.dashboardPath,
      TASKCENTER_DISPATCHES_PATH: fixture.dispatchesPath,
      TASKCENTER_OVERRIDES_PATH: overridesPath,
      TASKCENTER_TASK_LEDGER_PATH: join(fixture.directory, "task-ledger.json"),
      TASKCENTER_TASK_EVENTS_PATH: join(fixture.directory, "task-events.jsonl"),
      TASKCENTER_TASK_EVENT_IDS_PATH: join(fixture.directory, "task-event-ids.json"),
      TASKCENTER_TASK_RECONCILE_PATH: join(fixture.directory, "task-reconcile.jsonl"),
      TASKCENTER_SESSION_REGISTRY_PATH: join(fixture.directory, "session-registry.json"),
      TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => child.kill("SIGTERM"));
  await waitForReady(child);

  const decide = async (action) => {
    const response = await fetch(`http://127.0.0.1:${port}/requirements/partial-feature/decision`, {
      method: "POST",
      headers: actionHeaders(),
      body: JSON.stringify({ action }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).override;
  };

  assert.equal((await decide("complete")).status, "verified");
  assert.equal((await decide("remove")).hidden, true);
  assert.equal((await decide("restore")).hidden, false);
  const persisted = JSON.parse(await readFile(overridesPath, "utf8"));
  assert.equal(persisted["partial-feature"].status, "verified");
  assert.equal(persisted["partial-feature"].hidden, false);
  assert.equal(persisted["partial-feature"].source, "manual");
});

test("退休执行入口返回 404，服务启动和等待不修改历史队列或回执", async (context) => {
  const fixture = await createFixture();
  const pilotEventsPath = join(fixture.directory, "pilot-events.jsonl");
  const created = createPilotIntent(pilotEventsPath, { request_id: "019f0000-0000-7000-8000-000000000006", project_id: "atlas", workspace: fixture.projectDirectory, action: "enable" });
  updatePilotIntent(pilotEventsPath, created.intent.intent_id, "processing");
  updatePilotIntent(pilotEventsPath, created.intent.intent_id, "succeeded", { observed_state: "enabled" });
  await writeFile(fixture.dispatchesPath, JSON.stringify([{ id: "legacy-pilot-dispatch", pilotIntentId: created.intent.intent_id, status: "queued", error: "", updatedAt: "2026-09-08T00:00:00.000Z" }]));
  const beforeDispatches = await readFile(fixture.dispatchesPath, "utf8");
  const beforePilot = await readFile(pilotEventsPath, "utf8");
  const bugQueuePath = join(fixture.directory, "bug-dispatches.json");
  const legacyBugQueue = '[{"id":"old-bug","status":"queued"}]';
  await writeFile(bugQueuePath, legacyBugQueue);
  const port = 37_000 + (process.pid % 1_000);
  const child = spawn(process.execPath, ["scripts/control-server.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      TASKCENTER_CONTROL_PORT: String(port),
      TASKCENTER_DASHBOARD_PATH: fixture.dashboardPath,
      TASKCENTER_DISPATCHES_PATH: fixture.dispatchesPath,
      TASKCENTER_CONTEXT_MANAGEMENT_PILOT_EVENTS_PATH: pilotEventsPath,
      TASKCENTER_BUG_DISPATCHES_PATH: bugQueuePath,
      TASKCENTER_SESSION_REGISTRY_PATH: join(fixture.directory, "session-registry.json"),
      TASKCENTER_TASK_LEDGER_PATH: join(fixture.directory, "task-ledger.json"),
      TASKCENTER_DELEGATIONS_PATH: join(fixture.directory, "delegations.json"),
      TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => child.kill("SIGTERM"));
  await waitForReady(child);
  const events = (await readFile(pilotEventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.at(-1).status, "succeeded");
  assert.equal(await readFile(fixture.dispatchesPath, "utf8"), beforeDispatches);
  for (const path of ["/dispatch", "/dispatches/legacy-pilot-dispatch/cancel", "/context-management-pilots/intents", "/reflections/reflection-evidence-gap/execute"]) {
    assert.equal((await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: actionHeaders(), body: "{}" })).status, 404);
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/routing/model-catalog`)).status, 404);
  await new Promise(resolve => setTimeout(resolve, 5_100));
  assert.equal(await readFile(fixture.dispatchesPath, "utf8"), beforeDispatches);
  assert.equal(await readFile(pilotEventsPath, "utf8"), beforePilot);
  assert.equal(await readFile(bugQueuePath, "utf8"), legacyBugQueue);
  const history = await (await fetch(`http://127.0.0.1:${port}/dispatches`)).json();
  assert.equal(history.dispatches[0].status, "queued");
});

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("控制服务启动超时")), 5_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`控制服务提前退出：${code}`));
    });
    child.stdout.on("data", (chunk) => {
      if (!String(chunk).includes("TaskCenter control server is listening")) return;
      clearTimeout(timer);
      resolve();
    });
  });
}

function actionHeaders() {
  return {
    "Content-Type": "application/json",
    "Origin": "http://localhost:3000",
    "X-TaskCenter-Action": "delegate",
  };
}
