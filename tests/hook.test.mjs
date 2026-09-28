import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const rootPath = resolve(fileURLToPath(root));
const tempDir = await mkdtemp(join(tmpdir(), "taskcenter-hook-"));
const paths = {
  TASKCENTER_SESSIONS_ROOT: join(tempDir, "sessions"),
  TASKCENTER_TASK_EVENTS_PATH: join(tempDir, "task-events.jsonl"),
  TASKCENTER_TASK_LEDGER_PATH: join(tempDir, "task-ledger.json"),
  TASKCENTER_TASK_EVENT_IDS_PATH: join(tempDir, "task-event-ids.json"),
  TASKCENTER_TASK_RECONCILE_PATH: join(tempDir, "task-reconcile.jsonl"),
  TASKCENTER_SESSION_REGISTRY_PATH: join(tempDir, "session-registry.json"),
  TASKCENTER_GATE_SESSION_ALLOWLIST_PATH: join(tempDir, "gate-session-allowlist.json"),
  TASKCENTER_DELEGATIONS_PATH: join(tempDir, "delegations.json"),
  TASKCENTER_ROUTING_CONTROL_PATH: join(tempDir, "routing-control.json"),
  TASKCENTER_MODEL_ROLE_CONFIG_PATH: join(tempDir, "model-roles.json"),
  TASKCENTER_GATE_DENIALS_PATH: join(tempDir, "gate-denials.jsonl"),
};
// 历史 CLI 协议仍可回放；native-only 当前策略由独立 HTTP 用例验证。
const legacyRoles = JSON.parse(await readFile(new URL("config/model-roles.json", root), "utf8"));
legacyRoles.roles.executor.dispatch_channel = "cli";
legacyRoles.roles.executor.model = "kimi-code/k3-256k";
legacyRoles.roles.executor.fallback_models = ["mimo-v2.6-flash", "mimo-v2.6-pro"];
legacyRoles.roles.executor.model_reasoning_efforts = {};
await writeFile(paths.TASKCENTER_MODEL_ROLE_CONFIG_PATH, JSON.stringify(legacyRoles));
const port = 39_000 + (process.pid % 1_000);
const base = `http://127.0.0.1:${port}`;
const hook = join(rootPath, "scripts", "taskcenter-hook.mjs");
const server = spawn(process.execPath, ["scripts/control-server.mjs"], {
  cwd: root,
  env: { ...process.env, ...paths, TASKCENTER_CONTROL_PORT: String(port), TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION: "1", TASKCENTER_JEV_ROUTING: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});

test("Review Hook 兼容旧服务 404，其他服务错误不能当成豁免", async (context) => {
  let status = 404;
  const legacy = createServer((request, response) => {
    const reviews = request.url.startsWith("/reviews/session?");
    response.writeHead(reviews ? status : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(reviews ? { error: "接口不存在。" } : {}));
  });
  await new Promise((resolve) => legacy.listen(0, "127.0.0.1", resolve));
  context.after(() => legacy.close());
  const payload = { session_id: "review-old-service", cwd: "/work", tool_name: "mcp__taskcenter__taskcenter_routing_select" };
  const url = `http://127.0.0.1:${legacy.address().port}`;
  assert.equal((await runHook("pre-tool-use", "codex", payload, [], url)).code, 0);
  status = 500;
  assert.equal((await runHook("pre-tool-use", "codex", payload, [], url)).code, 2);
});

test("Reviewer Hook 无需 active Task，只读且拒绝代码写入和新任务", async () => {
  const sessionId = "reviewer-hook-session";
  await runHook("session-start", "codex", { session_id: sessionId, cwd: "/work" });
  await writeFile(paths.TASKCENTER_ROUTING_CONTROL_PATH, JSON.stringify({ version: 3, models: {}, routes: [{ reviewRecord: { reviewer_session_id: sessionId, status: "approved" } }] }));
  try {
    const payload = { session_id: sessionId, cwd: "/work" };
    assert.equal((await runHook("pre-tool-use", "codex", { ...payload, tool_name: "exec_command", tool_input: { cmd: "rtk git diff" } })).code, 0);
    assert.equal((await runHook("pre-tool-use", "codex", { ...payload, tool_name: "mcp__taskcenter__taskcenter_task_review_report" })).code, 0);
    for (const event of [{ tool_name: "apply_patch" }, { tool_name: "mcp__taskcenter__taskcenter_task_create" }, { tool_name: "exec_command", tool_input: { cmd: "touch forbidden" } }, { tool_name: "mcp__taskcenter__taskcenter_delegation_grant" }]) {
      assert.equal((await runHook("pre-tool-use", "codex", { ...payload, ...event })).code, 2);
    }
  } finally { await rm(paths.TASKCENTER_ROUTING_CONTROL_PATH, { force: true }); }
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

test("离线恢复白名单兼容 Codex exec_command 格式与受限 rtk/cd 包装", async () => {
  const basePayload = {
    session_id: "",
    cwd: rootPath,
    hook_event_name: "PreToolUse",
  };
  // Codex 实际入口：tool_name=exec_command + tool_input.cmd。
  const codexAllowed = await runHook("pre-tool-use", "codex", {
    ...basePayload,
    tool_name: "exec_command",
    tool_input: { cmd: "node scripts/taskcenter-control.mjs start" },
  });
  assert.equal(codexAllowed.code, 0, "Codex exec_command 固定恢复命令应放行");

  // rtk 包装与 rtk proxy 包装。
  for (const cmd of [
    "rtk node scripts/taskcenter-control.mjs start",
    "rtk proxy node scripts/taskcenter-control.mjs status",
  ]) {
    const allowed = await runHook("pre-tool-use", "codex", {
      ...basePayload,
      tool_name: "exec_command",
      tool_input: { cmd },
    });
    assert.equal(allowed.code, 0, `${cmd} 应剥离 rtk 前缀后放行`);
  }

  // 前导 cd <项目根> && 包装。
  const cdWrapped = await runHook("pre-tool-use", "codex", {
    ...basePayload,
    tool_name: "Bash",
    tool_input: { command: `cd ${rootPath} && node scripts/taskcenter-control.mjs start` },
  });
  assert.equal(cdWrapped.code, 0, "前导 cd 项目根 && 应剥离后放行");

  // Codex 实际 payload：工作目录在 tool_input.workdir，不在顶层 cwd。
  const workdirOnly = await runHook("pre-tool-use", "codex", {
    session_id: "",
    hook_event_name: "PreToolUse",
    tool_name: "exec_command",
    tool_input: { cmd: "node scripts/taskcenter-control.mjs start", workdir: rootPath },
  });
  assert.equal(workdirOnly.code, 0, "tool_input.workdir 在项目根时应放行");

  const workdirOutside = await runHook("pre-tool-use", "codex", {
    session_id: "",
    hook_event_name: "PreToolUse",
    tool_name: "exec_command",
    tool_input: { cmd: "node scripts/taskcenter-control.mjs start", workdir: "/tmp" },
  });
  assert.equal(workdirOutside.code, 2, "tool_input.workdir 在项目外时应拒绝");

  // Codex exec_command 实际走的是 scheduled-pre-tool-use action（hooks.json 第二个 matcher）。
  const scheduledRecovery = await runHook("scheduled-pre-tool-use", "codex", {
    session_id: "",
    tool_name: "exec_command",
    tool_input: { cmd: "node scripts/taskcenter-control.mjs start", workdir: rootPath },
  });
  assert.equal(scheduledRecovery.code, 0, "scheduled-pre-tool-use 应急恢复命令也应放行");

  // Codex 会话 cwd 常落在兄弟项目（如 ProjectContextAgent），用绝对路径启动 ReqRadar 服务应放行。
  const absFromOtherCwd = await runHook("pre-tool-use", "codex", {
    session_id: "",
    cwd: "/Users/gezi/Documents/project/ProjectContextAgent",
    tool_name: "Bash",
    tool_input: { command: `node ${rootPath}/scripts/taskcenter-control.mjs start` },
  });
  assert.equal(absFromOtherCwd.code, 0, "绝对路径形式在非 ReqRadar cwd 下也应放行");

  const absRestart = await runHook("pre-tool-use", "codex", {
    session_id: "",
    cwd: rootPath,
    tool_name: "Bash",
    tool_input: { command: `node ${rootPath}/scripts/taskcenter-control.mjs restart` },
  });
  assert.equal(absRestart.code, 2, "绝对路径 restart 不在白名单");

  const absOtherScript = await runHook("pre-tool-use", "codex", {
    session_id: "",
    cwd: rootPath,
    tool_name: "Bash",
    tool_input: { command: "node /tmp/evil.mjs start" },
  });
  assert.equal(absOtherScript.code, 2, "绝对路径指向非 TaskCenter 脚本应拒绝");

  // 仍拒绝：cd 后接非恢复命令、cd 到别的目录、拼接额外写操作。
  for (const [toolName, toolInput] of [
    ["Bash", { command: `cd ${rootPath} && touch /tmp/evil && node scripts/taskcenter-control.mjs start` }],
    ["exec_command", { cmd: "cd /tmp && node scripts/taskcenter-control.mjs start" }],
    ["exec_command", { cmd: "node scripts/taskcenter-control.mjs restart" }],
    ["Bash", { command: "rtk touch /tmp/evil" }],
  ]) {
    const blocked = await runHook("pre-tool-use", "codex", {
      ...basePayload,
      tool_name: toolName,
      tool_input: toolInput,
    });
    assert.equal(blocked.code, 2, `tool=${toolName} input=${JSON.stringify(toolInput)} 不得进入恢复白名单`);
  }
});

await waitForReady();
after(async () => {
  server.kill("SIGTERM");
  await rm(tempDir, { recursive: true, force: true });
});

test("预算到限仍允许实现验证提交及任务更新，prepare 返回绑定，关闭后 L0 仍可读取", async () => {
  const sessionId = "019f0000-0000-7000-8000-0000000000aa";
  await runHook("session-start", "codex", { session_id: sessionId, cwd: "/work" });
  const post = (body) => fetch(`${base}/task-events`, { method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "hook" }, body: JSON.stringify(body) });
  const created = await (await post({ type: "task.create", session_id: sessionId, workspace: "/work", title: "budget", goal: "budget", plan: ["implement"], acceptance_criteria: ["pass"], contract_version: "v2", scope: ["budget"], non_goals: [], review_policy: "not_required", workflow_profile: "fast" })).json();
  assert.equal(created.accepted, true, JSON.stringify(created));
  await writeFile(paths.TASKCENTER_ROUTING_CONTROL_PATH, JSON.stringify({ version: 3, models: {}, routes: [{ id: "budget-direct", taskId: created.task.id, channel: "direct", status: "leased", available: true, expiresAt: new Date(Date.now() + 120_000).toISOString() }] }));
  await mkdir(paths.TASKCENTER_SESSIONS_ROOT, { recursive: true });
  const lines = [{ type: "session_meta", payload: { id: sessionId } }, ...Array.from({ length: 8 }, (_, i) => ({ type: "event_msg", timestamp: new Date(Date.now() + i).toISOString(), payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1 }, total_token_usage: { input_tokens: i + 1 } } } }))];
  await writeFile(join(paths.TASKCENTER_SESSIONS_ROOT, `${sessionId}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const prepared = await (await fetch(`${base}/task-prepare?session_id=${sessionId}`)).json();
  assert.equal(prepared.task_id, created.task.id);
  assert.equal(prepared.handoff_required, false);
  assert.equal(prepared.handoff_recommended, true);
  assert.equal((await (await fetch(`${base}/session-lifecycle?session_id=${sessionId}`)).json()).action, "continue_current_session");
  assert.ok(Buffer.byteLength(JSON.stringify(prepared)) <= 4096);
  const run = (tool_name, tool_input) => runHook("pre-tool-use", "codex", { session_id: sessionId, cwd: "/work", tool_name, tool_input });
  for (const cmd of ["touch x", "npm test", "git commit -m fix"]) {
    assert.equal((await run("exec_command", { cmd })).code, 0, cmd);
  }
  assert.equal((await run("exec_command", { cmd: "rg failure log | head -10" })).code, 0);
  assert.equal((await run("mcp__taskcenter__taskcenter_task_close", {})).code, 0);
  const updated = await post({ type: "task.update", session_id: sessionId, task_id: created.task.id, goal: "new goal" });
  assert.equal(updated.status, 200);
  const checkpoint = await post({ type: "task.update", session_id: sessionId, task_id: created.task.id, next_action: "handoff", evidence: ["checkpoint saved"] });
  assert.equal(checkpoint.status, 200);
  const target = "019f0000-0000-7000-8000-0000000000ab";
  await runHook("session-start", "codex", { session_id: target, cwd: "/work" });
  await writeFile(join(paths.TASKCENTER_SESSIONS_ROOT, `${target}.jsonl`), [
    { type: "session_meta", payload: { id: target } },
    ...lines.slice(1), { type: "compacted" }, { type: "compacted" },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  const resume = (expected_session_id) => fetch(`${base}/task-resume`, { method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "hook" }, body: JSON.stringify({ session_id: target, task_id: created.task.id, expected_session_id }) });
  assert.equal((await resume("wrong-owner")).status, 409);
  const resumed = await resume(sessionId);
  assert.equal(resumed.status, 200);
  const targetPrepared = await resumed.json();
  assert.equal(targetPrepared.new_session_recommended, true);
  assert.equal(targetPrepared.handoff_required, false);
  assert.equal((await run("exec_command", { cmd: "touch x" })).code, 2, "原 Session 不再具有写入归属");
  const targetRun = (tool_name, tool_input) => runHook("pre-tool-use", "codex", { session_id: target, cwd: "/work", tool_name, tool_input });
  const finish = await post({ type: "task.update", session_id: target, task_id: created.task.id, status: "done_claimed", evidence: ["fixture completion"], due_at: "2020-01-01T00:00:00.000Z" });
  assert.equal(finish.status, 200);
  const denied = await targetRun("exec_command", { cmd: "git merge feature" });
  assert.equal(denied.code, 2);
  assert.match(denied.stderr, /taskcenter_task_resume/);
  assert.match((await runHook("user-prompt-submit", "codex", { session_id: target, cwd: "/work" })).stdout, /taskcenter_task_resume/);
  assert.equal((await targetRun("mcp__taskcenter__taskcenter_task_resume", {})).code, 0);
  assert.equal((await resume("wrong-owner")).status, 409);
  const other = await post({ type: "task.create", session_id: target, workspace: "/work", task_id: "resume-conflict", title: "另一交付", goal: "另一交付", plan: ["implement"], acceptance_criteria: ["pass"], contract_version: "v2", scope: ["other"], non_goals: [], review_policy: "not_required", workflow_profile: "fast" });
  assert.equal(other.status, 201);
  assert.equal((await resume(target)).status, 409, "同 Session 接续不能绕过单活跃任务限制");
  assert.equal((await post({ type: "task.update", session_id: target, task_id: "resume-conflict", status: "cancelled" })).status, 200);
  const continued = await resume(target);
  assert.equal(continued.status, 200);
  const continuedTask = await continued.json();
  assert.equal(continuedTask.task_id, created.task.id);
  assert.equal(continuedTask.active_task.status, "in_progress");
  assert.equal((await targetRun("exec_command", { cmd: "git merge feature" })).code, 0, "同一任务接续后合并命令可通过门禁；不实际执行 Git");
  assert.equal((await resume(target)).status, 200, "已接续调用可重试");
  // Core closure simulates an independently authorized close without weakening ownership gates.
  const closed = await fetch(`${base}/core/task-events`, { method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "mcp" }, body: JSON.stringify({ type: "task.update", session_id: target, task_id: created.task.id, status: "cancelled" }) });
  assert.equal(closed.status, 200);
  assert.equal((await run("exec_command", { cmd: "git status && cat README.md" })).code, 0);
});

test("SessionStart Hook 登记真实会话且可幂等重放", async () => {
  const first = await runHook("session-start", "claude", { session_id: "hook-session", cwd: "/work" });
  const second = await runHook("session-start", "claude", { session_id: "hook-session", cwd: "/work" });
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  const status = await getStatus("hook-session");
  assert.equal(status.status, "registered");
  assert.equal(status.agent, "claude");
  const context = JSON.parse(first.stdout).hookSpecificOutput;
  assert.equal(context.hookEventName, "SessionStart");
  assert.match(context.additionalContext, /"session_id":"hook-session"/);
  assert.match(context.additionalContext, /scope、plan、acceptance_criteria/);
  assert.match(context.additionalContext, /不传 create_new/);
  assert.match(context.additionalContext, /关闭时引用原 id/);
  const denied = await runHook("pre-tool-use", "claude", { session_id: "hook-session", cwd: "/work", tool_name: "Write", tool_input: { file_path: "/work/probe.txt", content: "probe" } });
  assert.equal(denied.code, 2);
  assert.match(denied.stderr, /"session_id":"hook-session"/);
  assert.match(denied.stderr, /不要添加 local_/);
});

test("Claude 写入门禁仅接受真实 Session 的任务，前缀身份不能替代", async () => {
  const sessionId = "claude-real-identity";
  const alias = `local_${sessionId}`;
  for (const id of [sessionId, alias]) {
    assert.equal((await runHook("session-start", "claude", { session_id: id, cwd: "/work" })).code, 0);
  }
  const create = async (id) => {
    const response = await fetch(`${base}/task-events`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "hook" },
      body: JSON.stringify({ type: "task.create", session_id: id, workspace: "/work", agent: "claude", title: "identity", goal: "identity", non_goals: [], plan: ["verify"], scope: ["probe"], acceptance_criteria: [{ id: "write", description: "same session", required: true }], contract_version: "v2", workflow_profile: "fast", review_policy: "recommended" }),
    });
    const result = await response.json();
    assert.equal(result.accepted, true, JSON.stringify(result));
  };
  const probe = () => runHook("pre-tool-use", "claude", { session_id: sessionId, cwd: "/work", tool_name: "Write", tool_input: { file_path: "/work/probe.txt", content: "probe" } });
  await create(alias);
  const denied = await probe();
  assert.equal(denied.code, 2);
  assert.match(denied.stderr, /"session_id":"claude-real-identity"/);
  await create(sessionId);
  const allowed = await probe();
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.match(allowed.stdout, /任务门禁通过/);
});

test("Codex 执行须有相符路由，CLI 路由不能授权主模型写入", async () => {
  const sessionId = "codex-route-gate";
  await runHook("session-start", "codex", { session_id: sessionId, cwd: "/work" });
  const response = await fetch(`${base}/task-events`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "hook" },
    body: JSON.stringify({ type: "task.create", session_id: sessionId, workspace: "/work", agent: "codex", title: "route gate", goal: "test routing", plan: ["verify"], scope: ["probe"], non_goals: [], acceptance_criteria: [{ id: "route", description: "route selected", required: true }], contract_version: "v2", workflow_profile: "fast", review_policy: "recommended" }),
  });
  const created = await response.json();
  assert.equal(created.accepted, true, JSON.stringify(created));
  const taskId = created.task.id;
  const payload = { session_id: sessionId, cwd: "/work", tool_name: "apply_patch", tool_input: {} };
  const route = (channel) => ({ id: `route-${channel}`, taskId, channel, status: "leased", available: true, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const save = async (routes) => writeFile(paths.TASKCENTER_ROUTING_CONTROL_PATH, JSON.stringify({ version: 3, models: {}, routes }));
  try {
    assert.match((await runHook("pre-tool-use", "codex", payload)).stderr, /缺少有效路由/);
    await save([route("cli")]);
    assert.match((await runHook("pre-tool-use", "codex", payload)).stderr, /缺少有效路由/);
    const launcher = join(rootPath, "scripts/delegated-cli.mjs");
    assert.equal((await runHook("pre-tool-use", "codex", { ...payload, tool_name: "exec_command", tool_input: { cmd: `node ${launcher} /tmp/manifest.json` } })).code, 0);
    assert.equal((await runHook("pre-tool-use", "codex", { ...payload, tool_name: "exec_command", tool_input: { cmd: `node ${launcher} --stdin` } })).code, 0);
    assert.equal((await runHook("pre-tool-use", "codex", { ...payload, tool_name: "exec_command", tool_input: { cmd: `node ${launcher} --stdin`, tty: true } })).code, 0);
    assert.equal((await runHook("pre-tool-use", "codex", { ...payload, tool_name: "exec_command", tool_input: { cmd: "node scripts/delegated-cli.mjs --stdin", workdir: rootPath } })).code, 0);
    assert.match((await runHook("pre-tool-use", "codex", { ...payload, tool_name: "exec_command", tool_input: { cmd: "node scripts/delegated-cli.mjs --stdin" } })).stderr, /缺少有效路由/);
    assert.match((await runHook("pre-tool-use", "codex", { ...payload, tool_name: "exec_command", tool_input: { cmd: "node /tmp/delegated-cli.mjs --stdin" } })).stderr, /缺少有效路由/);
    assert.match((await runHook("pre-tool-use", "codex", { ...payload, tool_name: "exec_command", tool_input: { cmd: "node /tmp/delegated-cli.mjs --stdin", tty: true } })).stderr, /交互式命令/);
    assert.match((await runHook("pre-tool-use", "codex", { ...payload, tool_name: "exec_command", tool_input: { cmd: `node ${launcher} /tmp/manifest.json`, tty: true } })).stderr, /交互式命令/);
    assert.match((await runHook("pre-tool-use", "codex", { ...payload, tool_name: "exec_command", tool_input: { cmd: "node scripts/delegated-cli.mjs --stdin > /tmp/output" } })).stderr, /缺少有效路由/);
    await save([route("direct")]);
    assert.equal((await runHook("pre-tool-use", "codex", payload)).code, 0);
    await save([{ ...route("direct"), expiresAt: new Date(Date.now() - 1_000).toISOString() }]);
    assert.match((await runHook("pre-tool-use", "codex", payload)).stderr, /缺少有效路由/);
  } finally { await rm(paths.TASKCENTER_ROUTING_CONTROL_PATH, { force: true }); }
});

test("L0 路径探测跨客户端放行，但不能借 command 包装执行", async () => {
  for (const agent of ["codex", "claude", "kimi"]) {
    const session_id = `lookup-${agent}`;
    await runHook("session-start", agent, { session_id, cwd: "/work" });
    for (const cmd of ["which kimi claude", "rtk proxy which -a claude", "command -v kimi", "command -V claude", "type claude", "type -a kimi", "/usr/bin/which node", "rtk proxy node --version", "rtk proxy claude --version", "rtk proxy kimi --version", "node -v", "claude -v", "kimi -V", "/usr/local/bin/node --version"]) {
      const result = await runHook("pre-tool-use", agent, { session_id, cwd: "/work", tool_name: "Bash", tool_input: { command: cmd } });
      assert.equal(result.code, 0, `${agent}: ${cmd}`);
      assert.match(result.stdout, /L0/);
    }
    for (const cmd of ["command touch sentinel", "command -p touch sentinel", "command -v kimi && touch sentinel", "which kimi > result", "which $(touch sentinel)", "which --bad kimi", "type -f x", "command", "which", "node --version -e 'process.exit()'", "claude --version -p hello", "kimi --version --prompt hello", "kimi -v", "node --version > result", "claude --version && touch sentinel"]) {
      const result = await runHook("pre-tool-use", agent, { session_id, cwd: "/work", tool_name: "Bash", tool_input: { command: cmd } });
      assert.equal(result.code, 2, `${agent}: ${cmd}`);
      assert.match(result.stderr, /L0_COMMAND_NOT_RECOGNIZED/);
    }
  }
});

test("Hook 拒绝即时记录安全分类并给出可执行恢复步骤", async () => {
  const session_id = "lookup-denial-guidance";
  await runHook("session-start", "codex", { session_id, cwd: "/work" });
  const denied = await runHook("pre-tool-use", "codex", { session_id, cwd: "/work", tool_name: "Bash", tool_input: { command: "which kimi && touch secret-sentinel" } });
  assert.equal(denied.code, 2);
  assert.match(denied.stderr, /只读.*拆开复合命令/);
  assert.match(denied.stderr, /验证：.*L0/);
  const records = (await readFile(paths.TASKCENTER_GATE_DENIALS_PATH, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(records.some((record) => record.session_id === session_id && record.category === "no_active_task"));
  assert.doesNotMatch(JSON.stringify(records), /secret-sentinel/);
});

test("L0 仅向已登记且无任务 Session 放行确定性只读命令", async () => {
  const sessionId = "019f0000-0000-7000-8000-000000000089";
  assert.equal((await runHook("session-start", "codex", { session_id: sessionId, cwd: "/work" })).code, 0);
  for (const command of ["pwd", "cat README.md", "sed -n '1,2p' README.md", "sed -n '/hello/p' README.md", "git status", "git diff", "git ls-files", "find . -maxdepth 1", "rtk rg TaskCenter README.md", "rtk rg 'foo|bar' README.md", "rtk proxy rg 'foo|bar' README.md", "adb devices -l", "/opt/android/adb version", "pwd; ls", "cat x | head", "rg foo README.md && git status", "jq '.[0]' data.json", "awk 'NR<=10 {print $0}' README.md", "cat <<'EOF'\nhello\nEOF"]) {
    const allowed = await runHook("pre-tool-use", "codex", { session_id: sessionId, cwd: "/work", tool_name: "exec_command", tool_input: { cmd: command } });
    assert.equal(allowed.code, 0, command);
    assert.match(allowed.stdout, /L0/);
  }
  for (const command of ["touch x", "rm x", "mv x y", "sed -i s/a/b/ x", "sed -ni s/a/b/ x", "sed -n '1w leak.txt' x", "git commit -m x", "git diff --output=leak", "npm test", "cat x > y", "echo $(pwd)", "find . -delete", "find . -exec touch x ;", "find . -fprint leak", "bash -c 'pwd'", "python -c 'print(1)'"]) {
    const blocked = await runHook("pre-tool-use", "codex", { session_id: sessionId, cwd: "/work", tool_name: "exec_command", tool_input: { cmd: command } });
    assert.equal(blocked.code, 2, command);
    assert.match(blocked.stderr, /不满足 L0 确定性只读规则/);
  }
  for (const command of ['rtk rg --pre="touch sentinel" x', 'rg --hostname-bin=evil x', 'adb shell id', 'adb devices -l; adb reboot', 'cat /tmp/auth.json', 'rtk proxy rg "$(touch sentinel)" .']) {
    const blocked = await runHook("pre-tool-use", "codex", { session_id: sessionId, cwd: "/work", tool_name: "exec_command", tool_input: { cmd: command } });
    assert.equal(blocked.code, 2, command);
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
  assert.equal(tasks.filter((task) => task.sessionId === sessionId).length, 0);
});

test("L0 OCR 仅放行确定性 delegate preview/rule 及安全参数", async () => {
  const sessionId = "ocr-l0-session";
  await runHook("session-start", "codex", { session_id: sessionId, cwd: "/work" });
  const allowed = [
    "ocr delegate preview --format json --from feat-gezi-base --to fix/gezi-base-review-findings",
    "ocr delegate rule --format=json src/a.ts src/b.ts",
    "ocr delegate preview --repo '/work/my repo' --rule rules.json --commit HEAD --exclude '*.lock' -f text",
    "ocr delegate rule -c HEAD --from=main --to=HEAD --repo=/work --rule=rules.json --exclude=dist src/a.ts",
  ];
  const denied = [
    "ocr", "ocr review", "ocr llm test", "ocr delegate apply", "ocr delegate preview extra",
    "ocr delegate preview --output result.json", "ocr delegate rule --output=result.json src/a.ts",
    "ocr delegate preview --format sarif", "ocr delegate preview --from", "ocr delegate preview --from=",
    "ocr delegate preview --from --output=x", "ocr delegate preview --to=--output=x",
    "ocr delegate preview --unknown", "ocr delegate rule -- src/a.ts",
    "ocr delegate preview --background-file /tmp/auth.json",
    "ocr delegate preview --rule=/tmp/auth.json",
    "ocr delegate preview > result.json", "ocr delegate preview; touch sentinel",
    'ocr delegate rule "$(touch sentinel)"', "ocr delegate preview | tee result.json",
    "ocr delegate preview && git branch new-branch",
  ];
  for (const prefix of ["", "rtk ", "rtk proxy "]) {
    for (const [commands, expected] of [[allowed, 0], [denied, 2]]) {
      for (const command of commands) {
        const cmd = prefix + command;
        const result = await runHook("pre-tool-use", "codex", { session_id: sessionId, cwd: "/work", tool_name: "exec_command", tool_input: { cmd } });
        assert.equal(result.code, expected, cmd);
        if (expected === 0) assert.match(result.stdout, /L0/);
      }
    }
  }
  const unregistered = await runHook("pre-tool-use", "codex", { session_id: "ocr-unregistered", cwd: "/work", tool_name: "exec_command", tool_input: { cmd: allowed[0] } });
  assert.equal(unregistered.code, 2);
  const tasks = (await (await fetch(`${base}/tasks`)).json()).tasks;
  assert.equal(tasks.filter((task) => task.sessionId === sessionId).length, 0);
});

test("scheduled_readonly 仅绕过 active task 并限制为 inStory 精确只读能力", async () => {
  const sessionId = "019f0000-0000-7000-8000-00000000008a";
  const instoryRoot = join(tempDir, "inStory");
  const reportPath = join(instoryRoot, "project-context", "90-Agent提案", "自动化报告", "instory.md");
  await mkdir(join(instoryRoot, "project-context"), { recursive: true });
  await writeFile(join(instoryRoot, "README.md"), "inStory\n");
  await writeFile(join(instoryRoot, "project-context", "status.md"), "status\n");
  const initialReport = managedReport("rolling report");
  const updatedReport = managedReport("rolling report updated");
  await mkdir(join(instoryRoot, "project-context", "90-Agent提案", "自动化报告"), { recursive: true });
  await writeFile(reportPath, initialReport);
  const profileArgs = [
    "--profile", "scheduled_readonly",
    "--automation-id", "instory",
    "--project-id", "instory",
    "--workspace-root", instoryRoot,
    "--report-path", reportPath,
    "--task-mutation", "false",
    "--pca-mutation", "false",
    "--report-mutation", "true",
    "--network", "false",
  ];
  const startResult = await runHook("session-start", "codex", { session_id: sessionId, cwd: instoryRoot }, profileArgs);
  assert.equal(startResult.code, 0, startResult.stderr);
  const forgedActivation = await fetch(`${base}/sessions/scheduled-readonly`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "hook" },
    body: JSON.stringify({ session_id: sessionId, profile: "scheduled_readonly" }),
  });
  assert.equal(forgedActivation.status, 404);
  const detected = await runHook("scheduled-profile-detect", "codex", {
    session_id: sessionId,
    cwd: instoryRoot,
    prompt: `Automation ID: instory\n${reportPath}\n<!-- AUTO-MANAGED-BEGIN -->`,
  }, profileArgs);
  assert.equal(detected.code, 0);
  assert.match(detected.stdout, /scheduled_readonly Profile 已绑定/);
  assert.match(detected.stdout, /scheduled-report-probe\.mjs/);

  const createContent = initialReport.slice(initialReport.indexOf("<!-- AUTO-MANAGED-BEGIN -->"), initialReport.indexOf("<!-- AUTO-MANAGED-END -->") + "<!-- AUTO-MANAGED-END -->".length) + "\n";
  const addPatch = (content, path = reportPath) => `*** Begin Patch\n*** Add File: ${path}\n${content.trimEnd().split("\n").map((line) => `+${line}`).join("\n")}\n*** End Patch`;
  const checkPatch = (patch, action = "pre-tool-use") => runHook(action, "codex", {
    session_id: sessionId, cwd: instoryRoot, tool_name: "apply_patch", tool_input: { command: patch },
  });
  assert.equal((await checkPatch(addPatch(createContent))).code, 2, "Add must not overwrite an existing report");
  await rm(join(instoryRoot, "project-context", "90-Agent提案"), { recursive: true });
  const firstCreate = await checkPatch(addPatch(createContent.replace("rolling report", "first creation")));
  assert.equal(firstCreate.code, 0, firstCreate.stderr);
  const rewrittenCreate = JSON.parse(firstCreate.stdout).hookSpecificOutput.updatedInput.command;
  const createdContent = rewrittenCreate.split("\n").slice(2, -1).map((line) => line.slice(1)).join("\n") + "\n";
  for (const invalid of [
    addPatch("manual preface\n" + createContent),
    addPatch(createContent + "manual footer\n"),
    addPatch(createContent.replace("<!-- AUTO-MANAGED-END -->", "")),
    addPatch(createContent.replace("<!-- AUTO-MANAGED-END -->", "<!-- AUTO-MANAGED-BEGIN -->\n<!-- AUTO-MANAGED-END -->")),
    addPatch(createContent, reportPath + ".other.md"),
    addPatch(createContent).replace("*** End Patch", `*** Add File: ${reportPath}.other.md\n+other\n*** End Patch`),
    addPatch(createContent).replace("+<!-- AUTO-MANAGED-BEGIN -->", "@@"),
  ]) assert.equal((await checkPatch(invalid)).code, 2, invalid);
  await mkdir(join(instoryRoot, "project-context", "90-Agent提案", "自动化报告"), { recursive: true });
  await writeFile(reportPath, createdContent);
  assert.equal((await checkPatch(rewrittenCreate, "post-tool-use")).code, 0);
  if (process.platform !== "win32") {
    await rm(reportPath);
    await symlink(join(tempDir, "missing-report.md"), reportPath);
    assert.equal((await checkPatch(addPatch(createContent))).code, 2, "dangling file symlink");
    await rm(reportPath);
    await rm(join(instoryRoot, "project-context", "90-Agent提案", "自动化报告"), { recursive: true });
    await symlink(tempDir, join(instoryRoot, "project-context", "90-Agent提案", "自动化报告"));
    assert.equal((await checkPatch(addPatch(createContent))).code, 2, "ancestor symlink");
    await rm(join(instoryRoot, "project-context", "90-Agent提案", "自动化报告"));
    await mkdir(join(instoryRoot, "project-context", "90-Agent提案", "自动化报告"));
  }
  await writeFile(reportPath, initialReport);
  for (const prompt of [
    "ordinary project question",
    `Automation ID: other\n${reportPath}\n<!-- AUTO-MANAGED-BEGIN -->`,
    "在 CyberRole 当前主工作区执行“夜间项目交付系统优化探索”\ntrial_id：cyberrole-context-lifecycle-20260820\n<!-- AUTO-MANAGED-BEGIN -->",
    `Automation ID: instory\n<!-- AUTO-MANAGED-BEGIN -->`,
  ]) {
    const result = await runHook("scheduled-profile-detect", "codex", { session_id: sessionId, cwd: instoryRoot, prompt }, profileArgs);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "", "unmatched prompt must be a no-op");
  }

  const reportPatch = reportUpdatePatch(reportPath, initialReport, updatedReport);
  const allowedCases = [
    { tool_name: "Read", tool_input: { file_path: join(instoryRoot, "README.md") } },
    { tool_name: "Grep", tool_input: { path: join(instoryRoot, "project-context"), pattern: "status" } },
    { tool_name: "Glob", tool_input: { path: instoryRoot, pattern: "project-context/**/*.md" } },
    { tool_name: "exec_command", tool_input: { cmd: "git status --short" } },
    { tool_name: "Bash", tool_input: { command: "git rev-parse HEAD" } },
    { tool_name: "exec_command", tool_input: { cmd: "rtk sed -n '1,20p' 'project-context/status.md'" } },
    { tool_name: "exec_command", tool_input: { cmd: `rtk cat '${reportPath}'` } },
    { tool_name: "exec_command", tool_input: { cmd: `rtk head -n 20 '${reportPath}'` } },
    { tool_name: "exec_command", tool_input: { cmd: `rtk tail --lines=20 '${reportPath}'` } },
    { tool_name: "exec_command", tool_input: { cmd: `shasum -a 256 '${reportPath}'` } },
    { tool_name: "Bash", tool_input: { command: `rtk node '${join(rootPath, "scripts", "scheduled-report-probe.mjs")}' --report '${reportPath}'` } },
    { tool_name: "apply_patch", tool_input: { command: reportPatch } },
    { tool_name: "apply_patch", tool_input: reportPatch },
    { tool_name: "mcp__context__context_capabilities", tool_input: {} },
    { tool_name: "mcp__context__context_health_check", tool_input: {} },
    { tool_name: "mcp__context__context_list_active_tasks", tool_input: { project_id: "instory" } },
    { tool_name: "mcp__taskcenter__taskcenter_session_register", tool_input: { session_id: sessionId, workspace: instoryRoot } },
    { tool_name: "mcp__taskcenter__taskcenter_session_status", tool_input: { session_id: sessionId } },
    { tool_name: "mcp__taskcenter__taskcenter_task_query", tool_input: { session_id: sessionId } },
    { tool_name: "mcp__taskcenter__taskcenter_scheduled_readonly_scan_exemption_status", tool_input: { session_id: sessionId } },
    { tool_name: "mcp__taskcenter__taskcenter_scheduled_readonly_scan_exemption_set", tool_input: { session_id: sessionId, enabled: true } },
  ];
  for (const payload of allowedCases) {
    const result = await runHook("pre-tool-use", "codex", { session_id: sessionId, cwd: instoryRoot, ...payload });
    assert.equal(result.code, 0, payload.tool_name || payload.tool_input?.cmd);
    assert.match(result.stdout, /scheduled_readonly 放行/);
  }

  const staleHashPatch = reportUpdatePatch(reportPath, initialReport, initialReport.replace("rolling report", "rolling report updated"));
  const rewritten = await runHook("pre-tool-use", "codex", {
    session_id: sessionId,
    cwd: instoryRoot,
    tool_name: "apply_patch",
    tool_input: { command: staleHashPatch },
  });
  assert.equal(rewritten.code, 0, rewritten.stderr);
  const rewriteDecision = JSON.parse(rewritten.stdout);
  assert.equal(rewriteDecision.hookSpecificOutput.permissionDecision, "allow");
  assert.match(rewriteDecision.hookSpecificOutput.updatedInput.command, /managed_payload_sha256/);
  assert.notEqual(rewriteDecision.hookSpecificOutput.updatedInput.command, staleHashPatch);
  const rewrittenPatch = rewriteDecision.hookSpecificOutput.updatedInput.command;
  assert.match(rewrittenPatch, /\n\+- managed_payload_sha256/);
  assert.doesNotMatch(rewrittenPatch, /@@\n-- managed_payload_sha256/);

  const orderedPatch = [
    "*** Begin Patch",
    `*** Update File: ${reportPath}`,
    "@@",
    "-# 夜间报告",
    "+# 夜间报告更新",
    "@@",
    "-rolling report",
    "+rolling report updated",
    "*** End Patch",
  ].join("\n");
  const orderedRewrite = await runHook("pre-tool-use", "codex", {
    session_id: sessionId,
    cwd: instoryRoot,
    tool_name: "apply_patch",
    tool_input: { command: orderedPatch },
  });
  assert.equal(orderedRewrite.code, 0, orderedRewrite.stderr);
  const orderedCommand = JSON.parse(orderedRewrite.stdout).hookSpecificOutput.updatedInput.command;
  const headingAt = orderedCommand.indexOf("-# 夜间报告");
  const hashRepairAt = orderedCommand.indexOf("@@\n-- managed_payload_sha256");
  const contentChangeAt = orderedCommand.indexOf("-rolling report");
  assert.ok(headingAt > 0 && headingAt < hashRepairAt && hashRepairAt < contentChangeAt,
    "hash repair must follow source order between surrounding content hunks");

  await writeFile(reportPath, updatedReport);
  const postValid = await runHook("post-tool-use", "codex", {
    session_id: sessionId,
    cwd: instoryRoot,
    hook_event_name: "PostToolUse",
    tool_name: "apply_patch",
    tool_input: { command: reportPatch },
  });
  assert.equal(postValid.code, 0, postValid.stderr);
  assert.match(postValid.stdout, /sha256-v1 校验通过/);
  await writeFile(reportPath, initialReport);

  const initialCrLfReport = managedReport("rolling report", "\r\n");
  const updatedCrLfReport = managedReport("rolling report updated", "\r\n");
  await writeFile(reportPath, initialCrLfReport);
  const crLfPatch = reportUpdatePatch(reportPath, initialCrLfReport, updatedCrLfReport);
  const crLfAllowed = await runHook("pre-tool-use", "codex", {
    session_id: sessionId,
    cwd: instoryRoot,
    tool_name: "apply_patch",
    tool_input: { command: crLfPatch },
  });
  assert.equal(crLfAllowed.code, 0, crLfAllowed.stderr);
  await writeFile(reportPath, initialReport);

  const blockedCases = [
    { cwd: "/other", tool_name: "Read", tool_input: { file_path: "/other/private.md" } },
    { tool_name: "Read", tool_input: { file_path: join(tempDir, "other.md") } },
    { tool_name: "Glob", tool_input: { path: instoryRoot, pattern: "../**/*" } },
    { tool_name: "exec_command", tool_input: { cmd: "git branch --show-current" } },
    { tool_name: "exec_command", tool_input: { cmd: "git status | cat" } },
    { tool_name: "exec_command", tool_input: { cmd: `rtk sed -i '' '1d' '${reportPath}'` } },
    { tool_name: "exec_command", tool_input: { cmd: `rtk sed -n '1,20p' '${reportPath}' '${join(instoryRoot, "README.md")}'` } },
    { tool_name: "exec_command", tool_input: { cmd: `rtk sed -n '1,20d' '${reportPath}'` } },
    { tool_name: "exec_command", tool_input: { cmd: `rtk cat '${reportPath}' '${join(instoryRoot, "README.md")}'` } },
    { tool_name: "exec_command", tool_input: { cmd: `rtk head -c 20 '${reportPath}'` } },
    { tool_name: "exec_command", tool_input: { cmd: `rtk tail -n 20 '${join(tempDir, "other.md")}'` } },
    { tool_name: "exec_command", tool_input: { cmd: `rtk cat '${reportPath}' > '${join(tempDir, "copy.md")}'` } },
    { tool_name: "exec_command", tool_input: { cmd: "node probe.mjs" } },
    { tool_name: "exec_command", tool_input: { cmd: "python3 -c 'print(1)'" } },
    { tool_name: "exec_command", tool_input: { cmd: "git add README.md" } },
    { tool_name: "exec_command", tool_input: { cmd: `shasum -a 256 '${join(tempDir, "other.md")}'` } },
    { tool_name: "mcp__context__context_prepare_turn", tool_input: {} },
    { tool_name: "mcp__context__context_commit_turn", tool_input: {} },
    { tool_name: "mcp__context__context_list_active_tasks", tool_input: {} },
    { tool_name: "mcp__context__context_list_active_tasks", tool_input: { project_id: "other" } },
    { tool_name: "mcp__taskcenter__taskcenter_task_create", tool_input: {} },
    { tool_name: "mcp__taskcenter__taskcenter_task_update", tool_input: {} },
    { tool_name: "mcp__taskcenter__taskcenter_delegation_claim", tool_input: {} },
    { tool_name: "mcp__taskcenter__taskcenter_task_query", tool_input: { session_id: "other-session" } },
    { tool_name: "mcp__taskcenter__taskcenter_task_query", tool_input: { session_id: sessionId, task_id: "other-task" } },
    { tool_name: "mcp__taskcenter__taskcenter_session_register", tool_input: { session_id: sessionId, workspace: join(tempDir, "Other") } },
    { tool_name: "mcp__taskcenter__taskcenter_scheduled_readonly_scan_exemption_status", tool_input: { session_id: "019f0000-0000-7000-8000-000000000999" } },
    { tool_name: "mcp__taskcenter__taskcenter_scheduled_readonly_scan_exemption_set", tool_input: { enabled: true, session_id: "019f0000-0000-7000-8000-000000000999" } },
    { tool_name: "apply_patch", tool_input: { patch: `*** Begin Patch\n*** Update File: ${join(instoryRoot, "README.md")}\n@@\n-inStory\n+changed\n*** End Patch` } },
    { tool_name: "apply_patch", tool_input: { command: `${reportPatch}\n*** Begin Patch\n*** Update File: ${join(instoryRoot, "README.md")}\n@@\n-inStory\n+changed\n*** End Patch` } },
    { tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Add File: ${reportPath}.new\n+new\n*** End Patch` } },
    { tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Delete File: ${reportPath}\n*** End Patch` } },
    { tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Update File: ${reportPath}\n*** Move to: ${reportPath}.moved\n@@\n-${initialReport.split("\n")[0]}\n+changed\n*** End Patch` } },
    { tool_name: "apply_patch", tool_input: { command: reportUpdatePatch(reportPath, initialReport, initialReport.replace("manual preface", "manual changed")) } },
    { tool_name: "apply_patch", tool_input: { command: reportUpdatePatch(reportPath, initialReport, initialReport.replace("<!-- AUTO-MANAGED-BEGIN -->", "<!-- AUTO-MANAGED-BEGIN-CHANGED -->")) } },
    { tool_name: "apply_patch", tool_input: { patch: "*** Begin Patch\n*** End Patch" } },
  ];
  await writeFile(join(tempDir, "other.md"), "outside\n");
  if (process.platform !== "win32") {
    const outsideLink = join(instoryRoot, "outside-link.md");
    await symlink(join(tempDir, "other.md"), outsideLink);
    blockedCases.push({ tool_name: "Read", tool_input: { file_path: outsideLink } });
  }
  for (const payload of blockedCases) {
    const result = await runHook("pre-tool-use", "codex", { session_id: sessionId, cwd: payload.cwd || instoryRoot, ...payload });
    assert.equal(result.code, 2, payload.tool_name || payload.tool_input?.cmd);
    assert.match(result.stderr, /scheduled_readonly/);
  }

  const badIdentity = [...profileArgs];
  badIdentity[badIdentity.indexOf("instory")] = "other-automation";
  const rejected = await runHook("pre-tool-use", "codex", { session_id: sessionId, cwd: instoryRoot, tool_name: "Read", tool_input: { file_path: join(instoryRoot, "README.md") } }, badIdentity);
  assert.equal(rejected.code, 2);
  assert.match(rejected.stderr, /automationId/);

  const payloadIdentity = await runHook("pre-tool-use", "codex", {
    session_id: sessionId,
    cwd: instoryRoot,
    profile: "scheduled_readonly",
    automation_id: "instory",
    project_id: "instory",
    workspace_root: instoryRoot,
    report_path: reportPath,
    task_mutation: false,
    pca_mutation: false,
    report_mutation: true,
    network: false,
    tool_name: "Read",
    tool_input: { file_path: join(instoryRoot, "README.md") },
  });
  assert.equal(payloadIdentity.code, 0);
  const scheduledMcp = await runHook("scheduled-pre-tool-use", "codex", {
    session_id: sessionId,
    cwd: instoryRoot,
    tool_name: "mcp__context__context_health_check",
    tool_input: {},
  });
  assert.equal(scheduledMcp.code, 0);

  await writeFile(reportPath, updatedReport.replace(/`[0-9a-f]{64}`/, "`" + "0".repeat(64) + "`"));
  const postInvalid = await runHook("post-tool-use", "codex", {
    session_id: sessionId,
    cwd: instoryRoot,
    hook_event_name: "PostToolUse",
    tool_name: "apply_patch",
    tool_input: reportPatch,
  });
  assert.equal(postInvalid.code, 2);
  assert.match(postInvalid.stderr, /写后 sha256-v1 校验失败/);

  const tasks = (await (await fetch(`${base}/tasks`)).json()).tasks;
  assert.equal(tasks.filter((task) => task.sessionId === sessionId).length, 0);
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
  const preparation = JSON.parse(context.hookSpecificOutput.additionalContext);
  assert.equal(preparation.task_id, null);
  assert.equal(preparation.session_id, sessionId);

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
  assert.equal(JSON.parse(JSON.parse(active.stdout).hookSpecificOutput.additionalContext).task_id, "prompt-preparation-task");
});

