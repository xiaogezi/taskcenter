import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";

test("Inbox 决策支持单项、批量、校验和重启读取", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "taskcenter-inbox-"));
  const path = join(dir, "decisions.json");
  const port = await allocatePort();
  const env = { ...process.env, TASKCENTER_CONTROL_PORT: String(port), TASKCENTER_INBOX_DECISIONS_PATH: path, TASKCENTER_DELEGATIONS_PATH: join(dir, "delegations.json"), TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION: "1" };
  const start = () => spawn(process.execPath, ["scripts/control-server.mjs"], { cwd: process.cwd(), env, stdio: "ignore" });
  let child = start();
  t.after(async () => { child.kill(); await rm(dir, { recursive: true, force: true }); });
  await waitForHealth(port, child);
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
  await waitForHealth(port, child);
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
  await waitForHealth(port, child);
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

function allocatePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`control-server 在健康检查前退出：${child.signalCode || child.exitCode}`);
    }
    try {
      const probeTimeoutMs = Math.max(1, Math.min(1_000, deadline - Date.now()));
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(probeTimeoutMs),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`control-server 未在超时前监听端口 ${port}`);
}
