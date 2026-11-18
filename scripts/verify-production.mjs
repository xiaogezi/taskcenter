#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter } from "node:path";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function freePort() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

export async function verifyProduction(root) {
  const state = mkdtempSync(join(tmpdir(), "taskcenter-production-state-"));
  const [webPort, controlPort] = await Promise.all([freePort(), freePort()]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("TASKCENTER_") && !["CODEX_HOME", "TYPESAFE_API_KEY"].includes(key)));
  const bin = join(state, "bin"), sentinel = join(state, "codex-called");
  mkdirSync(bin);
  const fake = `#!${process.execPath}\nimport { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "called"); process.exit(99);\n`;
  writeFileSync(join(bin, "codex"), fake, { mode: 0o755 });
  writeFileSync(join(bin, "codex.mjs"), fake);
  writeFileSync(join(bin, "codex.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0codex.mjs" %*\r\n`);
  env.PATH = bin + delimiter + env.PATH;
  Object.assign(env, {
    CODEX_HOME: join(root, "tests/fixtures"), TASKCENTER_SESSIONS_ROOT: join(root, "tests/fixtures/sessions"),
    TASKCENTER_SEED_PATH: join(root, "tests/fixtures/requirements.seed.json"),
    TASKCENTER_SELECTION_PATH: join(root, "tests/fixtures/session-selection-all.json"),
    TASKCENTER_WEB_MODE: "start", TASKCENTER_WEB_PORT: String(webPort), TASKCENTER_CONTROL_PORT: String(controlPort),
    TASKCENTER_SOURCE_ROOT: root, TASKCENTER_RUNTIME_DIR: join(state, "runtime"),
    TASKCENTER_LOG_DIR: join(state, "logs"),
    TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION: "1", TASKCENTER_JEV_ROUTING: "0",
    TASKCENTER_CODEX_COMMAND: join(bin, process.platform === "win32" ? "codex.cmd" : "codex"), TASKCENTER_CODEX_SDK_MODULE: join(state, "nonexistent-sdk.mjs"),
  });
  for (const key of ["DASHBOARD", "DISPATCHES", "OVERRIDES", "INBOX_DECISIONS", "SESSION_SELECTION", "GATE_SESSION_ALLOWLIST", "MCP_TOKEN", "REFLECTION_PROPOSALS", "TASK_LEDGER", "TASK_EVENTS", "TASK_EVENT_IDS", "SESSION_REGISTRY", "DELEGATIONS", "ROUTING_CONTROL", "USAGE_REPORT", "GOVERNANCE_METRICS", "GATE_DENIALS", "TASK_EVENT_INDEX", "USAGE_HEALTH", "GOVERNANCE_HEALTH", "WATCHER_HEARTBEAT", "TASK_RECONCILE"]) env[`TASKCENTER_${key}_PATH`] = join(state, key.toLowerCase() + ".json");
  env.TASKCENTER_CONTEXT_MANAGEMENT_PILOT_EVENTS_PATH = join(state, "pilot.jsonl");
  env.TASKCENTER_TASK_REUSE_DECISIONS_PATH = join(state, "task-reuse-decisions.jsonl");
  let output = "";
  const child = spawn(process.execPath, ["scripts/dev-live.mjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", data => { output = (output + data).slice(-16000); });
  child.stderr.on("data", data => { output = (output + data).slice(-16000); });
  const client = new Client({ name: "production-verification", version: "1.0.0" });
  try {
    const deadline = Date.now() + 25000;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const health = await fetch(`http://127.0.0.1:${controlPort}/health`, { signal: AbortSignal.timeout(1000) });
        const page = await fetch(`http://127.0.0.1:${webPort}/tasks`, { signal: AbortSignal.timeout(1000) });
        const status = await health.json();
        if (status.ok && status.watcher.healthy && status.dashboard.readable && page.ok) { healthy = true; break; }
      } catch { /* Startup is asynchronous. */ }
      if (child.exitCode !== null || output.includes("restarting in 1s")) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(healthy, output || "Production stack did not become healthy");
    for (const path of ["/", "/tasks", "/sessions", "/improvements", "/settings"]) {
      const response = await fetch(`http://127.0.0.1:${webPort}${path}`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200, path);
      assert.doesNotMatch(await response.text(), /创建改进任务|请求启用|Bug 派发/);
    }
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["scripts/taskcenter-mcp.mjs"], cwd: root, env, stderr: "pipe" }));
    const { tools } = await client.listTools();
    assert.ok(tools.some(tool => tool.name === "taskcenter_task_begin"));
    assert.ok(!tools.some(tool => tool.name.includes("bug_dispatch")));
    const unknown = await client.callTool({ name: "taskcenter_bug_dispatch_host", arguments: {} });
    assert.equal(unknown.isError, true);
    assert.ok(existsSync(env.TASKCENTER_DASHBOARD_PATH), "sync output missing");
    const dashboard = JSON.parse(readFileSync(env.TASKCENTER_DASHBOARD_PATH, "utf8"));
    assert.ok(dashboard.threads.length, "fixture sync missing");
    assert.doesNotMatch(output, /restarting in 1s|ERR_MODULE_NOT_FOUND/);
    assert.equal(existsSync(sentinel), false, "Codex process was invoked");
    return { passed: true, pages: 6, tools: tools.length, sync: true, watcher: true, codex_cli_required: false };
  } finally {
    await client.close();
    if (child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
    rmSync(state, { recursive: true, force: true });
  }
}

// CI production installation is isolated from the test workspace and never copies user data.
export function productionFixture(source) {
  const root = mkdtempSync(join(tmpdir(), "taskcenter-production-"));
  const tracked = execFileSync("git", ["ls-files", "-z", "--cached"], { cwd: source, encoding: "utf8" }).split("\0").filter(Boolean);
  const addedSource = execFileSync("git", ["ls-files", "-z", "--others", "--exclude-standard", "--", "scripts", "config", "tests", "app", "features", "lib", "docs", ".github"], { cwd: source, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const path of [...tracked, ...addedSource]) {
    if (!existsSync(join(source, path))) continue;
    mkdirSync(resolve(root, path, ".."), { recursive: true });
    cpSync(join(source, path), join(root, path), { recursive: true });
  }
  cpSync(join(source, "dist"), join(root, "dist"), { recursive: true });
  return root;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const install = process.argv.includes("--install");
  const root = install ? productionFixture(source) : resolve(process.argv[2] || source);
  try {
    if (install) {
      if (!process.env.npm_execpath) throw new Error("Use npm run verify:production -- --install");
      execFileSync(process.execPath, [process.env.npm_execpath, "ci", "--omit=dev", "--omit=optional", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" });
    }
    console.log(JSON.stringify(await verifyProduction(root)));
    if (install) {
      const { checkArtifacts } = await import("./artifact-size-budget.mjs");
      const report = checkArtifacts({ root, mode: "release" });
      console.log(JSON.stringify(report, null, 2));
      if (report.failed) process.exitCode = 1;
    }
  } catch (error) { if (error.measurement) console.log(JSON.stringify(error.measurement, null, 2)); console.error(error); process.exitCode = 1; }
  finally { if (install) rmSync(root, { recursive: true, force: true }); }
}