test("Stop 不因完成就绪度或 Review 缺口打断 Codex 回复", async () => {
  const sessionId = "019f0000-0000-7000-8000-000000000094";
  assert.equal((await runHook("session-start", "codex", { session_id: sessionId, cwd: "/work" })).code, 0);
  for (const [stopHookActive, lastAssistantMessage] of [
    [false, "修复已经完成，可以交付。"],
    [true, "任务完成。"],
    [false, "当前实现与验证已交付，但 required_review_missing。"],
    [false, "当前仍在处理，尚未完成。"],
  ]) {
    const result = await runHook("stop", "codex", {
      session_id: sessionId,
      cwd: "/work",
      hook_event_name: "Stop",
      turn_id: "turn-stop-advisory",
      stop_hook_active: stopHookActive,
      last_assistant_message: lastAssistantMessage,
    });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), { continue: true }, lastAssistantMessage);
  }
});

test("跨客户端共享任务保留创建者和证据，接手后旧 Session 失去写入权", async () => {
  const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "mcp" }, body: JSON.stringify(body) });
  for (const from of ["codex", "claude", "kimi"]) for (const to of ["codex", "claude", "kimi"]) {
    if (from === to) continue;
    const source = `handoff-${from}-${to}-source`, target = `handoff-${from}-${to}-target`;
    for (const [session_id, agent] of [[source, from], [target, to]]) assert.equal((await runHook("session-start", agent, { session_id, cwd: "/work" })).code, 0);
    const created = await (await post("/task-events", { type: "task.create", session_id: source, workspace: "/work", title: "共享任务", goal: "同一交付", plan: ["执行"], scope: ["probe"], non_goals: [], acceptance_criteria: ["通过"], contract_version: "v2", workflow_profile: "fast", review_policy: "recommended", evidence: ["创建时证据"] })).json();
    assert.equal(created.accepted, true, JSON.stringify(created));
    const task_id = created.task.id;
    const resume = () => post("/task-resume", { session_id: target, task_id, expected_session_id: source });
    assert.equal((await resume()).status, 200);
    assert.equal((await resume()).status, 200);
    const task = (await (await fetch(`${base}/tasks`)).json()).tasks.find(item => item.id === task_id);
    assert.equal(task.creatorActor.id, source);
    assert.equal(task.executorActor.id, target);
    assert.equal(task.agent, to);
    assert.equal(task.status, "in_progress");
    assert.equal(task.handoffs.length, 1);
    assert.equal(task.handoffs[0].fromSessionId, source);
    assert.equal(task.handoffs[0].toSessionId, target);
    if (to === "codex") await writeFile(paths.TASKCENTER_ROUTING_CONTROL_PATH, JSON.stringify({ version: 3, models: {}, routes: [{ id: `handoff-${target}`, taskId: task_id, channel: "direct", status: "leased", available: true, expiresAt: new Date(Date.now() + 120_000).toISOString() }] }));
    for (const field of ["goal", "scope", "acceptanceCriteria", "currentSubject", "evidence"]) assert.deepEqual(task[field], created.task[field], field);
    for (const event_id of [`stale-${source}`, `manual-stale-${source}`]) assert.equal((await post("/task-events", { type: "task.update", event_id, session_id: source, task_id, goal: "非法覆盖" })).status, 403);
    for (const [session_id, agent, expected] of [[source, from, 2], [target, to, 0]]) assert.equal((await runHook("pre-tool-use", agent, { session_id, cwd: "/work", tool_name: "Write", tool_input: { file_path: "/work/probe", content: "test" } })).code, expected);
  }
});

