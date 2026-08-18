import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

test("Inbox 决策支持单项、批量、校验和重启读取", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "taskcenter-inbox-"));
  const path = join(dir, "decisions.json");
  const port = 3500 + Math.floor(Math.random() * 200);
  const env = { ...process.env, TASKCENTER_CONTROL_PORT: String(port), TASKCENTER_INBOX_DECISIONS_PATH: path, TASKCENTER_DELEGATIONS_PATH: join(dir, "delegations.json"), TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION: "1" };
  const start = () => spawn(process.execPath, ["scripts/control-server.mjs"], { cwd: process.cwd(), env, stdio: "ignore" });
  let child = start();
  t.after(async () => { child.kill(); await rm(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 30; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); } }
  const headers = { Origin: "http://localhost:3000", "Content-Type": "application/json", "X-TaskCenter-Action": "delegate" };
  let response = await fetch(`http://127.0.0.1:${port}/inbox-decisions/a`, { method: "POST", headers, body: JSON.stringify({ decision: "continue" }) });
  assert.equal(response.status, 200);
  response = await fetch(`http://127.0.0.1:${port}/inbox-decisions/batch`, { method: "POST", headers, body: JSON.stringify({ ids: ["a", "b"], decision: "discard" }) });
  assert.equal(response.status, 200);
  response = await fetch(`http://127.0.0.1:${port}/inbox-decisions/b`, { method: "POST", headers, body: JSON.stringify({ decision: "bad" }) });
  assert.equal(response.status, 400);
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
  child = start();
  for (let i = 0; i < 30; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); } }
  response = await fetch(`http://127.0.0.1:${port}/inbox-decisions`);
  assert.deepEqual((await response.json()).decisions, { a: "discard", b: "discard" });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { a: "discard", b: "discard" });

  const parent = join(dir, "storage");
  const blockedParent = join(dir, "storage-backup");
  await mkdir(parent);
  const blockedPath = join(parent, "decisions.json");
  await writeFile(blockedPath, JSON.stringify({ stable: "continue" }));
  const blockedEnv = { ...env, TASKCENTER_INBOX_DECISIONS_PATH: blockedPath };
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
  child = spawn(process.execPath, ["scripts/control-server.mjs"], { cwd: process.cwd(), env: blockedEnv, stdio: "ignore" });
  for (let i = 0; i < 30; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); } }
  response = await fetch(`http://127.0.0.1:${port}/inbox-decisions`);
  assert.deepEqual((await response.json()).decisions, { stable: "continue" });
  // Make mkdir(dirname(path)) fail while the server retains the loaded old value.
  await rename(parent, blockedParent);
  await writeFile(parent, "not a directory");
  response = await fetch(`http://127.0.0.1:${port}/inbox-decisions/stable`, { method: "POST", headers, body: JSON.stringify({ decision: "discard" }) });
  assert.equal(response.status, 500);
  response = await fetch(`http://127.0.0.1:${port}/inbox-decisions`);
  assert.deepEqual((await response.json()).decisions, { stable: "continue" });
  assert.deepEqual(JSON.parse(await readFile(join(blockedParent, "decisions.json"))), { stable: "continue" });
  response = await fetch(`http://127.0.0.1:${port}/inbox-decisions/batch`, { method: "POST", headers, body: JSON.stringify({ ids: ["stable", "batch"], decision: "discard" }) });
  assert.equal(response.status, 500);
  response = await fetch(`http://127.0.0.1:${port}/inbox-decisions`);
  assert.deepEqual((await response.json()).decisions, { stable: "continue" });
  assert.deepEqual(JSON.parse(await readFile(join(blockedParent, "decisions.json"))), { stable: "continue" });
});
