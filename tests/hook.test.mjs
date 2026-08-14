import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const root = new URL("../", import.meta.url);
const tempDir = await mkdtemp(join(tmpdir(), "taskcenter-hook-"));
const paths = {
  TASKCENTER_TASK_EVENTS_PATH: join(tempDir, "task-events.jsonl"),
  TASKCENTER_TASK_LEDGER_PATH: join(tempDir, "task-ledger.json"),
  TASKCENTER_TASK_EVENT_IDS_PATH: join(tempDir, "task-event-ids.json"),
  TASKCENTER_TASK_RECONCILE_PATH: join(tempDir, "task-reconcile.jsonl"),
  TASKCENTER_SESSION_REGISTRY_PATH: join(tempDir, "session-registry.json"),
};
const port = 39_000 + (process.pid % 1_000);
const base = `http://127.0.0.1:${port}`;
const hook = join(root.pathname, "scripts", "taskcenter-hook.mjs");
const server = spawn(process.execPath, ["scripts/control-server.mjs"], {
  cwd: root,
  env: { ...process.env, ...paths, TASKCENTER_CONTROL_PORT: String(port), TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});

await waitForReady();
after(async () => {
  server.kill("SIGTERM");
  await rm(tempDir, { recursive: true, force: true });
});

test("SessionStart Hook 登记真实会话且可幂等重放", async () => {
  const first = await runHook("session-start", "claude", { session_id: "hook-session", cwd: "/work" });
  const second = await runHook("session-start", "claude", { session_id: "hook-session", cwd: "/work" });
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  const status = await getStatus("hook-session");
  assert.equal(status.status, "registered");
  assert.equal(status.agent, "claude");
});

test("Context task ensure 跨 Turn 幂等复用，complete 后可按仍活跃语义重新进入", async () => {
  const body = {
    context_task_id: "context-hook-semantic",
    session_id: "context-hook-session",
    workspace: "/work",
    semantic_label: "多环境数据生命周期设计",
    agent: "codex",
  };
  const first = await fetch(`${base}/context-tasks/ensure`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "hook" },
    body: JSON.stringify(body),
  });
  const firstPayload = await first.json();
  assert.equal(first.status, 201);
  assert.equal(firstPayload.task.contextTaskId, body.context_task_id);
  const visibleTasks = await (await fetch(`${base}/tasks`)).json();
  assert.equal(visibleTasks.tasks.some((task) => task.id === firstPayload.task.id), false);
  const shadowOnlyWrite = await runHook("pre-tool-use", "codex", {
    session_id: body.session_id,
    cwd: body.workspace,
    tool_name: "exec_command",
    tool_use_id: "shadow-only-write",
  });
  assert.equal(shadowOnlyWrite.code, 2);

  const second = await fetch(`${base}/context-tasks/ensure`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "hook" },
    body: JSON.stringify(body),
  });
  const secondPayload = await second.json();
  assert.equal(second.status, 200);
  assert.equal(secondPayload.task.id, firstPayload.task.id);

  const completed = await fetch(`${base}/context-tasks/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "hook" },
    body: JSON.stringify({ context_task_id: body.context_task_id, summary: "语义目标完成" }),
  });
  assert.equal((await completed.json()).completed[0].status, "done_claimed");

  const resumed = await fetch(`${base}/context-tasks/ensure`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "hook" },
    body: JSON.stringify(body),
  });
  const resumedPayload = await resumed.json();
  assert.equal(resumedPayload.reactivated, true);
  assert.equal(resumedPayload.task.id, firstPayload.task.id);
  assert.equal(resumedPayload.task.status, "in_progress");
});

test("PreToolUse 未登记或未建任务时阻断，建任务后放行", async () => {
  const missing = await runHook("pre-tool-use", "codex", { session_id: "unknown-session", cwd: "/work" });
  assert.equal(missing.code, 2);

  const readOnly = await runHook("pre-tool-use", "codex", {
    session_id: "unknown-session",
    cwd: "/work",
    tool_name: "Bash",
    tool_input: { cmd: "rg -n TODO src" },
  });
  assert.equal(readOnly.code, 0);
  assert.match(readOnly.stdout, /只读检查放行/);

  for (const cmd of [
    "sed -n -i backup '1p' README.md",
    "sed -n -i.bak '1p' README.md",
    "sed -n '1w leak.txt' README.md",
    "git diff --output=leak.patch",
    "git show --output leak.txt HEAD:README.md",
  ]) {
    const disguisedWrite = await runHook("pre-tool-use", "codex", {
      session_id: "unknown-session",
      cwd: "/work",
      tool_name: "Bash",
      tool_input: { cmd },
    });
    assert.equal(disguisedWrite.code, 2, `${cmd} 不得作为只读命令放行`);
  }

  const shellWrite = await runHook("pre-tool-use", "codex", {
    session_id: "unknown-session",
    cwd: "/work",
    tool_name: "Bash",
    tool_input: { cmd: "rm generated.txt" },
  });
  assert.equal(shellWrite.code, 2);

  const registered = await runHook("session-start", "codex", { session_id: "gate-session", cwd: "/work" });
  assert.equal(registered.code, 0);
  const empty = await runHook("pre-tool-use", "codex", { session_id: "gate-session", cwd: "/work" });
  assert.equal(empty.code, 2);

  const created = await fetch(`${base}/task-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "mcp" },
    body: JSON.stringify({
      type: "task.create",
      event_id: "hook-gate-task-create",
      task_id: "hook-gate-task",
      session_id: "gate-session",
      agent: "codex",
      provider: "openai",
      model: "gpt-test",
      title: "Hook 门禁测试",
      goal: "确认写操作前已有任务",
    }),
  });
  assert.equal(created.status, 201);
  const interactive = await runHook("pre-tool-use", "codex", {
    session_id: "gate-session",
    cwd: "/work",
    tool_name: "exec_command",
    tool_input: { cmd: "zsh", tty: true },
  });
  assert.equal(interactive.code, 2);
  assert.match(interactive.stderr, /不允许启动.*交互式命令/);
  const allowed = await runHook("pre-tool-use", "codex", { session_id: "gate-session", cwd: "/work", tool_name: "exec_command", tool_use_id: "stable-call-1" });
  assert.equal(allowed.code, 0);
  const tasks = await (await fetch(`${base}/tasks`)).json();
  assert.equal(tasks.tasks.find((task) => task.id === "hook-gate-task").toolCalls.exec_command, 1);
  const replay = await runHook("pre-tool-use", "codex", { session_id: "gate-session", cwd: "/work", tool_name: "exec_command", tool_use_id: "stable-call-1" });
  assert.equal(replay.code, 0);
  const afterReplay = await (await fetch(`${base}/tasks`)).json();
  assert.equal(afterReplay.tasks.find((task) => task.id === "hook-gate-task").toolCalls.exec_command, 1);
  await fetch(`${base}/task-events`, { method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "mcp" }, body: JSON.stringify({ type: "task.report", event_id: "hook-gate-done", task_id: "hook-gate-task", session_id: "gate-session", status: "done_claimed" }) });
  const noActive = await runHook("pre-tool-use", "codex", { session_id: "gate-session", cwd: "/work", tool_name: "exec_command", tool_use_id: "stable-call-2" });
  assert.equal(noActive.code, 2);
  assert.match(noActive.stderr, /无活跃任务/);
});

async function runHook(action, agent, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hook, action, "--agent", agent], {
      cwd: root,
      env: { ...process.env, TASKCENTER_CONTROL_URL: base },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function getStatus(sessionId) {
  const response = await fetch(`${base}/session-status`);
  const body = await response.json();
  return body.sessions.find((session) => session.sessionId === sessionId);
}

async function waitForReady() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("隔离控制服务启动超时。");
}
