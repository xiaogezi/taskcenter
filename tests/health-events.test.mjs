import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

async function fixture(heapLimit) {
  const dir = await mkdtemp(join(tmpdir(), "taskcenter-health-"));
  const paths = Object.fromEntries(["dashboard", "ledger", "events", "heartbeat", "delegations", "usage", "governance", "usageHealth", "governanceHealth", "index", "routing"].map((name) => [name, join(dir, name)]));
  await writeFile(paths.dashboard, JSON.stringify({ generatedAt: "2026-08-09T05:00:00Z" }));
  await writeFile(paths.ledger, "{}");
  await writeFile(paths.events, `${JSON.stringify({ task_id: "target", type: "old" })}\n坏行\n${JSON.stringify({ task_id: "other", type: "other" })}\n${JSON.stringify({ task_id: "target", type: "new" })}\n`);
  await writeFile(paths.heartbeat, JSON.stringify({ updatedAt: new Date().toISOString() }));
  await writeFile(paths.usage, JSON.stringify({ generatedAt: new Date().toISOString(), windows: {}, overall: {} }));
  await writeFile(paths.governance, JSON.stringify({ schemaVersion: "taskcenter-governance-metrics-v1" }));
  await writeFile(paths.usageHealth, JSON.stringify({ refreshOk: false, heartbeatAt: new Date().toISOString(), lastRefreshError: "usage failed" }));
  await writeFile(paths.governanceHealth, JSON.stringify({ refreshOk: true, heartbeatAt: new Date().toISOString(), lastRefreshError: "" }));
  const port = 3200 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, [...(heapLimit ? [`--max-old-space-size=${heapLimit}`] : []), "scripts/control-server.mjs"], { cwd: process.cwd(), env: { ...process.env, TASKCENTER_CONTROL_PORT: String(port), TASKCENTER_DASHBOARD_PATH: paths.dashboard, TASKCENTER_TASK_LEDGER_PATH: paths.ledger, TASKCENTER_TASK_EVENTS_PATH: paths.events, TASKCENTER_WATCHER_HEARTBEAT_PATH: paths.heartbeat, TASKCENTER_DELEGATIONS_PATH: paths.delegations, TASKCENTER_USAGE_REPORT_PATH: paths.usage, TASKCENTER_GOVERNANCE_METRICS_PATH: paths.governance, TASKCENTER_USAGE_HEALTH_PATH: paths.usageHealth, TASKCENTER_GOVERNANCE_HEALTH_PATH: paths.governanceHealth, TASKCENTER_TASK_EVENT_INDEX_PATH: paths.index, TASKCENTER_ROUTING_CONTROL_PATH: paths.routing, TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION: "1" }, stdio: "ignore" });
  // Wait for actual readiness; a fixed 1.5s startup window flakes under the full suite's CPU load.
  for (let i = 0; i < 200; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return { dir, paths, port, child };
    } catch {}
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill();
  await rm(dir, { recursive: true, force: true });
  throw new Error("Isolated health fixture did not become ready");
}

test("health 文件状态、heartbeat 新鲜/陈旧和事件接口边界", async (t) => {
  const f = await fixture();
  t.after(async () => { f.child.kill(); await rm(f.dir, { recursive: true, force: true }); });
  let health = await (await fetch(`http://127.0.0.1:${f.port}/health`)).json();
  assert.equal(health.dashboard.readable, true); assert.equal(health.ledger.readable, true); assert.equal(health.ledger.eventsReadable, true); assert.equal(health.watcher.healthy, true);
  assert.equal(health.metrics.usage.stale, true); assert.equal(health.metrics.usage.lastRefreshError, "usage failed"); assert.equal(health.metrics.governance.stale, false);
  for (const status of ["failed", "syncing"]) {
    await writeFile(f.paths.heartbeat, JSON.stringify({ updatedAt: new Date().toISOString(), status, refreshOk: false }));
    health = await (await fetch(`http://127.0.0.1:${f.port}/health`)).json();
    assert.equal(health.watcher.healthy, false, "fresh heartbeat must not conceal a failed refresh, including while retrying");
  }
  await writeFile(f.paths.heartbeat, JSON.stringify({ updatedAt: new Date().toISOString(), status: "watching", refreshOk: true }));
  health = await (await fetch(`http://127.0.0.1:${f.port}/health`)).json();
  assert.equal(health.watcher.healthy, true);
  let events = await (await fetch(`http://127.0.0.1:${f.port}/tasks/target/events?limit=1`)).json();
  assert.deepEqual(events.events.map((event) => event.type), ["new"]);
  events = await (await fetch(`http://127.0.0.1:${f.port}/tasks/target/events`)).json();
  assert.deepEqual(events.events.map((event) => event.type), ["new", "old"]);
  await writeFile(f.paths.heartbeat, JSON.stringify({ updatedAt: new Date(Date.now() - 31_000).toISOString() }));
  health = await (await fetch(`http://127.0.0.1:${f.port}/health`)).json(); assert.equal(health.watcher.healthy, false);
  await rm(f.paths.dashboard); await rm(f.paths.ledger); await rm(f.paths.events);
  health = await (await fetch(`http://127.0.0.1:${f.port}/health`)).json(); assert.equal(health.dashboard.readable, false); assert.equal(health.ledger.readable, false); assert.equal(health.ledger.eventsReadable, false);
});

test("128 MB 控制进程刷新大事件快照后仍可读取事件和健康状态", async (t) => {
  const f = await fixture(128);
  t.after(async () => { f.child.kill(); await rm(f.dir, { recursive: true, force: true }); });
  const byTask = {};
  for (let task = 0; task < 2000; task += 1) byTask[`task-${task}`] = Array.from({ length: 100 }, (_, event) => ({
    task_id: `task-${task}`, event_id: `${task}-${event}`, type: "task.update", created_at: "2026-10-09T00:00:00Z", current_step: "部署门禁复测",
  }));
  for (let version = 0; version < 3; version += 1) {
    byTask.target = [{ event_id: "indexed", type: "indexed", current_step: String(version) }];
    await writeFile(f.paths.index, JSON.stringify({ version, byTask }));
    const events = await (await fetch(`http://127.0.0.1:${f.port}/tasks/target/events`)).json();
    assert.equal(events.events.find((event) => event.event_id === "indexed").current_step, String(version));
    const other = await (await fetch(`http://127.0.0.1:${f.port}/tasks/task-1999/events`)).json();
    assert.equal(other.events.length, 100);
    const restored = await (await fetch(`http://127.0.0.1:${f.port}/tasks/target/events`)).json();
    assert.equal(restored.events.find((event) => event.event_id === "indexed").current_step, String(version));
    const health = await (await fetch(`http://127.0.0.1:${f.port}/health`)).json();
    assert.equal(health.ok, true);
  }
});
