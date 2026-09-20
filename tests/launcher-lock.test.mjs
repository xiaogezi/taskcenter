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
    env: { ...process.env, TASKCENTER_RUNTIME_DIR: dir, TASKCENTER_LOG_DIR: join(dir, "logs") }, encoding: "utf8", timeout: 15000,
  });
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 99999999 }));
  assert.equal(run().status, 0);
  assert.equal(readdirSync(dir).some((name) => name.startsWith(".launcher-owner-") || name === "launcher.lock"), false);
  const deadOwner = join(dir, "dead-owner");
  mkdirSync(deadOwner);
  writeFileSync(join(deadOwner, "owner.json"), JSON.stringify({ pid: 99999999 }));
  symlinkSync(deadOwner, lock, process.platform === "win32" ? "junction" : "dir");
  assert.equal(run().status, 0);
  mkdirSync(lock);
  writeFileSync(join(lock, "preserve"), "unknown owner");
  const orphan = run();
  assert.equal(orphan.status, 1);
  assert.match(orphan.stderr, /缺少有效 owner/);
  assert.equal(readFileSync(join(lock, "preserve"), "utf8"), "unknown owner");
});
