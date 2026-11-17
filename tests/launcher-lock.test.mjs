import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeSqliteMutex, acquireSqliteMutex } from "../scripts/sqlite-mutex.mjs";

test("启动器拒绝未迁移或旧协议锁，不自动删除；迁移后采用事务互斥", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "launcher-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = join(dir, "launcher.lock");
  const databasePath = join(dir, "launcher.mutex.sqlite");
  const run = () => spawnSync(process.execPath, ["scripts/taskcenter-control.mjs", "status"], {
    env: { ...process.env, TASKCENTER_HEALTH_URL: "http://127.0.0.1:1/health", TASKCENTER_DASHBOARD_URL: "http://127.0.0.1:1", TASKCENTER_RUNTIME_DIR: dir, TASKCENTER_LOG_DIR: join(dir, "logs") }, encoding: "utf8", timeout: 15000,
  });
  const uninitialized = run();
  assert.equal(uninitialized.status, 1);
  assert.match(uninitialized.stderr, /MIGRATION_REQUIRED/);
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 99999999 }));
  assert.throws(() => initializeSqliteMutex({ databasePath, legacyLockPath: lock, offlineConfirmed: true }), /LEGACY_LOCK_PRESENT/);
  assert.equal(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).pid, 99999999);
  rmSync(lock, { recursive: true }); // Fixture owns this directory; represents the explicit offline operator step.
  initializeSqliteMutex({ databasePath, legacyLockPath: lock, offlineConfirmed: true });
  const release = acquireSqliteMutex({ databasePath, legacyLockPath: lock });
  try {
    const busy = run();
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, /BUSY/);
  } finally { release(); }
  const stopped = run();
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /未运行/);
  mkdirSync(lock);
  writeFileSync(join(lock, "preserve"), "unknown owner");
  assert.match(run().stderr, /LEGACY_LOCK_PRESENT/);
  assert.equal(readFileSync(join(lock, "preserve"), "utf8"), "unknown owner");
});
