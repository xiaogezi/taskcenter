import assert from "node:assert/strict";
import { parseInferenceJson } from "../scripts/claude-inference.mjs";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentGuidance, aiActivity, readActivityPage, presentActivity, collaborationRules, createGovernanceRunner, governanceSnapshot, validateGovernanceResult } from "../scripts/ai-governance.mjs";
import { controlProxyTarget, isAllowedControlPath } from "../lib/control-proxy.mjs";
const task = { id: "task-test", title: "验证导出", goal: "导出全部记录", status: "blocked", blocker: "导出缺行", acceptanceCriteria: ["数量一致"], tests: ["单条导出通过"], evidence: ["/Users/example/private/report.log"], verificationClaims: [{ id: "export", status: "passed", summary: "仅验证单条记录" }] };
const result = { summary: "尚未证明完整导出", findings: [{ severity: "medium", basis: "insufficient_data", message: "单条测试不能证明完整导出", evidence_refs: ["criterion:1", "verification:1"] }], next_steps: ["增加多条记录的数量核对"] };

test("完成声明不再触发补证据、query或AI收尾建议，恢复执行后仍提示缺口", () => {
  const closed = { ...task, status: "done_claimed", workflowProfile: "standard", verificationClaims: [], tests: [], evidence: [] };
  assert.deepEqual(collaborationRules(closed).steps, []);
  assert.deepEqual(agentGuidance(closed, "/unavailable/optional-analysis.jsonl").steps, []);
  assert.ok(collaborationRules({ ...closed, status: "in_progress" }).steps.length);
});

test("治理快照选取受限摘要、隐去本机路径、截断前筛查密钥", () => {
  const snapshot = governanceSnapshot(task, "evidence");
  assert.ok(JSON.stringify(snapshot).includes("[local-path]")); assert.ok(!JSON.stringify(snapshot).includes("/Users/"));
  assert.equal(snapshot.input_hash.length, 64);
  assert.equal(governanceSnapshot({ ...task, evidence: Array(21).fill("摘要") }, "blockers").truncated, true);
  assert.throws(() => governanceSnapshot({ ...task, goal: `${"x".repeat(4000)} api_key=abcdefghijklmnop` }, "evidence"), /凭据/);
  assert.throws(() => governanceSnapshot(task, "execute"), /类型/);
});
test("AI 结果必须引用有效证据，拒绝虚构引用与秘密", () => {
  const snapshot = governanceSnapshot(task, "evidence");
  assert.deepEqual(validateGovernanceResult(result, snapshot), result);
  assert.throws(() => validateGovernanceResult({ ...result, findings: [{ ...result.findings[0], evidence_refs: ["missing"] }] }, snapshot), /AI_INVALID_OUTPUT/);
  assert.throws(() => validateGovernanceResult({ ...result, next_steps: ["api_key=abcdefghijklmnop"] }, snapshot), /AI_INVALID_OUTPUT/);
});
test("治理调用校验快照授权、限制并发、记录成功失败且不改任务", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ai-test-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "activity"), snapshot = governanceSnapshot(task, "evidence");
  let release;
  const runner = createGovernanceRunner({ path, profileFor: () => ({ harness: "claude", model: "deepseek-test" }), infer: () => new Promise(resolve => { release = resolve; }) });
  const input = { kind: "evidence", confirm_data_scope: true, input_hash: snapshot.input_hash };
  assert.throws(() => runner.start(task, { ...input, confirm_data_scope: false }), /确认/);
  assert.throws(() => runner.start(task, { ...input, input_hash: "stale" }), /变化/);
  runner.start(task, input); assert.equal(runner.running, true); assert.equal(runner.start(task, input).status, "degraded");
  release({ text: JSON.stringify(result), model: "deepseek-test", usage: { input_tokens: 50, output_tokens: 20 } });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(runner.running, false);
  const records = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(records.map(row => row.status), ["started", "degraded", "succeeded"]); assert.equal(records[1].fallback_reason, "AI_BUSY"); assert.equal(task.status, "blocked");
  const invalid = createGovernanceRunner({ path, profileFor: () => ({ harness: "claude", model: "deepseek-test" }), infer: async () => ({ text: "invalid" }) });
  invalid.start(task, input); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await readFile(path, "utf8")).trim().split("\n").map(JSON.parse).at(-1).status, "degraded");
});
test("统一行为涵盖主线 Jev 与治理，分页与筛选不混淆", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ai-log-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "activity"), jevPath = join(dir, "jev");
  await writeFile(path, `${JSON.stringify({ id: "g", source: "governance", at: "2026-10-12T00:00:00Z", task_id: "t", status: "succeeded" })}\n`);
  await writeFile(jevPath, `${JSON.stringify({ observed_at: "2026-10-12T00:00:01Z", task_id: "t", status: "skipped", reason: "busy" })}\n`);
  const options = { path, jevPath, routes: [{ route_id: "r", task_id: "t", created_at: "2026-10-12T00:00:02Z", status: "leased", jev_decision: { status: "succeeded", execution_choice: "delegate" } }], delegations: [{ id: "d", taskId: "t", createdAt: "2026-10-12T00:00:03Z", status: "issued" }] };
  const first = await aiActivity({ ...options, params: new URLSearchParams({ limit: "1" }) });
  const second = await aiActivity({ ...options, params: new URLSearchParams({ limit: "1", before: first.next_cursor }) });
  assert.equal(new Set([...first.rows, ...second.rows].map(row => row.id)).size, 2);
  assert.equal((await aiActivity({ ...options, params: new URLSearchParams({ source: "jev" }) })).rows.length, 1);
  await writeFile(path, `${JSON.stringify({ id: "maintenance", source: "maintenance", at: "2026-10-12T00:00:04Z", task_id: "t", status: "tool_completed", result: { tool_use_id: "tool-1" } })}\n`, { flag: "a" });
  const actions = await aiActivity({ ...options, params: new URLSearchParams({ source: "maintenance" }) });
  assert.equal(actions.rows.length, 1); assert.equal(actions.rows[0].result.tool_use_id, "tool-1");
  await assert.rejects(aiActivity({ ...options, params: new URLSearchParams({ limit: "999" }) }), /参数/);
});
test("治理代理只允许固定路径与查询字段", () => {
  assert.equal(isAllowedControlPath("/ai/analyze", "POST"), true); assert.equal(isAllowedControlPath("/ai/work", "POST"), true); assert.equal(isAllowedControlPath("/ai/work", "GET"), false); assert.equal(isAllowedControlPath("/ai/execute", "POST"), false);
  assert.equal(controlProxyTarget("/ai/activity", "?source=jev&limit=20&command=rm")?.search, "?source=jev&limit=20");
});

