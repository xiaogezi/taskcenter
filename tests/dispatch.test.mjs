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

test("本地控制服务 dry-run 会记录操作但不会启动 Codex", async (context) => {
  const fixture = await createFixture();
  const brainDirectory = join(fixture.directory, "DevWorkbench");
  const registryPath = join(fixture.directory, "session-registry.json");
  const ledgerPath = join(fixture.directory, "task-ledger.json");
  const pilotEventsPath = join(fixture.directory, "context-management-pilot-events.jsonl");
  await mkdir(brainDirectory, { recursive: true });
  await writeFile(registryPath, JSON.stringify({
    [threadId]: { sessionId: threadId, projectId: "devworkbench", workspace: brainDirectory },
    "00000000-0000-4000-8000-000000000002": { sessionId: "00000000-0000-4000-8000-000000000002", projectId: "atlas", workspace: fixture.projectDirectory },
  }));
  await writeFile(ledgerPath, JSON.stringify([{ id: "brain-task", sessionId: threadId, workspace: brainDirectory, status: "in_progress", updatedAt: "2026-09-08T00:00:00.000Z" }]));
  const port = 32_000 + (process.pid % 1_000);
  const child = spawn(process.execPath, ["scripts/control-server.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      TASKCENTER_CONTROL_PORT: String(port),
      TASKCENTER_DELEGATIONS_PATH: join(fixture.directory, "delegations.json"),
      TASKCENTER_DASHBOARD_PATH: fixture.dashboardPath,
      TASKCENTER_DISPATCHES_PATH: fixture.dispatchesPath,
      TASKCENTER_SESSION_REGISTRY_PATH: registryPath,
      TASKCENTER_TASK_LEDGER_PATH: ledgerPath,
      TASKCENTER_CONTEXT_MANAGEMENT_PILOT_EVENTS_PATH: pilotEventsPath,
      TASKCENTER_LOCAL_DIR: join(fixture.directory, "local"),
      TASKCENTER_DISPATCH_DRY_RUN: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => child.kill("SIGTERM"));
  await waitForReady(child);

  const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "http://localhost:3000",
      "X-TaskCenter-Action": "delegate",
    },
    body: JSON.stringify({ requirementId: "partial-feature", threadId }),
  });
  assert.equal(response.status, 202);
  const payload = await response.json();
  assert.equal(payload.dispatch.status, "dry_run");
  assert.equal(payload.dispatch.mode, "new_session");

  const persisted = JSON.parse(await readFile(fixture.dispatchesPath, "utf8"));
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].requirementId, "partial-feature");

  const pilotResponse = await fetch(`http://127.0.0.1:${port}/context-management-pilots/intents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "http://localhost:3000",
      "X-TaskCenter-Action": "delegate",
    },
    body: JSON.stringify({ request_id: "019f0000-0000-7000-8000-000000000004", project_id: "atlas", workspace: fixture.projectDirectory, action: "refresh" }),
  });
  assert.equal(pilotResponse.status, 202);
  const pilotSnapshot = await (await fetch(`http://127.0.0.1:${port}/context-management-pilots`)).json();
  assert.equal(pilotSnapshot.projects.find((item) => item.project_id === "atlas").latest_intent.status, "failed");
  assert.equal(JSON.parse(await readFile(fixture.dispatchesPath, "utf8")).length, 1);
});

test("原 Session 忙碌时进入安全队列", async (context) => {
  const fixture = await createFixture();
  const sessionsRoot = join(fixture.directory, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(join(sessionsRoot, `rollout-${threadId}.jsonl`), [
    JSON.stringify({ timestamp: "2026-07-19T00:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-active" } }),
    "",
  ].join("\n"));
  const port = 33_000 + (process.pid % 1_000);
  const child = spawn(process.execPath, ["scripts/control-server.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      TASKCENTER_CONTROL_PORT: String(port),
      TASKCENTER_DELEGATIONS_PATH: join(fixture.directory, "delegations.json"),
      TASKCENTER_DASHBOARD_PATH: fixture.dashboardPath,
      TASKCENTER_DISPATCHES_PATH: fixture.dispatchesPath,
      TASKCENTER_SESSIONS_ROOT: sessionsRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => child.kill("SIGTERM"));
  await waitForReady(child);

  const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "http://localhost:3000",
      "X-TaskCenter-Action": "delegate",
    },
    body: JSON.stringify({ requirementId: "partial-feature", threadId, mode: "existing_session" }),
  });
  assert.equal(response.status, 202);
  const payload = await response.json();
  assert.equal(payload.dispatch.status, "queued");
  assert.match(payload.dispatch.error, /正在处理 1 个 turn/);

  const persisted = JSON.parse(await readFile(fixture.dispatchesPath, "utf8"));
  assert.equal(persisted[0].status, "queued");
  assert.match(persisted[0].pendingPrompt, /还缺失败反馈和回归测试/);
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
  await writeFile(sessionPath, `${await readFile(sessionPath, "utf8")}${JSON.stringify({
    timestamp: "2026-07-19T00:00:03.000Z",
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "turn-2" },
  })}\n`);
  assert.equal(inspectSessionState(threadId, sessionsRoot).busy, false);
});