test("共享任务阻止有效委派和并发抢接", async () => {
  const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "mcp" }, body: JSON.stringify(body) });
  const source = "handoff-race-source", targets = ["handoff-race-claude", "handoff-race-kimi"];
  for (const session_id of [source, ...targets]) await runHook("session-start", "codex", { session_id, cwd: "/work" });
  const created = await (await post("/task-events", { type: "task.create", session_id: source, workspace: "/work", title: "race", goal: "race" })).json();
  const task_id = created.task.id;
  const grantResponse = await post("/delegations/grant", { parent_session_id: source, task_id, workspace: "/work", scope: ["."], executor_model: "test-model", ttl_seconds: 600 });
  assert.equal(grantResponse.status, 201);
  const grant = await grantResponse.json();
  const resume = session_id => post("/task-resume", { session_id, task_id, expected_session_id: source });
  const blocked = await resume(targets[0]);
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /ACTIVE_DELEGATION_CONFLICT/);
  assert.equal((await post("/delegations/revoke", { delegation_id: grant.delegation.id, parent_session_id: source })).status, 200);
  const results = await Promise.all(targets.map(resume));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const task = (await (await fetch(`${base}/tasks`)).json()).tasks.find(item => item.id === task_id);
  assert.equal(task.handoffs.length, 1);
  assert.equal((await post("/task-events", { type: "task.update", session_id: task.sessionId, task_id, status: "cancelled" })).status, 200);
  assert.equal((await resume(source)).status, 409);
});

