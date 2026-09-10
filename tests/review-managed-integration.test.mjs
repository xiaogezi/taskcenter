import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("managed MCP lifecycle registers trusted identity, claims, reports and releases", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "managed-review-"));
  const env = { ...process.env, TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION: "1", TASKCENTER_CONTEXT_BRIDGE_ENABLED: "false" };
  for (const key of ["TASK_LEDGER", "TASK_EVENTS", "TASK_EVENT_IDS", "TASK_RECONCILE", "SESSION_REGISTRY", "SESSION_MERGES", "ROUTING_CONTROL", "DELEGATIONS", "BUG_DISPATCHES", "DISPATCHES", "DASHBOARD", "MCP_TOKEN", "CONTEXT_TASK_MAP", "CONTEXT_AUDIT"]) env[`TASKCENTER_${key}_PATH`] = join(dir, key);
  const owner = "01a0893d-fd11-74a3-b094-2f116a7992cc";
  const reviewer = "01a089aa-23a5-7822-8296-6777b611ebe4";
  const roles = JSON.parse(await readFile("config/model-roles.json", "utf8"));
  const subject = { type: "artifact", value: "managed-fixture", observed_at: new Date().toISOString() };
  await writeFile(env.TASKCENTER_TASK_LEDGER_PATH, JSON.stringify([{ id: "managed-task", sessionId: owner, workspace: dir, status: "done_claimed", currentSubject: subject, reviewAttestations: [], reviewCycles: [] }]));
  await writeFile(env.TASKCENTER_SESSION_REGISTRY_PATH, JSON.stringify({ [owner]: { model: "main-test", workspace: dir } }));
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
  const response = await fetch(`${env.TASKCENTER_CONTROL_URL}/routing/select`, { method: "POST", headers, body: JSON.stringify({ task_id: "managed-task", session_id: owner, task_class: "ocr_review", channel: "cli", review_artifacts: { subject: { ref: subject.value }, bundle: { ref: preview }, rules: { ref: "fixture-rules" } } }) });
  const selected = await response.json();
  assert.equal(response.ok, true, JSON.stringify(selected));
  for (const key of ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "TASKCENTER_CALLER_SESSION_ID"]) delete env[key];
  env.TASKCENTER_CALLER_SESSION_ID = reviewer;
  env.TASKCENTER_MANAGED_REVIEW = JSON.stringify({ route_id: selected.route.route_id, claim_token: selected.route.review_record.claim_token, workspace: dir, model: roles.roles.reviewer.model, sandbox: "read-only" });
  const client = new Client({ name: "managed-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["scripts/taskcenter-mcp.mjs"], env, stderr: "pipe" }));
  t.after(() => client.close());
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  const started = await call("taskcenter_review_start", {});
  assert.equal(started.accepted, true, JSON.stringify(started));
  assert.equal(started.context.reviewer.session_id, reviewer);
  const result = { reviewed_files: [], findings: [], spec_verdict: "compliant", quality_verdict: "approved", verdict: "approved", summary: "fixture" };
  assert.match((await call("taskcenter_review_finish", result)).message, /COVERAGE_INCOMPLETE/);
  const finished = await call("taskcenter_review_finish", { ...result, reviewed_files: ["a.mjs"] });
  assert.equal(finished.accepted, true, JSON.stringify(finished));
  assert.equal(finished.lease_released, true);
});
