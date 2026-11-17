import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const PROTOCOL = "taskcenter-sqlite-mutex-v1";

export class SqliteMutexError extends Error {
  constructor(code, message, options) {
    super(`${code}: ${message}`, options);
    this.code = code;
  }
}

function migrationRequired(databasePath) {
  return new SqliteMutexError("MUTEX_MIGRATION_REQUIRED",
    `Mutex requires explicit offline initialization: ${databasePath}. Stop all old-version writers and schedulers, retire their entry points, remove any legacy lock only while offline, then run scripts/migrate-locks.mjs with --offline-confirmed (see docs/lock-protocol-migration.md). Never run old writers after migration.`);
}

function rejectLegacyLock(legacyLockPath) {
  let present = true;
  try { lstatSync(legacyLockPath); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    present = false;
  }
  if (present) {
    throw new SqliteMutexError("MUTEX_LEGACY_LOCK_PRESENT",
      `Legacy lock remains at ${legacyLockPath}; refuse mixed protocols. Stop all old writers before offline inspection/removal. This check cannot detect an old writer that starts later.`);
  }
}

function openDatabase(databasePath, timeoutMs) {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.min(600_000, Math.trunc(Number(timeoutMs) || 0)))}`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

// Migration is an OPERATOR-ASSERTED offline operation, not a live bridge.
// A legacy stale-lock reaper cannot be made safe by rechecking its PID/mtime.
// Do not delete/replace this database (or its SQLite sidecars) while writers run.
export function initializeSqliteMutex({ databasePath, legacyLockPath, offlineConfirmed = false }) {
  databasePath = resolve(databasePath);
  legacyLockPath = resolve(legacyLockPath);
  if (offlineConfirmed !== true) throw migrationRequired(databasePath);
  rejectLegacyLock(legacyLockPath);
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = openDatabase(databasePath, 5_000);
  try {
    chmodSync(databasePath, 0o600);
    db.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
    db.exec("CREATE TABLE IF NOT EXISTS mutex_protocol (id INTEGER PRIMARY KEY CHECK(id=1), protocol TEXT NOT NULL, legacy_path TEXT NOT NULL)");
    const existing = db.prepare("SELECT protocol, legacy_path FROM mutex_protocol WHERE id=1").get();
    if (existing && (existing.protocol !== PROTOCOL || existing.legacy_path !== legacyLockPath)) {
      throw new SqliteMutexError("MUTEX_PROTOCOL_MISMATCH", "Mutex database belongs to another protocol or legacy lock path.");
    }
    db.prepare("INSERT OR IGNORE INTO mutex_protocol VALUES(1,?,?)").run(PROTOCOL, legacyLockPath);
    db.exec("COMMIT");
  } finally {
    // Closing also rolls back a failed migration; no durable initialized marker
    // is published until COMMIT succeeds.
    db.close();
  }
}

export function acquireSqliteMutex({ databasePath, legacyLockPath, timeoutMs = 5_000 }) {
  databasePath = resolve(databasePath);
  legacyLockPath = resolve(legacyLockPath);
  if (!existsSync(databasePath)) throw migrationRequired(databasePath);
  rejectLegacyLock(legacyLockPath);
  const db = openDatabase(databasePath, timeoutMs);
  try {
    // SQLite's OS-backed lock survives arbitrary critical-section duration and
    // releases on process death. No clock, owner PID, unlink or stale reaper.
    db.exec("BEGIN IMMEDIATE");
    let protocol;
    try {
      protocol = db.prepare("SELECT protocol, legacy_path FROM mutex_protocol WHERE id=1").get();
    } catch (error) {
      if (error.message?.includes("no such table")) throw migrationRequired(databasePath);
      throw error;
    }
    if (protocol?.protocol !== PROTOCOL || protocol?.legacy_path !== legacyLockPath) {
      throw migrationRequired(databasePath);
    }
    rejectLegacyLock(legacyLockPath);
  } catch (error) {
    db.close();
    if (error.errcode === 5 || error.errcode === 6) {
      throw new SqliteMutexError("MUTEX_BUSY", "Another process holds the mutex; retry later.", { cause: error });
    }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { db.exec("ROLLBACK"); } finally { db.close(); }
  };
}

