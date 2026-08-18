import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const rootPath = resolve(fileURLToPath(root));
const tempDir = await mkdtemp(join(tmpdir(), "taskcenter-hook-"));
const paths = {
  TASKCENTER_TASK_EVENTS_PATH: join(tempDir, "task-events.jsonl"),
  TASKCENTER_TASK_LEDGER_PATH: join(tempDir, "task-ledger.json"),
  TASKCENTER_TASK_EVENT_IDS_PATH: join(tempDir, "task-event-ids.json"),
  TASKCENTER_TASK_RECONCILE_PATH: join(tempDir, "task-reconcile.jsonl"),
  TASKCENTER_SESSION_REGISTRY_PATH: join(tempDir, "session-registry.json"),
  TASKCENTER_GATE_SESSION_ALLOWLIST_PATH: join(tempDir, "gate-session-allowlist.json"),
  TASKCENTER_DELEGATIONS_PATH: join(tempDir, "delegations.json"),
};
const port = 39_000 + (process.pid % 1_000);
const base = `http://127.0.0.1:${port}`;
const hook = join(rootPath, "scripts", "taskcenter-hook.mjs");
const server = spawn(process.execPath, ["scripts/control-server.mjs"], {
  cwd: root,
  env: { ...process.env, ...paths, TASKCENTER_CONTROL_PORT: String(port), TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});

test("控制服务离线时只放行固定恢复命令", async () => {
  for (const command of [
    "/bin/bash scripts/taskcenter-control.sh start",
    "/bin/bash scripts/taskcenter-control.sh status",
  ]) {
    const allowed = await runHook("pre-tool-use", "codex", {
      session_id: "",
      cwd: rootPath,
      tool_name: "Bash",
      hook_event_name: "PreToolUse",
      tool_input: { command },
    });
    assert.equal(allowed.code, 0, `${command} 应作为固定恢复命令放行`);
    assert.match(allowed.stdout, /固定恢复命令放行/);
  }

  for (const command of [
    "bash scripts/taskcenter-control.sh start",
    "/usr/bin/env bash scripts/taskcenter-control.sh start",
    "bash scripts/taskcenter-control.sh restart",
    "bash scripts/taskcenter-control.sh stop",
    "bash scripts/taskcenter-control.sh start extra",
    "bash scripts/taskcenter-control.sh start && touch /tmp/bypass",
    "bash ./scripts/taskcenter-control.sh start",
    "bash /tmp/scripts/taskcenter-control.sh start",
  ]) {
    const blocked = await runHook("pre-tool-use", "codex", {
      session_id: "",
      cwd: rootPath,
      tool_name: "Bash",
      hook_event_name: "PreToolUse",
      tool_input: { command },
    });
    assert.equal(blocked.code, 2, `${command} 不得进入恢复白名单`);
  }

  const wrongWorkspace = await runHook("pre-tool-use", "codex", {
    session_id: "",
    cwd: "/tmp",
    tool_name: "Bash",
    hook_event_name: "PreToolUse",
    tool_input: { command: "/bin/bash scripts/taskcenter-control.sh start" },
  });
  assert.equal(wrongWorkspace.code, 2);

  const missingWorkspace = await runHook("pre-tool-use", "codex", {
    session_id: "",
    tool_name: "Bash",
    hook_event_name: "PreToolUse",
    tool_input: { command: "/bin/bash scripts/taskcenter-control.sh start" },
  });
  assert.equal(missingWorkspace.code, 2);
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

test("L0 仅向已登记且无任务 Session 放行确定性只读命令", async () => {
  const sessionId = "019f0000-0000-7000-8000-000000000089";
  assert.equal((await runHook("session-start", "codex", { session_id: sessionId, cwd: "/work" })).code, 0);
  for (const command of ["pwd", "cat README.md", "sed -n '1,2p' README.md", "sed -n '/hello/p' README.md", "git status", "git diff", "git ls-files", "find . -maxdepth 1", "rtk rg TaskCenter README.md"]) {
    const allowed = await runHook("pre-tool-use", "codex", { session_id: sessionId, cwd: "/work", tool_name: "exec_command", tool_input: { cmd: command } });
    assert.equal(allowed.code, 0, command);
    assert.match(allowed.stdout, /L0/);
  }
  for (const command of ["touch x", "rm x", "mv x y", "sed -i s/a/b/ x", "sed -ni s/a/b/ x", "sed -n '1w leak.txt' x", "git commit -m x", "git diff --output=leak", "npm test", "pwd; ls", "cat x | head", "cat x > y", "echo $(pwd)", "find . -delete", "find . -exec touch x ;", "find . -fprint leak", "bash -c 'pwd'", "python -c 'print(1)'"]) {
    const blocked = await runHook("pre-tool-use", "codex", { session_id: sessionId, cwd: "/work", tool_name: "exec_command", tool_input: { cmd: command } });
    assert.equal(blocked.code, 2, command);
    assert.match(blocked.stderr, /不满足 L0 确定性只读规则/);
  }
  for (const tool_name of ["Read", "Grep", "Glob"]) {
    const allowed = await runHook("pre-tool-use", "codex", { session_id: sessionId, cwd: "/work", tool_name, tool_input: { path: "README.md" } });
    assert.equal(allowed.code, 0, tool_name);
  }
  const patch = await runHook("pre-tool-use", "codex", { session_id: sessionId, cwd: "/work", tool_name: "apply_patch", tool_input: { patch: "*** Begin Patch\n*** End Patch" } });
  assert.equal(patch.code, 2);
  const unregistered = await runHook("pre-tool-use", "codex", { session_id: "unregistered-l0", cwd: "/work", tool_name: "exec_command", tool_input: { cmd: "pwd" } });
  assert.equal(unregistered.code, 2);
  assert.match(unregistered.stderr, /尚未登记/);
  const tasks = (await (await fetch(`${base}/tasks`)).json()).tasks;
  assert.equal(tasks.length, 0);
});

test("UserPromptSubmit 在非白名单 Session 无活跃任务时前置提醒 Agent 建任务", async () => {
  const sessionId = "019f0000-0000-7000-8000-000000000090";
  const registered = await runHook("session-start", "codex", { session_id: sessionId, cwd: "/work" });
  assert.equal(registered.code, 0);

  const missingTask = await runHook("user-prompt-submit", "codex", {
    session_id: sessionId,
    cwd: "/work",
    hook_event_name: "UserPromptSubmit",
    prompt: "修改一个文件",
  });
  assert.equal(missingTask.code, 0);
  const context = JSON.parse(missingTask.stdout);
  assert.equal(context.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(context.hookSpecificOutput.additionalContext, /主 Agent.*taskcenter_task_create/);
  assert.match(context.hookSpecificOutput.additionalContext, /CLI 派发执行器.*delegation/);
  assert.match(context.hookSpecificOutput.additionalContext, /不要要求用户手动创建任务/);

  const allowlistedSessionId = "019f0000-0000-7000-8000-000000000091";
  const allowlistedResponse = await fetch(`${base}/gate-session-allowlist`, {
    method: "POST",
    headers: { Origin: "http://localhost:3000", "Content-Type": "application/json", "X-TaskCenter-Action": "delegate" },
    body: JSON.stringify({ threadIds: [allowlistedSessionId] }),
  });
  assert.equal(allowlistedResponse.status, 200);
  const allowlisted = await runHook("user-prompt-submit", "codex", {
    session_id: allowlistedSessionId,
    cwd: "/work",
    hook_event_name: "UserPromptSubmit",
    prompt: "修改一个文件",
  });
  assert.equal(allowlisted.code, 0);
  assert.equal(allowlisted.stdout, "");
  const resetAllowlist = await fetch(`${base}/gate-session-allowlist`, {
    method: "POST",
    headers: { Origin: "http://localhost:3000", "Content-Type": "application/json", "X-TaskCenter-Action": "delegate" },
    body: JSON.stringify({ threadIds: [] }),
  });
  assert.equal(resetAllowlist.status, 200);

  const created = await fetch(`${base}/task-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "mcp" },
    body: JSON.stringify({
      type: "task.create",
      event_id: "prompt-preparation-task-create",
      task_id: "prompt-preparation-task",
      session_id: sessionId,
      agent: "codex",
      provider: "openai",
      model: "gpt-test",
      title: "前置任务准备测试",
      goal: "确认有活跃任务时不再注入提醒",
    }),
  });
  assert.equal(created.status, 201);
  const active = await runHook("user-prompt-submit", "codex", {
    session_id: sessionId,
    cwd: "/work",
    hook_event_name: "UserPromptSubmit",
    prompt: "继续修改",
  });
  assert.equal(active.code, 0);
  assert.equal(active.stdout, "");
});

test("CLI Session 领取 delegation 后通过主任务门禁且不创建子任务", async () => {
  const parentSessionId = "019f0000-0000-7000-8000-000000000092";
  const cliSessionId = "019f0000-0000-7000-8000-000000000093";
  assert.equal((await runHook("session-start", "codex", { session_id: parentSessionId, cwd: "/work" })).code, 0);
  assert.equal((await runHook("session-start", "codex", { session_id: cliSessionId, cwd: "/work" })).code, 0);
  const created = await fetch(`${base}/task-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "mcp" },
    body: JSON.stringify({ type: "task.create", event_id: "hook-delegation-task-create", task_id: "hook-delegation-task", session_id: parentSessionId, title: "CLI 附着主任务", goal: "验证 delegation 门禁", workspace: "/work" }),
  });
  assert.equal(created.status, 201);
  const grantResponse = await fetch(`${base}/delegations/grant`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "mcp" },
    body: JSON.stringify({ parent_session_id: parentSessionId, task_id: "hook-delegation-task", event_id: "hook-delegation-grant", workspace: "/work", scope: ["."], allowed_tools: ["exec_command"], executor_model: "gpt-5.3-codex-spark", channel: "cli", ttl_seconds: 600 }),
  });
  assert.equal(grantResponse.status, 201);
  const grant = await grantResponse.json();
  const claim = await fetch(`${base}/delegations/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "mcp" },
    body: JSON.stringify({ delegation_id: grant.delegation.id, claim_token: grant.claimToken, session_id: cliSessionId, workspace: "/work" }),
  });
  const claimPayload = await claim.json();
  assert.equal(claim.status, 200, claimPayload.error);

  const allowed = await runHook("pre-tool-use", "codex", {
    session_id: cliSessionId,
    cwd: "/work",
    tool_name: "exec_command",
    tool_use_id: "delegated-true",
    tool_input: { cmd: "true" },
  });
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.match(allowed.stdout, /delegation 放行/);
  const tasks = (await (await fetch(`${base}/tasks`)).json()).tasks;
  assert.equal(tasks.filter((task) => task.id === "hook-delegation-task").length, 1);
  assert.equal((await getStatus(cliSessionId)).taskCount, 0);
  assert.equal(tasks.find((task) => task.id === "hook-delegation-task").cliRuns[0].toolCalls.exec_command, 1);

  const revoke = await fetch(`${base}/delegations/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "mcp" },
    body: JSON.stringify({ delegation_id: grant.delegation.id, parent_session_id: parentSessionId }),
  });
  assert.equal(revoke.status, 200);
  const blocked = await runHook("pre-tool-use", "codex", {
    session_id: cliSessionId,
    cwd: "/work",
    tool_name: "exec_command",
    tool_input: { cmd: "true" },
  });
  assert.equal(blocked.code, 2);
  assert.match(blocked.stderr, /无活跃任务或有效 delegation/);
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
  assert.equal((await runHook("session-start", "codex", { session_id: "unknown-session", cwd: "/work" })).code, 0);

  const gateSessionId = "019f0000-0000-7000-8000-000000000099";
  let gateResponse = await fetch(`${base}/gate-session-allowlist`, {
    method: "POST",
    headers: { Origin: "http://localhost:3000", "Content-Type": "application/json", "X-TaskCenter-Action": "delegate" },
    body: JSON.stringify({ threadIds: [gateSessionId] }),
  });
  assert.equal(gateResponse.status, 200);
  const gateAllowed = await runHook("pre-tool-use", "codex", {
    session_id: gateSessionId,
    cwd: "/work",
    tool_name: "exec_command",
    tool_use_id: "gate-allowlisted-write",
  });
  assert.equal(gateAllowed.code, 0);
  assert.match(gateAllowed.stdout, /门禁豁免白名单放行/);
  const gateInteractive = await runHook("pre-tool-use", "codex", {
    session_id: gateSessionId,
    cwd: "/work",
    tool_name: "Bash",
    tool_input: { command: "zsh" },
  });
  assert.equal(gateInteractive.code, 2);
  assert.match(gateInteractive.stderr, /交互式命令/);
  gateResponse = await fetch(`${base}/gate-session-allowlist`, {
    method: "POST",
    headers: { Origin: "http://localhost:3000", "Content-Type": "application/json", "X-TaskCenter-Action": "delegate" },
    body: JSON.stringify({ threadIds: [] }),
  });
  assert.equal(gateResponse.status, 200);
  const gateRemoved = await runHook("pre-tool-use", "codex", { session_id: gateSessionId, cwd: "/work", tool_name: "exec_command" });
  assert.equal(gateRemoved.code, 2);

  const readOnly = await runHook("pre-tool-use", "codex", {
    session_id: "unknown-session",
    cwd: "/work",
    tool_name: "Bash",
    hook_event_name: "PreToolUse",
    tool_input: { command: "rg -n TODO src" },
  });
  assert.equal(readOnly.code, 0);
  assert.match(readOnly.stdout, /L0.*只读检查放行/);

  for (const command of ["rtk rg -n TODO src", "rtk git status", "/opt/homebrew/bin/rtk git branch --show-current"]) {
    const wrappedReadOnly = await runHook("pre-tool-use", "codex", {
      session_id: "unknown-session",
      cwd: "/work",
      tool_name: "Bash",
      hook_event_name: "PreToolUse",
      tool_input: { command },
    });
    assert.equal(wrappedReadOnly.code, 0, `${command} 应按内部只读命令放行`);
    assert.match(wrappedReadOnly.stdout, /L0.*只读检查放行/);
  }

  for (const cmd of [
    "sed -n -i backup '1p' README.md",
    "sed -n -i.bak '1p' README.md",
    "sed -n '1w leak.txt' README.md",
    "git diff --output=leak.patch",
    "git show --output leak.txt HEAD:README.md",
    "git grep --open-files-in-pager=touch TaskCenter",
    "git grep -Otouch TaskCenter",
    "rg TaskCenter README.md & touch /tmp/taskcenter-review-sentinel",
    "rtk rm generated.txt",
    "rtk rg TaskCenter README.md & touch /tmp/taskcenter-review-sentinel",
    "rtk git diff --output=leak.patch",
  ]) {
    const disguisedWrite = await runHook("pre-tool-use", "codex", {
      session_id: "unknown-session",
      cwd: "/work",
      tool_name: "Bash",
      hook_event_name: "PreToolUse",
      tool_input: { command: cmd },
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
  for (const command of [
    "zsh",
    "bash -s",
    "bash --noprofile",
    "python3 -q",
    "node --interactive",
    "/usr/bin/env -i zsh",
    "/usr/bin/env -- zsh",
    "bash -s placeholder",
    "node --interactive script.js",
    "python3 -i script.py",
    "node - placeholder",
    "powershell",
    "powershell.exe -NoProfile",
    "pwsh -NoExit -Command 'Get-ChildItem'",
    "cmd.exe",
    "cmd /k dir",
    "cmd --version",
    "powershell --version",
  ]) {
    const interactive = await runHook("pre-tool-use", "codex", {
      session_id: "gate-session",
      cwd: "/work",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: `interactive-${command}`,
      tool_input: { command },
    });
    assert.equal(interactive.code, 2, `${command} 不得建立可由 write_stdin 延续的会话`);
    assert.match(interactive.stderr, /不允许启动.*交互式命令/);
  }
  for (const command of [
    "bash -lc 'printf ok'",
    "node -e 'console.log(1)'",
    "python3 -m json.tool fixture.json",
    "node scripts/sync-codex.mjs",
    "node --version",
    "python3 --version",
    "bash --version",
    "node --help",
    "python3 --help",
    "bash --help",
    "powershell.exe -NoProfile -Command 'Get-ChildItem'",
    "pwsh -File script.ps1",
    "cmd.exe /d /c echo ok",
  ]) {
    const oneShot = await runHook("pre-tool-use", "codex", {
      session_id: "gate-session",
      cwd: "/work",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: `one-shot-${command}`,
      tool_input: { command },
    });
    assert.equal(oneShot.code, 0, `${command} 是一次性程序，应在活跃任务下放行`);
  }
  const allowed = await runHook("pre-tool-use", "codex", { session_id: "gate-session", cwd: "/work", tool_name: "exec_command", tool_use_id: "stable-call-1" });
  assert.equal(allowed.code, 0);
  assert.doesNotMatch(allowed.stdout, /估时提醒/);
  const tasks = await (await fetch(`${base}/tasks`)).json();
  assert.equal(tasks.tasks.find((task) => task.id === "hook-gate-task").toolCalls.exec_command, 1);
  const replay = await runHook("pre-tool-use", "codex", { session_id: "gate-session", cwd: "/work", tool_name: "exec_command", tool_use_id: "stable-call-1" });
  assert.equal(replay.code, 0);
  const afterReplay = await (await fetch(`${base}/tasks`)).json();
  assert.equal(afterReplay.tasks.find((task) => task.id === "hook-gate-task").toolCalls.exec_command, 1);
  await fetch(`${base}/task-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "mcp" },
    body: JSON.stringify({
      type: "task.update",
      event_id: "hook-gate-overdue",
      task_id: "hook-gate-task",
      session_id: "gate-session",
      due_at: "2020-01-01T00:00:00.000Z",
    }),
  });
  const firstOverdue = await runHook("pre-tool-use", "codex", { session_id: "gate-session", cwd: "/work", tool_name: "exec_command", tool_use_id: "overdue-call-1" });
  assert.equal(firstOverdue.code, 0);
  assert.match(firstOverdue.stdout, /估时提醒：交付截止已超.*调整估时或拆分任务/);
  const repeatedOverdue = await runHook("pre-tool-use", "codex", { session_id: "gate-session", cwd: "/work", tool_name: "exec_command", tool_use_id: "overdue-call-2" });
  assert.equal(repeatedOverdue.code, 0);
  assert.doesNotMatch(repeatedOverdue.stdout, /估时提醒/);
  const storedEvents = await (await fetch(`${base}/tasks/hook-gate-task/events`)).json();
  assert.equal(storedEvents.events.filter((item) => item.type === "task.reminder").length, 1);
  await fetch(`${base}/task-events`, { method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "mcp" }, body: JSON.stringify({ type: "task.report", event_id: "hook-gate-done", task_id: "hook-gate-task", session_id: "gate-session", status: "done_claimed", tests: ["hook-gate"] }) });
  const noActive = await runHook("pre-tool-use", "codex", { session_id: "gate-session", cwd: "/work", tool_name: "exec_command", tool_use_id: "stable-call-2" });
  assert.equal(noActive.code, 2);
  assert.match(noActive.stderr, /无活跃任务/);
});

test("控制服务离线时只放行固定恢复命令", async () => {
  for (const command of [
    "node scripts/taskcenter-control.mjs start",
    "node scripts/taskcenter-control.mjs status",
    "/bin/bash scripts/taskcenter-control.sh start",
    "/bin/bash scripts/taskcenter-control.sh status",
  ]) {
    const allowed = await runHook("pre-tool-use", "codex", {
      session_id: "",
      cwd: rootPath,
      tool_name: "Bash",
      hook_event_name: "PreToolUse",
      tool_input: { command },
    });
    assert.equal(allowed.code, 0, `${command} 应作为固定恢复命令放行`);
    assert.match(allowed.stdout, /固定恢复命令放行/);
  }

  for (const command of [
    "bash scripts/taskcenter-control.sh start",
    "/usr/bin/env bash scripts/taskcenter-control.sh start",
    "bash scripts/taskcenter-control.sh restart",
    "bash scripts/taskcenter-control.sh stop",
    "bash scripts/taskcenter-control.sh start extra",
    "bash scripts/taskcenter-control.sh start && touch /tmp/bypass",
    "bash ./scripts/taskcenter-control.sh start",
    "bash /tmp/scripts/taskcenter-control.sh start",
    "node scripts/taskcenter-control.mjs restart",
    "node scripts/taskcenter-control.mjs stop",
    "node ./scripts/taskcenter-control.mjs start",
    "node scripts/taskcenter-control.mjs start && echo bypass",
  ]) {
    const blocked = await runHook("pre-tool-use", "codex", {
      session_id: "",
      cwd: rootPath,
      tool_name: "Bash",
      hook_event_name: "PreToolUse",
      tool_input: { command },
    });
    assert.equal(blocked.code, 2, `${command} 不得进入恢复白名单`);
  }

  const wrongWorkspace = await runHook("pre-tool-use", "codex", {
    session_id: "",
    cwd: "/tmp",
    tool_name: "Bash",
    hook_event_name: "PreToolUse",
    tool_input: { command: "node scripts/taskcenter-control.mjs start" },
  });
  assert.equal(wrongWorkspace.code, 2);

  const missingWorkspace = await runHook("pre-tool-use", "codex", {
    session_id: "",
    tool_name: "Bash",
    hook_event_name: "PreToolUse",
    tool_input: { command: "node scripts/taskcenter-control.mjs start" },
  });
  assert.equal(missingWorkspace.code, 2);
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