test("等待中的自动投递可以人工取消", async (context) => {
  const fixture = await createFixture();
  const sessionsRoot = join(fixture.directory, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(join(sessionsRoot, `rollout-${threadId}.jsonl`), `${JSON.stringify({
    timestamp: "2026-07-19T00:00:00.000Z",
    type: "event_msg",
    payload: { type: "task_started", turn_id: "turn-active" },
  })}\n`);
  const port = 36_000 + (process.pid % 1_000);
  const child = spawn(process.execPath, ["scripts/control-server.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      TASKCENTER_CONTROL_PORT: String(port),
      TASKCENTER_DELEGATIONS_PATH: join(fixture.directory, "delegations.json"),
      TASKCENTER_DASHBOARD_PATH: fixture.dashboardPath,
      TASKCENTER_DISPATCHES_PATH: fixture.dispatchesPath,
      TASKCENTER_SESSIONS_ROOT: sessionsRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => child.kill("SIGTERM"));
  await waitForReady(child);

  const queuedResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
    method: "POST",
    headers: actionHeaders(),
    body: JSON.stringify({ requirementId: "partial-feature", threadId, mode: "existing_session" }),
  });
  const queued = (await queuedResponse.json()).dispatch;
  const cancelResponse = await fetch(`http://127.0.0.1:${port}/dispatches/${queued.id}/cancel`, {
    method: "POST",
    headers: actionHeaders(),
    body: "{}",
  });
  assert.equal(cancelResponse.status, 200);
  const cancelled = (await cancelResponse.json()).dispatch;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.pendingPrompt, undefined);
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

test("空闲原 Session 通过 Codex CLI 追加并完成 JSONL 验证", async (context) => {
  const fixture = await createFixture();
  const sessionsRoot = join(fixture.directory, "sessions");
  const sessionPath = join(sessionsRoot, `rollout-${threadId}.jsonl`);
  const fakeCli = join(fixture.directory, "fake-codex-cli.mjs");
  const capturePath = join(fixture.directory, "cli-capture.json");
  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(sessionPath, "");
  await writeFile(fakeCli, `
import { appendFileSync, writeFileSync } from "node:fs";
const [, , resumedThreadId, prompt, jsonFlag] = process.argv.slice(2);
writeFileSync(process.env.TASKCENTER_CLI_CAPTURE, JSON.stringify({ resumedThreadId, prompt, jsonFlag }));
const timestamp = new Date().toISOString();
const turnId = "turn-from-fake-cli";
appendFileSync(process.env.TASKCENTER_FAKE_SESSION, [
  JSON.stringify({ timestamp, type: "event_msg", payload: { type: "user_message", message: prompt } }),
  JSON.stringify({ timestamp, type: "event_msg", payload: { type: "task_started", turn_id: turnId } }),
  JSON.stringify({ timestamp, type: "event_msg", payload: { type: "task_complete", turn_id: turnId } }),
  "",
].join("\\n"));
console.log(JSON.stringify({ type: "thread.started", thread_id: resumedThreadId }));
console.log(JSON.stringify({ type: "turn.started" }));
console.log(JSON.stringify({ type: "turn.completed" }));
`);
  const port = 35_000 + (process.pid % 1_000);
  const child = spawn(process.execPath, ["scripts/control-server.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      TASKCENTER_CONTROL_PORT: String(port),
      TASKCENTER_DELEGATIONS_PATH: join(fixture.directory, "delegations.json"),
      TASKCENTER_DASHBOARD_PATH: fixture.dashboardPath,
      TASKCENTER_DISPATCHES_PATH: fixture.dispatchesPath,
      TASKCENTER_SESSIONS_ROOT: sessionsRoot,
      TASKCENTER_CODEX_COMMAND: process.execPath,
      TASKCENTER_CODEX_PREFIX_ARGS: JSON.stringify([fakeCli]),
      TASKCENTER_CLI_CAPTURE: capturePath,
      TASKCENTER_FAKE_SESSION: sessionPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => child.kill("SIGTERM"));
  await waitForReady(child);

  const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "http://localhost:3000",
      "X-TaskCenter-Action": "delegate",
    },
    body: JSON.stringify({ requirementId: "partial-feature", threadId, mode: "existing_session" }),
  });
  assert.equal(response.status, 202);
  const completed = await waitForDispatchStatus(port, "completed");
  assert.match(completed.error, /已完成本次 turn/);

  const capture = JSON.parse(await readFile(capturePath, "utf8"));
  assert.equal(capture.resumedThreadId, threadId);
  assert.equal(capture.jsonFlag, "--json");
  assert.match(capture.prompt, /还缺失败反馈和回归测试/);
});

