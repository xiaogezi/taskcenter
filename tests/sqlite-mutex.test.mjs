import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireSqliteMutex, initializeSqliteMutex } from "../scripts/sqlite-mutex.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "taskcenter-mutex-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { databasePath: join(directory, "mutex.sqlite"), legacyLockPath: join(directory, "legacy.lock") };
}

test("mutex requires explicit offline migration and never reaps a legacy owner", (t) => {
  const paths = fixture(t);
  assert.throws(() => acquireSqliteMutex(paths), { code: "MUTEX_MIGRATION_REQUIRED" });
  assert.throws(() => initializeSqliteMutex(paths), { code: "MUTEX_MIGRATION_REQUIRED" });
  assert.equal(existsSync(paths.databasePath), false);
  mkdirSync(paths.legacyLockPath);
  writeFileSync(join(paths.legacyLockPath, "owner.json"), JSON.stringify({ pid: -1 }));
  assert.throws(() => initializeSqliteMutex({ ...paths, offlineConfirmed: true }), { code: "MUTEX_LEGACY_LOCK_PRESENT" });
  assert.equal(existsSync(join(paths.legacyLockPath, "owner.json")), true);
  // The fixture is offline. Runtime acquisition must never perform this removal.
  rmSync(paths.legacyLockPath, { recursive: true });
  initializeSqliteMutex({ ...paths, offlineConfirmed: true });
  const release = acquireSqliteMutex(paths);
  release();
  release();
  mkdirSync(paths.legacyLockPath);
  assert.throws(() => acquireSqliteMutex(paths), { code: "MUTEX_LEGACY_LOCK_PRESENT" });
});

test("mutex excludes another connection until release and binds its legacy path", (t) => {
  const paths = fixture(t);
  initializeSqliteMutex({ ...paths, offlineConfirmed: true });
  const release = acquireSqliteMutex(paths);
  try {
    assert.throws(() => acquireSqliteMutex({ ...paths, timeoutMs: 20 }), { code: "MUTEX_BUSY" });
  } finally { release(); }
  acquireSqliteMutex(paths)();
  assert.throws(() => acquireSqliteMutex({ ...paths, legacyLockPath: `${paths.legacyLockPath}-other` }), { code: "MUTEX_MIGRATION_REQUIRED" });
});

test("mutex recovers after writer termination without deleting or migrating the database", { timeout: 15_000 }, async (t) => {
  const paths = fixture(t);
  initializeSqliteMutex({ ...paths, offlineConfirmed: true });
  const moduleUrl = new URL("../scripts/sqlite-mutex.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { acquireSqliteMutex } from ${JSON.stringify(moduleUrl)};
    const release = acquireSqliteMutex(${JSON.stringify(paths)});
    process.send("locked");
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const ready = once(child, "message", { signal: AbortSignal.timeout(8_000) });
  const exited = once(child, "exit");
  try {
    await Promise.race([ready, exited.then(() => { throw new Error("writer exited before acquiring lock"); })]);
    assert.throws(() => acquireSqliteMutex({ ...paths, timeoutMs: 20 }), { code: "MUTEX_BUSY" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
  assert.equal(existsSync(paths.databasePath), true);
  acquireSqliteMutex(paths)();
});