test("可选 CLI 领取绑定路由与型号，错误路由不消耗授权", async () => {
  const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "hook" }, body: JSON.stringify(body) });
  const parent = "optional-cli-parent", child = "optional-cli-child";
  await runHook("session-start", "codex", { session_id: parent, cwd: "/work", model: "test-main" });
  const created = await (await post("/task-events", { type: "task.create", session_id: parent, workspace: "/work", title: "optional CLI", goal: "optional CLI" })).json();
  const selected = await (await post("/routing/select", { task_id: created.task.id, task_class: "test", channel: "cli", cli_profile: "claude-mimo" })).json();
  assert.equal(selected.accepted, true, JSON.stringify(selected));
  const route = selected.route;
  const grant = await (await post("/delegations/grant", { task_id: created.task.id, parent_session_id: parent, workspace: "/work", scope: ["."], executor_model: route.selected_model, ttl_seconds: 60 })).json();
  await runHook("session-start", "claude", { session_id: child, cwd: "/work", model: route.selected_model });
  const claim = { session_id: child, workspace: "/work", delegation_id: grant.delegation.id, claim_token: grant.claimToken, executor_model: route.selected_model };
  assert.equal((await post("/delegations/claim", { ...claim, route_id: "missing-route" })).status, 409);
  const response = await post("/delegations/claim", { ...claim, route_id: route.route_id });
  assert.equal(response.status, 200, await response.text());
});

