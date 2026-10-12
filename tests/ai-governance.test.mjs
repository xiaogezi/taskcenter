import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { aiActivity, createGovernanceRunner, governanceSnapshot, validateGovernanceResult } from "../scripts/ai-governance.mjs";
import { controlProxyTarget, isAllowedControlPath } from "../lib/control-proxy.mjs";
const task = { id: "task-test", title: "验证导出", goal: "导出全部记录", status: "blocked", blocker: "导出缺行", acceptanceCriteria: ["数量一致"], tests: ["单条导出通过"], evidence: ["/Users/example/private/report.log"], verificationClaims: [{ id: "export", status: "passed", summary: "仅验证单条记录" }] };
const result = { summary: "尚未证明完整导出", findings: [{ severity: "medium", basis: "insufficient_data", message: "单条测试不能证明完整导出", evidence_refs: ["criterion:1", "verification:1"] }], next_steps: ["增加多条记录的数量核对"] };

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
  await assert.rejects(aiActivity({ ...options, params: new URLSearchParams({ limit: "999" }) }), /参数/);
});
test("治理代理只允许固定路径与查询字段", () => {
  assert.equal(isAllowedControlPath("/ai/analyze", "POST"), true); assert.equal(isAllowedControlPath("/ai/execute", "POST"), false);
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