test("CLI 缺失、认证失败、超时与模型不匹配均回退规则，不重试或改变任务", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ai-fallback-")); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [label, failure, expected] of [["missing", Object.assign(new Error("missing"), { code: "ENOENT" }), "AI_CLI_UNAVAILABLE"], ["auth", new Error("auth failed"), "AI_CALL_FAILED"], ["timeout", Object.assign(new Error("timeout"), { killed: true }), "AI_TIMEOUT"], ["model", new Error("CLI_MODEL_MISMATCH"), "CLI_MODEL_MISMATCH"]]) {
    const path = join(dir, label); let calls = 0;
    const runner = createGovernanceRunner({ path, profileFor: () => ({ harness: "claude", model: "test" }), infer: async () => { calls++; throw failure; } });
    const snapshot = governanceSnapshot(task, "evidence");
    runner.start(task, { kind: "evidence", confirm_data_scope: true, input_hash: snapshot.input_hash });
    await new Promise(resolve => setTimeout(resolve, 10));
    const rows = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(rows.map(row => row.status), ["started", "failed", "degraded"]);
    assert.equal(rows.at(-1).fallback_reason, expected); assert.equal(rows.at(-1).model, "rules"); assert.equal(calls, 1); assert.equal(runner.running, false); assert.equal(task.status, "blocked");
  }
  const path = join(dir, "config");
  const runner = createGovernanceRunner({ path, profileFor: () => { throw new Error("invalid configuration"); }, infer: () => { assert.fail("不能启动 CLI"); } });
  runner.start(task, { kind: "blockers", confirm_data_scope: true, input_hash: governanceSnapshot(task, "blockers").input_hash });
  const rows = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(rows.at(-1).fallback_reason, "AI_CONFIG_UNAVAILABLE");
});