test("原生委派绑定 native 路由，错配模型/路由/任务与已结束租约均拒绝", async () => {
  const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "hook" }, body: JSON.stringify(body) });
  const parent = "native-parent", child = "native-child", wrongChild = "native-child-wrong";
  await runHook("session-start", "codex", { session_id: parent, cwd: "/work", model: "test-main" });
  const created = await (await post("/task-events", { type: "task.create", session_id: parent, workspace: "/work", title: "native delegation", goal: "native delegation" })).json();
  const selected = await (await post("/routing/select", { task_id: created.task.id, task_class: "implementation", channel: "other", preferred_model: "mimo-v2.6-flash", available_native_models: ["xiaomi-tokenplan/mimo-v2.6-flash"] })).json();
  assert.equal(selected.accepted, true, JSON.stringify(selected));
  const route = selected.route;
  assert.equal(route.channel, "native");
  assert.equal(route.selected_model, "mimo-v2.6-flash");
  assert.equal(route.native_model, "xiaomi-tokenplan/mimo-v2.6-flash");

  const grantBody = { task_id: created.task.id, parent_session_id: parent, workspace: "/work", scope: ["."], executor_model: route.selected_model, channel: "native", ttl_seconds: 600 };
  assert.equal((await post("/delegations/grant", grantBody)).status, 409, "native grant 缺 route_id 拒绝");
  assert.equal((await post("/delegations/grant", { ...grantBody, route_id: route.route_id, executor_model: "mimo-v2.6-pro" })).status, 409, "canonical 模型与路由不一致拒绝");
  const grantResponse = await post("/delegations/grant", { ...grantBody, route_id: route.route_id });
  const grant = await grantResponse.json();
  assert.equal(grantResponse.status, 201, JSON.stringify(grant));
  assert.equal(grant.delegation.routeId, route.route_id);
  assert.equal((await post("/delegations/grant", { ...grantBody, route_id: route.route_id })).status, 409, "同一租约不能再授予第二执行器");

  await runHook("session-start", "codex", { session_id: wrongChild, cwd: "/work", model: "mimo-v2.6-flash" });
  await runHook("session-start", "codex", { session_id: child, cwd: "/work", model: "xiaomi-tokenplan/mimo-v2.6-flash" });
  const claim = { workspace: "/work", delegation_id: grant.delegation.id, claim_token: grant.claimToken, route_id: route.route_id, executor_model: route.selected_model };
  assert.equal((await post("/delegations/claim", { ...claim, session_id: wrongChild })).status, 409, "Session 模型不是路由 native_model 拒绝");
  assert.equal((await post("/delegations/claim", { ...claim, session_id: wrongChild, route_id: undefined, executor_model: undefined })).status, 409, "省略参数不能绕过已绑定路由校验");
  assert.equal((await post("/delegations/claim", { ...claim, session_id: parent })).status, 409, "父会话不能领取原生子会话授权");
  await runHook("session-start", "claude", { session_id: "native-wrong-client", cwd: "/work", model: route.native_model });
  assert.equal((await post("/delegations/claim", { ...claim, session_id: "native-wrong-client" })).status, 409, "相同模型的非 Codex 客户端不能领取原生授权");
  await runHook("session-start", "codex", { session_id: "native-wrong-workspace", cwd: "/other", model: route.native_model });
  assert.equal((await post("/delegations/claim", { ...claim, session_id: "native-wrong-workspace" })).status, 403, "工作区不一致拒绝");
  assert.equal((await post("/delegations/claim", { ...claim, session_id: child, route_id: "missing-route" })).status, 409);
  const claimed = await post("/delegations/claim", { ...claim, session_id: child, route_id: undefined, executor_model: undefined });
  const claimedPayload = await claimed.json();
  assert.equal(claimed.status, 200, JSON.stringify(claimedPayload));
  const touch = { delegation_id: grant.delegation.id, session_id: child, workspace: "/work", tool_name: "Read", paths: ["/work/a.txt"] };
  assert.equal((await post("/delegations/touch", touch)).status, 200);
  assert.equal((await post("/delegations/touch", { ...touch, paths: ["/outside/a.txt"] })).status, 403);

  const released = await post("/routing/result", { route_id: route.route_id, outcome: "succeeded" });
  assert.equal(released.status, 200);
  const health = await (await fetch(`${base}/routing/health`)).json();
  assert.equal(health.models.find((item) => item.model === "mimo-v2.6-flash").active_executors, 0, "原生终态释放 canonical 租约");
  assert.equal((await post("/delegations/claim", { ...claim, session_id: child, route_id: undefined })).status, 409, "已结束路由不能重新 claim");
  assert.equal((await post("/delegations/touch", touch)).status, 409, "已结束路由不能继续执行工具");
});