test("本地控制服务能新建注入上下文的 Codex Session", async (context) => {
  const fixture = await createFixture();
  const fakeSdk = join(fixture.directory, "fake-codex-sdk.mjs");
  const capturePath = join(fixture.directory, "sdk-capture-new.json");
  const newThreadId = "019f8000-0000-7000-8000-000000000001";
  await writeFile(fakeSdk, `
import { writeFileSync } from "node:fs";
export class Codex {
  startThread(options) {
    return {
      runStreamed: async (prompt) => {
        writeFileSync(process.env.TASKCENTER_SDK_CAPTURE, JSON.stringify({ mode: "new_session", options, prompt }));
        return {
          events: (async function* () {
            yield { type: "thread.started", thread_id: "${newThreadId}" };
            yield { type: "turn.completed" };
          })(),
        };
      },
    };
  }
  resumeThread() {
    throw new Error("新建模式不应恢复原 Session");
  }
}
`);
  const port = 34_000 + (process.pid % 1_000);
  const child = spawn(process.execPath, ["scripts/control-server.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      TASKCENTER_CONTROL_PORT: String(port),
      TASKCENTER_DELEGATIONS_PATH: join(fixture.directory, "delegations.json"),
      TASKCENTER_DASHBOARD_PATH: fixture.dashboardPath,
      TASKCENTER_DISPATCHES_PATH: fixture.dispatchesPath,
      TASKCENTER_CODEX_SDK_MODULE: fakeSdk,
      TASKCENTER_SDK_CAPTURE: capturePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => child.kill("SIGTERM"));
  await waitForReady(child);

  const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "http://localhost:3000",
      "X-TaskCenter-Action": "delegate",
    },
    body: JSON.stringify({ requirementId: "partial-feature", threadId, mode: "new_session" }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.dispatch.status, "delivered");
  assert.equal(payload.dispatch.mode, "new_session");
  assert.equal(payload.dispatch.contextThreadId, threadId);
  assert.equal(payload.dispatch.threadId, newThreadId);
  assert.equal(payload.dispatch.threadTitle, "新任务：部分完成能力");

  const capture = JSON.parse(await readFile(capturePath, "utf8"));
  assert.equal(capture.mode, "new_session");
  assert.equal(capture.options.workingDirectory, fixture.projectDirectory);
  assert.match(capture.prompt, /已完成概况：主流程已经存在/);
  assert.match(capture.prompt, /剩余缺口：还缺失败反馈和回归测试/);
  assert.doesNotMatch(capture.prompt, /<codex_delegation>/);
});