test("主线 AI 推理独立于派发配置并禁用工具、MCP 和持久化", async t => {
  const { runClaudeInference } = await import("../scripts/claude-inference.mjs");
  const dir = await mkdtemp(join(tmpdir(), "ai-inference-cli-"));
  const originalPath = process.env.PATH;
  const entry = join(dir, "fixture.mjs");
  const record = join(dir, "request.json");
  await writeFile(entry, `import fs from 'node:fs'; let prompt=''; for await(const chunk of process.stdin) prompt+=chunk; fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),prompt})); console.log(JSON.stringify({subtype:'success',result:'ok',modelUsage:{fixture:{}},usage:{input_tokens:1}}));`);
  if (process.platform === "win32") await writeFile(join(dir, "claude.cmd"), '@echo off\n"%dp0%/node.exe" "%dp0%/fixture.mjs" %*');
  else await writeFile(join(dir, "claude"), `#!${process.execPath}\nimport './fixture.mjs';`, { mode: 0o700 });
  process.env.PATH = dir;
  t.after(async () => { process.env.PATH = originalPath; await rm(dir, { recursive: true, force: true }); });
  assert.equal((await runClaudeInference({ profile: { model: "fixture", effort: "low" }, prompt: "bounded snapshot" })).text, "ok");
  const request = JSON.parse(await readFile(record, "utf8"));
  assert.equal(request.prompt, "bounded snapshot");
  assert.notEqual(request.cwd, process.cwd());
  for (const flag of ["--safe-mode", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]) assert.ok(request.args.includes(flag));
  assert.equal(request.args[request.args.indexOf("--tools") + 1], "");
  assert.deepEqual(JSON.parse(request.args[request.args.indexOf("--mcp-config") + 1]), { mcpServers: {} });
  await assert.rejects(runClaudeInference({ profile: { model: "other", effort: "low" }, prompt: "bounded snapshot" }), /CLI_MODEL_MISMATCH/);
});


test("并发时间线共享日志读取，保留独立账本回执并在日志替换后刷新", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ai-poll-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const reconciliationPath = join(dir, "reconcile");
  const options = { reconciliationPath, params: new URLSearchParams({ source: "reconciliation" }) };
  const log = id => JSON.stringify({ observedAt: "2026-11-20T01:00:00Z", actions: [{ event_id: id, task_id: "t" }] }) + "\n";
  await writeFile(reconciliationPath, log("a"));
  const pages = await Promise.all(Array.from({ length: 6 }, () => readActivityPage(options)));
  for (const page of pages) assert.equal(page.logs, pages[0].logs);
  assert.equal((await readActivityPage(options)).logs, pages[0].logs);
  const optionsWithTask = { tasks: [{ id: "other", executionReconciliation: { observed_at: "2026-11-20T02:00:00Z", event_id: "b" } }] };
  assert.deepEqual(presentActivity(pages[0], optionsWithTask).rows.map(row => row.id), ["b", "a"]);
  assert.deepEqual(presentActivity(pages[1], {}).rows.map(row => row.id), ["a"]);
  const replacement = join(dir, "replacement");
  await writeFile(replacement, log("c"));
  await rename(replacement, reconciliationPath);
  assert.deepEqual((await aiActivity(options)).rows.map(row => row.id), ["c"]);
});

test("实际处置日志加入AI时间线，可按任务与来源查询成功和失败", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ai-reconcile-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const reconciliationPath = join(dir, "reconcile");
  await writeFile(reconciliationPath, JSON.stringify({ observedAt: "2026-10-12T00:00:00Z", actions: [{ task_id: "t", action: "execution_unconfirmed", status: "succeeded", basis: "run:r" }, { task_id: "other", action: "recovery_pending", status: "failed", error: "sealed" }] }) + "\n");
  const options = { path: join(dir, "ai"), jevPath: join(dir, "jev"), reconciliationPath };
  const all = await aiActivity({ ...options, params: new URLSearchParams({ source: "reconciliation" }) });
  assert.equal(all.rows.length, 2);
  assert.ok(all.rows.some(row => row.status === "failed" && row.result.error === "sealed"));
  const filtered = await aiActivity({ ...options, params: new URLSearchParams({ source: "reconciliation", task_id: "t" }) });
  assert.equal(filtered.rows.length, 1);
  assert.equal(filtered.rows[0].result.basis, "run:r");
  const receipt = await aiActivity({ ...options, params: new URLSearchParams({ task_id: "lost" }), tasks: [{ id: "lost", executionReconciliation: { event_id: "reconcile-lost", observed_at: "2026-10-12T00:00:01Z", state: "recovery_pending", basis: "session_end_unconfirmed", next_action: "恢复原任务" } }] });
  assert.equal(receipt.rows[0].id, "reconcile-lost");
  assert.equal(receipt.rows[0].result.next_action, "恢复原任务");
});
test("推理JSON兼容完整代码块，仍拒绝散文、多个代码块和无效JSON", () => {
  for (const text of ['{"ok":true}', '```json\n{"ok":true}\n```', '  ```\n{"ok":true}\n```  ']) assert.deepEqual(parseInferenceJson(text), { ok: true });
  for (const text of ['解释\n```json\n{"ok":true}\n```', '```json\n{}\n```\n```json\n{}\n```', '```json\ninvalid\n```']) assert.throws(() => parseInferenceJson(text));
});