test("显式 Codex native route 可 grant/claim，且拒绝错配与过期租约", async () => {
  const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "hook" }, body: JSON.stringify(body) });
  const parent = "native-codex-parent", child = "native-codex-child", wrongChild = "native-codex-wrong", expiredChild = "native-codex-expired";
  await runHook("session-start", "codex", { session_id: parent, cwd: "/work", model: "test-main" });
  const created = await (await post("/task-events", { type: "task.create", session_id: parent, workspace: "/work", title: "explicit Codex native", goal: "explicit Codex native" })).json();

  const unsupported = await (await post("/routing/select", {
    task_id: created.task.id, task_class: "implementation", channel: "native", preferred_model: "gpt-6-luna",
    available_native_models: ["gpt-6-astra"], event_id: "native-codex-unavailable",
  })).json();
  assert.equal(unsupported.route.available, false, "未声明目标 runtime 的能力必须拒绝路由");

  const selected = await (await post("/routing/select", {
    task_id: created.task.id, task_class: "implementation", channel: "native", preferred_model: "gpt-6-luna",
    available_native_models: ["gpt-6-luna"], event_id: "native-codex-route",
  })).json();
  assert.equal(selected.accepted, true, JSON.stringify(selected));
  const route = selected.route;
  assert.equal(route.channel, "native");
  assert.equal(route.selected_model, "gpt-6-luna");
  assert.equal(route.native_model, "gpt-6-luna");

  const grantBody = { task_id: created.task.id, parent_session_id: parent, workspace: "/work", scope: ["."], executor_model: route.selected_model, channel: "native", route_id: route.route_id, ttl_seconds: 600 };
  assert.equal((await post("/delegations/grant", { ...grantBody, task_id: "wrong-task" })).status, 409, "错误任务拒绝");
  assert.equal((await post("/delegations/grant", { ...grantBody, executor_model: "gpt-6-astra" })).status, 409, "canonical/runtime 型号错配拒绝");
  const grantResponse = await post("/delegations/grant", grantBody);
  const grant = await grantResponse.json();
  assert.equal(grantResponse.status, 201, JSON.stringify(grant));
  assert.equal(grant.delegation.routeId, route.route_id);

  await runHook("session-start", "codex", { session_id: wrongChild, cwd: "/work", model: "gpt-6-astra" });
  await runHook("session-start", "codex", { session_id: child, cwd: "/work", model: "gpt-6-luna" });
  const claim = { workspace: "/work", delegation_id: grant.delegation.id, claim_token: grant.claimToken, route_id: route.route_id, executor_model: route.selected_model };
  assert.equal((await post("/delegations/claim", { ...claim, session_id: wrongChild })).status, 409, "领取 Session 型号错配拒绝");
  const claimed = await post("/delegations/claim", { ...claim, session_id: child });
  assert.equal(claimed.status, 200, await claimed.text());
  assert.equal((await post("/routing/result", { route_id: route.route_id, outcome: "succeeded" })).status, 200);
  assert.equal((await post("/delegations/claim", { ...claim, session_id: child })).status, 409, "已结束路由拒绝再次 claim");

  const expiring = await (await post("/routing/select", {
    task_id: created.task.id, task_class: "implementation", channel: "native", preferred_model: "gpt-6-luna",
    available_native_models: ["gpt-6-luna"], event_id: "native-codex-expiring-route",
  })).json();
  const expiredRoute = expiring.route;
  const expiredGrantResponse = await post("/delegations/grant", { ...grantBody, route_id: expiredRoute.route_id, event_id: "native-codex-expiring-grant" });
  const expiredGrant = await expiredGrantResponse.json();
  assert.equal(expiredGrantResponse.status, 201, JSON.stringify(expiredGrant));
  await runHook("session-start", "codex", { session_id: expiredChild, cwd: "/work", model: "gpt-6-luna" });
  const state = JSON.parse(await readFile(paths.TASKCENTER_ROUTING_CONTROL_PATH, "utf8"));
  const storedRoute = state.routes.find(item => item.id === expiredRoute.route_id);
  assert.ok(storedRoute);
  storedRoute.expiresAt = new Date(Date.now() - 1_000).toISOString();
  await writeFile(paths.TASKCENTER_ROUTING_CONTROL_PATH, JSON.stringify(state));
  assert.equal((await post("/delegations/claim", { workspace: "/work", delegation_id: expiredGrant.delegation.id, claim_token: expiredGrant.claimToken, route_id: expiredRoute.route_id, executor_model: expiredRoute.selected_model, session_id: expiredChild })).status, 409, "过期路由拒绝 claim");
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
  await writeFile(paths.TASKCENTER_ROUTING_CONTROL_PATH, JSON.stringify({ version: 3, models: {}, routes: [{ id: "legacy-direct", taskId: "hook-gate-task", channel: "direct", status: "leased", available: true, expiresAt: new Date(Date.now() + 120_000).toISOString() }] }));
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