test("试点主脑 turn 结束但无回执时转为 failed 并允许重试", async (context) => {
  const fixture = await createFixture();
  const brainDirectory = join(fixture.directory, "DevWorkbench");
  const sessionsRoot = join(fixture.directory, "sessions");
  const sessionPath = join(sessionsRoot, `rollout-${threadId}.jsonl`);
  const registryPath = join(fixture.directory, "session-registry.json");
  const ledgerPath = join(fixture.directory, "task-ledger.json");
  const fakeCli = join(fixture.directory, "fake-pilot-cli.mjs");
  await mkdir(brainDirectory, { recursive: true });
  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(sessionPath, "");
  await writeFile(registryPath, JSON.stringify({
    [threadId]: { sessionId: threadId, projectId: "devworkbench", workspace: brainDirectory },
    "00000000-0000-4000-8000-000000000002": { sessionId: "00000000-0000-4000-8000-000000000002", projectId: "atlas", workspace: fixture.projectDirectory },
  }));
  await writeFile(ledgerPath, JSON.stringify([{ id: "brain-task", sessionId: threadId, workspace: brainDirectory, status: "in_progress", updatedAt: "2026-09-08T00:00:00.000Z" }]));
  await writeFile(fakeCli, `
import { appendFileSync } from "node:fs";
const [, , resumedThreadId, prompt] = process.argv.slice(2);
const timestamp = new Date().toISOString();
appendFileSync(process.env.TASKCENTER_FAKE_SESSION, JSON.stringify({ timestamp, type: "event_msg", payload: { type: "user_message", message: prompt } }) + "\\n");
console.log(JSON.stringify({ type: "thread.started", thread_id: resumedThreadId }));
console.log(JSON.stringify({ type: "turn.started" }));
console.log(JSON.stringify({ type: "turn.completed" }));
`);
  const port = 36_000 + (process.pid % 1_000);
  const child = spawn(process.execPath, ["scripts/control-server.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      TASKCENTER_CONTROL_PORT: String(port),
      TASKCENTER_DELEGATIONS_PATH: join(fixture.directory, "delegations.json"),
      TASKCENTER_DASHBOARD_PATH: fixture.dashboardPath,
      TASKCENTER_DISPATCHES_PATH: fixture.dispatchesPath,
      TASKCENTER_SESSION_REGISTRY_PATH: registryPath,
      TASKCENTER_TASK_LEDGER_PATH: ledgerPath,
      TASKCENTER_CONTEXT_MANAGEMENT_PILOT_EVENTS_PATH: join(fixture.directory, "pilot-events.jsonl"),
      TASKCENTER_SESSIONS_ROOT: sessionsRoot,
      TASKCENTER_CODEX_COMMAND: process.execPath,
      TASKCENTER_CODEX_PREFIX_ARGS: JSON.stringify([fakeCli]),
      TASKCENTER_FAKE_SESSION: sessionPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => child.kill("SIGTERM"));
  await waitForReady(child);
  const response = await fetch(`http://127.0.0.1:${port}/context-management-pilots/intents`, {
    method: "POST",
    headers: actionHeaders(),
    body: JSON.stringify({ request_id: "019f0000-0000-7000-8000-000000000005", project_id: "atlas", workspace: fixture.projectDirectory, action: "refresh" }),
  });
  assert.equal(response.status, 202);
  const failed = await waitForPilotStatus(port, "atlas", "failed");
  assert.match(failed.message, /未回写终态/);
});

test("服务重启保留已成功的试点回执并只终止遗留 dispatch", async (context) => {
  const fixture = await createFixture();
  const pilotEventsPath = join(fixture.directory, "pilot-events.jsonl");
  const created = createPilotIntent(pilotEventsPath, { request_id: "019f0000-0000-7000-8000-000000000006", project_id: "atlas", workspace: fixture.projectDirectory, action: "enable" });
  updatePilotIntent(pilotEventsPath, created.intent.intent_id, "processing");
  updatePilotIntent(pilotEventsPath, created.intent.intent_id, "succeeded", { observed_state: "enabled" });
  await writeFile(fixture.dispatchesPath, JSON.stringify([{ id: "legacy-pilot-dispatch", pilotIntentId: created.intent.intent_id, status: "running", error: "", updatedAt: "2026-09-08T00:00:00.000Z" }]));
  const port = 37_000 + (process.pid % 1_000);
  const child = spawn(process.execPath, ["scripts/control-server.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      TASKCENTER_CONTROL_PORT: String(port),
      TASKCENTER_DASHBOARD_PATH: fixture.dashboardPath,
      TASKCENTER_DISPATCHES_PATH: fixture.dispatchesPath,
      TASKCENTER_CONTEXT_MANAGEMENT_PILOT_EVENTS_PATH: pilotEventsPath,
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
  assert.equal(JSON.parse(await readFile(fixture.dispatchesPath, "utf8"))[0].status, "failed");
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

async function waitForDispatchStatus(port, status) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/dispatches`);
    const payload = await response.json();
    if (payload.dispatches?.[0]?.status === status) return payload.dispatches[0];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待投递状态 ${status} 超时`);
}

async function waitForPilotStatus(port, projectId, status) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const payload = await (await fetch(`http://127.0.0.1:${port}/context-management-pilots`)).json();
    const intent = payload.projects?.find((item) => item.project_id === projectId)?.latest_intent;
    if (intent?.status === status) return intent;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待试点状态 ${status} 超时`);
}

function actionHeaders() {
  return {
    "Content-Type": "application/json",
    "Origin": "http://localhost:3000",
    "X-TaskCenter-Action": "delegate",
  };
}
