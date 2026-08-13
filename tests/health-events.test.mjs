import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "taskcenter-health-"));
  const paths = Object.fromEntries(["dashboard", "ledger", "events", "heartbeat"].map((name) => [name, join(dir, name)]));
  await writeFile(paths.dashboard, JSON.stringify({ generatedAt: "2026-08-09T05:00:00Z" }));
  await writeFile(paths.ledger, "{}");
  await writeFile(paths.events, `${JSON.stringify({ task_id: "target", type: "old" })}\n坏行\n${JSON.stringify({ task_id: "other", type: "other" })}\n${JSON.stringify({ task_id: "target", type: "new" })}\n`);
  await writeFile(paths.heartbeat, JSON.stringify({ updatedAt: new Date().toISOString() }));
  const port = 3200 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, ["scripts/control-server.mjs"], { cwd: process.cwd(), env: { ...process.env, TASKCENTER_CONTROL_PORT: String(port), TASKCENTER_DASHBOARD_PATH: paths.dashboard, TASKCENTER_TASK_LEDGER_PATH: paths.ledger, TASKCENTER_TASK_EVENTS_PATH: paths.events, TASKCENTER_WATCHER_HEARTBEAT_PATH: paths.heartbeat, TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION: "1" }, stdio: "ignore" });
  for (let i = 0; i < 30; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); } }
  return { dir, paths, port, child };
}

test("health 文件状态、heartbeat 新鲜/陈旧和事件接口边界", async (t) => {
  const f = await fixture();
  t.after(async () => { f.child.kill(); await rm(f.dir, { recursive: true, force: true }); });
  let health = await (await fetch(`http://127.0.0.1:${f.port}/health`)).json();
  assert.equal(health.dashboard.readable, true); assert.equal(health.ledger.readable, true); assert.equal(health.ledger.eventsReadable, true); assert.equal(health.watcher.healthy, true);
  let events = await (await fetch(`http://127.0.0.1:${f.port}/tasks/target/events?limit=1`)).json();
  assert.deepEqual(events.events.map((event) => event.type), ["new"]);
  events = await (await fetch(`http://127.0.0.1:${f.port}/tasks/target/events`)).json();
  assert.deepEqual(events.events.map((event) => event.type), ["new", "old"]);
  await writeFile(f.paths.heartbeat, JSON.stringify({ updatedAt: new Date(Date.now() - 31_000).toISOString() }));
  health = await (await fetch(`http://127.0.0.1:${f.port}/health`)).json(); assert.equal(health.watcher.healthy, false);
  await rm(f.paths.dashboard); await rm(f.paths.ledger); await rm(f.paths.events);
  health = await (await fetch(`http://127.0.0.1:${f.port}/health`)).json(); assert.equal(health.dashboard.readable, false); assert.equal(health.ledger.readable, false); assert.equal(health.ledger.eventsReadable, false);
});
