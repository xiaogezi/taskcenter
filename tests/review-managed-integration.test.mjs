import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

for (const manual of [false, true]) test(`${manual ? "manual" : "managed"} MCP lifecycle claims, restores, reports and releases`, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "managed-review-"));
  const env = { ...process.env, TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION: "1", TASKCENTER_CONTEXT_BRIDGE_ENABLED: "false" };
  delete env.TASKCENTER_MANAGED_REVIEW;
  for (const key of ["TASK_LEDGER", "TASK_EVENTS", "TASK_EVENT_IDS", "TASK_RECONCILE", "SESSION_REGISTRY", "SESSION_MERGES", "ROUTING_CONTROL", "DELEGATIONS", "BUG_DISPATCHES", "DISPATCHES", "DASHBOARD", "MCP_TOKEN", "CONTEXT_TASK_MAP", "CONTEXT_AUDIT"]) env[`TASKCENTER_${key}_PATH`] = join(dir, key);
  const owner = "01a0893d-fd11-74a3-b094-2f116a7992cc";
  const reviewer = "01a089aa-23a5-7822-8296-6777b611ebe4";
  const roles = JSON.parse(await readFile("config/model-roles.json", "utf8"));
  const subject = { type: "artifact", value: "managed-fixture", observed_at: new Date().toISOString() };
  await writeFile(env.TASKCENTER_TASK_LEDGER_PATH, JSON.stringify([{ id: "managed-task", sessionId: owner, workspace: dir, status: "done_claimed", currentSubject: subject, reviewAttestations: [], reviewCycles: [] }]));
  await writeFile(env.TASKCENTER_SESSION_REGISTRY_PATH, JSON.stringify({ [owner]: { model: "main-test", workspace: tmpdir() } }));
  const preview = join(dir, "preview.json");
  await writeFile(preview, JSON.stringify({ reviewable_files: [{ path: "a.mjs" }] }));
  const port = 39000 + Math.floor(Math.random() * 10000);
  env.TASKCENTER_CONTROL_PORT = String(port);
  env.TASKCENTER_CONTROL_URL = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["scripts/control-server.mjs"], { env, stdio: "ignore" });
  t.after(async () => { child.kill(); await rm(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${env.TASKCENTER_CONTROL_URL}/health`)).ok) break; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const headers = { "Content-Type": "application/json", "X-TaskCenter-Task": "mcp", "X-TaskCenter-MCP-Token": (await readFile(env.TASKCENTER_MCP_TOKEN_PATH, "utf8")).trim() };
  const updated = await fetch(`${env.TASKCENTER_CONTROL_URL}/task-events`, { method: "POST", headers, body: JSON.stringify({ type: "task.update", task_id: "managed-task", session_id: owner, current_step: "request review" }) });
  const update = await updated.json();
  assert.equal(updated.ok, true, JSON.stringify(update));
  assert.equal(update.task.workspace, dir);
  const response = await fetch(`${env.TASKCENTER_CONTROL_URL}/routing/select`, { method: "POST", headers, body: JSON.stringify({ task_id: "managed-task", session_id: owner, task_class: "ocr_review", channel: "cli", review_artifacts: { subject: { ref: subject.value }, bundle: { ref: preview }, rules: { ref: "fixture-rules" } } }) });
  const selected = await response.json();
  assert.equal(response.ok, true, JSON.stringify(selected));
  let failReport = false;
  let failRelease = false;
  let reportAttempt = 0;
  if (manual) {
    const target = env.TASKCENTER_CONTROL_URL;
    const proxy = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      if (request.url === "/task-events" && JSON.parse(raw).type === "review.reported") {
        const body = JSON.parse(raw);
        body.review_attestation.observed_at = new Date(1780000000000 + reportAttempt++ * 1000).toISOString();
        raw = JSON.stringify(body);
      }
      if (failRelease && request.url === "/routing/result") { failRelease = false; response.destroy(); return; }
      const upstream = await fetch(`${target}${request.url}`, { method: request.method, headers: request.headers, ...(raw ? { body: raw } : {}) });
      const payload = await upstream.text();
      if (failReport && request.url === "/task-events" && JSON.parse(raw).type === "review.reported") { failReport = false; response.destroy(); return; }
      response.writeHead(upstream.status, { "Content-Type": "application/json" });
      response.end(payload);
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    t.after(() => proxy.close());
    env.TASKCENTER_CONTROL_URL = `http://127.0.0.1:${proxy.address().port}`;
  }
  for (const key of ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "TASKCENTER_CALLER_SESSION_ID"]) delete env[key];
  env.TASKCENTER_CALLER_SESSION_ID = reviewer;
  const launch = { route_id: selected.route.route_id, claim_token: selected.route.review_record.claim_token, workspace: dir, model: roles.roles.reviewer.model, sandbox: "read-only" };
  if (!manual) env.TASKCENTER_MANAGED_REVIEW = JSON.stringify(launch);
  let client;
  const connect = async () => {
    client = new Client({ name: "managed-test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["scripts/taskcenter-mcp.mjs"], env, stderr: "pipe" }));
  };
  await connect();
  t.after(() => client.close());
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  const manualArgs = { route_id: launch.route_id, claim_token: launch.claim_token, sandbox: "read-only" };
  if (manual) {
    const registered = await call("taskcenter_session_register", { session_id: reviewer, workspace: dir, model: launch.model });
    assert.equal(registered.accepted, true, JSON.stringify(registered));
    assert.equal((await call("taskcenter_review_start", {})).code, "REVIEW_ROUTE_REQUIRED");
    assert.equal((await call("taskcenter_review_start", { ...manualArgs, claim_token: "wrong" })).code, "REVIEW_PERMISSION_DENIED");
    for (const mismatch of [{ workspace: tmpdir(), model: launch.model }, { workspace: dir, model: "wrong-model" }]) {
      await call("taskcenter_session_register", { session_id: reviewer, ...mismatch });
      assert.equal((await call("taskcenter_review_start", manualArgs)).code, "REVIEW_PERMISSION_DENIED");
    }
    await call("taskcenter_session_register", { session_id: reviewer, workspace: dir, model: launch.model });
    const unsafe = await fetch(`${env.TASKCENTER_CONTROL_URL}/reviews/start`, { method: "POST", headers, body: JSON.stringify({ ...manualArgs, session_id: reviewer, manual: true, sandbox: "workspace-write" }) });
    assert.equal(unsafe.status, 403);
  }
  const started = await call("taskcenter_review_start", manual ? manualArgs : {});
  assert.equal(started.accepted, true, JSON.stringify(started));
  assert.equal(started.context.reviewer.session_id, reviewer);
  if (manual) {
    await client.close();
    await connect();
    const restored = await call("taskcenter_review_start", {});
    assert.equal(restored.accepted, true, JSON.stringify(restored));
    assert.equal(restored.context.cycle_id, started.context.cycle_id);
    await client.close();
    env.TASKCENTER_CALLER_SESSION_ID = owner;
    await connect();
    assert.equal((await call("taskcenter_review_start", manualArgs)).code, "REVIEW_PERMISSION_DENIED");
    await client.close();
    env.TASKCENTER_CALLER_SESSION_ID = reviewer;
    await connect();
    assert.equal((await call("taskcenter_review_start", {})).accepted, true);
    const ledger = JSON.parse(await readFile(env.TASKCENTER_TASK_LEDGER_PATH, "utf8"));
    ledger[0].currentSubject = { ...subject, value: "changed" };
    await writeFile(env.TASKCENTER_TASK_LEDGER_PATH, JSON.stringify(ledger));
    assert.equal((await call("taskcenter_review_start", { route_id: launch.route_id })).code, "SUBJECT_MISMATCH");
    ledger[0].currentSubject = subject;
    await writeFile(env.TASKCENTER_TASK_LEDGER_PATH, JSON.stringify(ledger));
    const routing = JSON.parse(await readFile(env.TASKCENTER_ROUTING_CONTROL_PATH, "utf8"));
    const route = routing.routes.find((item) => item.id === launch.route_id);
    const expiresAt = route.expiresAt;
    route.expiresAt = "2000-01-01T00:00:00.000Z";
    await writeFile(env.TASKCENTER_ROUTING_CONTROL_PATH, JSON.stringify(routing));
    assert.equal((await call("taskcenter_review_start", { route_id: launch.route_id })).code, "REVIEWER_LEASE_UNAVAILABLE");
    route.expiresAt = expiresAt;
    await writeFile(env.TASKCENTER_ROUTING_CONTROL_PATH, JSON.stringify(routing));
  }
  const result = { reviewed_files: [], findings: [], spec_verdict: "compliant", quality_verdict: "approved", verdict: "approved", summary: "fixture" };
  assert.match((await call("taskcenter_review_finish", result)).message, /COVERAGE_INCOMPLETE/);
  const complete = { ...result, reviewed_files: ["a.mjs"] };
  if (manual) {
    failReport = true;
    const lostReport = await call("taskcenter_review_finish", complete);
    assert.equal(lostReport.error, "REVIEW_FINISH_FAILED");
    assert.equal(lostReport.stage, "report");
    const interrupted = JSON.parse(await readFile(env.TASKCENTER_ROUTING_CONTROL_PATH, "utf8"));
    const record = interrupted.routes.find((route) => route.id === launch.route_id).reviewRecord;
    delete record.attestation_id;
    record.status = "running";
    await writeFile(env.TASKCENTER_ROUTING_CONTROL_PATH, JSON.stringify(interrupted));
    await client.close();
    await connect();
    assert.equal((await call("taskcenter_review_start", {})).accepted, true);
    failRelease = true;
    const lostRelease = await call("taskcenter_review_finish", complete);
    assert.equal(lostRelease.error, "REVIEW_FINISH_FAILED");
    assert.equal(lostRelease.stage, "release");
    assert.equal(lostRelease.report_status, "accepted");
    await client.close();
    await connect();
    assert.equal((await call("taskcenter_review_start", {})).accepted, true);
  }
  const finished = await call("taskcenter_review_finish", complete);
  assert.equal(finished.accepted, true, JSON.stringify(finished));
  assert.equal(finished.lease_released, true);
  if (manual) {
    await client.close();
    await connect();
    assert.equal((await call("taskcenter_review_start", { route_id: launch.route_id })).accepted, true);
    assert.equal((await call("taskcenter_review_finish", complete)).lease_released, true);
    assert.equal((await call("taskcenter_review_finish", { ...complete, summary: "different conclusion" })).error, "REVIEW_FINISH_FAILED");
    const ledger = JSON.parse(await readFile(env.TASKCENTER_TASK_LEDGER_PATH, "utf8"));
    assert.equal(ledger[0].reviewAttestations.length, 1);
    const routing = JSON.parse(await readFile(env.TASKCENTER_ROUTING_CONTROL_PATH, "utf8"));
    assert.equal(routing.routes.find((route) => route.id === launch.route_id).status, "succeeded");
  }
});
