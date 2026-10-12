import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("启停锁兼容旧死进程锁且不会删除无owner锁", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "launcher-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = join(dir, "launcher.lock");
  const run = () => spawnSync(process.execPath, ["scripts/taskcenter-control.mjs", "status"], {
    env: { ...process.env, TASKCENTER_HEALTH_URL: "http://127.0.0.1:1/health", TASKCENTER_DASHBOARD_URL: "http://127.0.0.1:1", TASKCENTER_RUNTIME_DIR: dir, TASKCENTER_LOG_DIR: join(dir, "logs") }, encoding: "utf8", timeout: 15000,
  });
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 99999999 }));
  const stopped = run();
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /未运行/);
  assert.equal(readdirSync(dir).some((name) => name.startsWith(".launcher-owner-") || name === "launcher.lock"), false);
  const deadOwner = join(dir, "dead-owner");
  mkdirSync(deadOwner);
  writeFileSync(join(deadOwner, "owner.json"), JSON.stringify({ pid: 99999999 }));
  symlinkSync(deadOwner, lock, process.platform === "win32" ? "junction" : "dir");
  const stoppedAgain = run();
  assert.equal(stoppedAgain.status, 1);
  assert.match(stoppedAgain.stderr, /未运行/);
  mkdirSync(lock);
  writeFileSync(join(lock, "preserve"), "unknown owner");
  const orphan = run();
  assert.equal(orphan.status, 1);
  assert.match(orphan.stderr, /缺少有效 owner/);
  assert.equal(readFileSync(join(lock, "preserve"), "utf8"), "unknown owner");
});