async function runHook(action, agent, payload, extraArgs = [], controlUrl = base) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hook, action, "--agent", agent, ...extraArgs], {
      cwd: root,
      env: { ...process.env, ...paths, TASKCENTER_CONTROL_URL: controlUrl },
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

function managedReport(content, eol = "\n") {
  const before = `${eol}# 夜间报告${eol}${eol}`;
  const after = `${content}${eol}`;
  const hash = createHash("sha256").update(`${before}${after}`).digest("hex");
  return `manual preface${eol}<!-- AUTO-MANAGED-BEGIN -->${before}- managed_payload_sha256：\`${hash}\`${eol}${after}<!-- AUTO-MANAGED-END -->${eol}manual suffix${eol}`;
}

function reportUpdatePatch(path, before, after) {
  const beforeLines = before.trimEnd().split(/\r?\n/);
  const afterLines = after.trimEnd().split(/\r?\n/);
  return [
    "*** Begin Patch",
    `*** Update File: ${path}`,
    "@@",
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
    "*** End Patch",
  ].join("\n");
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


test("当前 native-only 策略拒绝新 CLI 授权，保留 native grant/claim", async () => {
  const original = await readFile(paths.TASKCENTER_MODEL_ROLE_CONFIG_PATH, "utf8");
  await writeFile(paths.TASKCENTER_MODEL_ROLE_CONFIG_PATH, await readFile(new URL("config/model-roles.json", root), "utf8"));
  const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "hook" }, body: JSON.stringify(body) });
  try {
    const parent = "native-only-parent", child = "native-only-child";
    await runHook("session-start", "codex", { session_id: parent, cwd: "/work", model: "test-main" });
    const created = await (await post("/task-events", { type: "task.create", session_id: parent, workspace: "/work", title: "native-only", goal: "native-only" })).json();
    const baseGrant = { task_id: created.task.id, parent_session_id: parent, workspace: "/work", scope: ["."], executor_model: "mimo-v2.6-flash", ttl_seconds: 600 };
    for (const channel of ["cli", "other", undefined]) {
      const rejected = await post("/delegations/grant", { ...baseGrant, channel });
      assert.equal(rejected.status, 409);
      assert.match(await rejected.text(), /CLI_DISPATCH_DISABLED/);
    }
    const rejectedRoute = await post("/routing/select", { task_id: created.task.id, task_class: "implementation", channel: "cli" });
    assert.equal(rejectedRoute.status, 409);
    const selected = await (await post("/routing/select", { task_id: created.task.id, task_class: "implementation", channel: "other", available_native_models: ["xiaomi-tokenplan/mimo-v2.6-flash"] })).json();
    assert.equal(selected.route.native_model, "xiaomi-tokenplan/mimo-v2.6-flash");
    const granted = await post("/delegations/grant", { ...baseGrant, channel: "native", route_id: selected.route.route_id });
    const grant = await granted.json();
    assert.equal(granted.status, 201, JSON.stringify(grant));
    await runHook("session-start", "codex", { session_id: child, cwd: "/work", model: "xiaomi-tokenplan/mimo-v2.6-flash" });
    const claimed = await post("/delegations/claim", { workspace: "/work", session_id: child, delegation_id: grant.delegation.id, claim_token: grant.claimToken, executor_model: baseGrant.executor_model, route_id: selected.route.route_id });
    assert.equal(claimed.status, 200, await claimed.text());
    await post("/routing/result", { route_id: selected.route.route_id, outcome: "succeeded" });
  } finally {
    await writeFile(paths.TASKCENTER_MODEL_ROLE_CONFIG_PATH, original);
  }
});
