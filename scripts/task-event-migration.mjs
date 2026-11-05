import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { TaskEventStore, durableTouch, journalEvent, journalLines, storePaths } from "./task-event-store.mjs";

function save(path, value) {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  durableTouch(`${path}.tmp`);
  renameSync(`${path}.tmp`, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

// Called only while the writer is stopped by controlled cutover, or in an isolated fixture.
// The original inode is never rewritten or removed: it becomes the read-only archive.
export function migrateTaskEvents(source, { fault = () => {}, prepareOnly = false } = {}) {
  const paths = storePaths(source);
  if (existsSync(paths.marker)) {
    if (prepareOnly) {
      const store = new TaskEventStore(source);
      try { store.sync(); } finally { store.close(); }
    }
    return { migrated: false, ...JSON.parse(readFileSync(paths.marker, "utf8")) };
  }
  mkdirSync(dirname(source), { recursive: true });
  if (!existsSync(source) && !existsSync(paths.migration)) writeFileSync(source, "", { mode: 0o600 });
  let prepared = existsSync(paths.migration) ? JSON.parse(readFileSync(paths.migration, "utf8")) : null;
  const formatRevision = createHash("sha256");
  for (const file of ["task-event-migration.mjs", "task-event-store.mjs", "task-event-identity.mjs"]) formatRevision.update(readFileSync(new URL(file, import.meta.url)));
  const format = formatRevision.digest("hex");
  if (prepared && prepared.format_revision !== format) {
    if (existsSync(prepared.archive)) throw new Error("TASK_EVENT_MIGRATION_FORMAT_CHANGED");
    prepared = null;
  }
  const compact = `${source}.compact.tmp`, stagedDatabase = `${source}.staging.sqlite`;
  if (!prepared) {
    // An interrupted preparation has not changed the source. Its derived artifacts are disposable.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${stagedDatabase}${suffix}`, { force: true });
    writeFileSync(compact, "", { mode: 0o600 });
    const output = openSync(compact, "a"), store = new TaskEventStore(source, stagedDatabase);
    const before = statSync(source), hash = createHash("sha256");
    let rows = 0, bytes = 0;
    let transaction = true;
    store.db.exec("BEGIN IMMEDIATE");
    try {
      for (const { line, endOffset } of journalLines(source, 0, before.size)) {
        hash.update(line).update("\n");
        if (line.length) {
          const event = JSON.parse(line.toString("utf8"));
          if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") throw new Error("TASK_EVENT_MIGRATION_INVALID_EVENT");
          const compactLine = `${JSON.stringify(journalEvent(event))}\n`;
          writeFileSync(output, compactLine); bytes += Buffer.byteLength(compactLine);
          store.add(event); rows++;
        } else { writeFileSync(output, "\n"); bytes++; }
        if (endOffset > before.size) throw new Error("TASK_EVENT_MIGRATION_SOURCE_CHANGED");
      }
      const after = statSync(source);
      if (["dev", "ino"].some(key => before[key] !== after[key]) || after.size < before.size) throw new Error("TASK_EVENT_MIGRATION_SOURCE_CHANGED");
      store.db.exec("COMMIT");
      transaction = false;
      const retention = store.retain();
      store.db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
      fsyncSync(output);
      const digest = hash.digest("hex");
      prepared = { version: 1, format_revision: format, source_bytes: before.size, source_identity: `${before.dev}:${before.ino}`, compact_bytes: bytes, events: rows, sha256: digest,
        archive: `${source}.${digest.slice(0, 16)}.archive.jsonl`, prepared_at: new Date().toISOString(), retention };
    } catch (error) {
      if (transaction) store.db.exec("ROLLBACK");
      throw error;
    } finally { closeSync(output); store.close(); }
    save(paths.migration, prepared);
    fault("prepared");
  }
  if (prepareOnly) return { prepared: true, ...prepared };
  const sourceIsOriginal = existsSync(source) && `${statSync(source).dev}:${statSync(source).ino}` === prepared.source_identity;
  if (sourceIsOriginal) {
    const before = statSync(source);
    if (before.size < prepared.source_bytes || `${before.dev}:${before.ino}` !== prepared.source_identity) throw new Error("TASK_EVENT_MIGRATION_SOURCE_CHANGED");
    // Preparation runs while the old service stays healthy. Verify its full prefix, then import
    // only the small cutover delta; never put the first complete scan on the startup path.
    const hash = createHash("sha256");
    for (const { line } of journalLines(source, 0, prepared.source_bytes)) hash.update(line).update("\n");
    if (hash.copy().digest("hex") !== prepared.sha256) throw new Error("TASK_EVENT_MIGRATION_SOURCE_CHANGED");
    if (before.size > prepared.source_bytes) {
      const store = new TaskEventStore(source, stagedDatabase), output = openSync(compact, "a");
      let rows = prepared.events, bytes = prepared.compact_bytes;
      store.db.exec("BEGIN IMMEDIATE");
      try {
        // A crash in the delta phase leaves the previous durable checkpoint intact.
        store.db.prepare("DELETE FROM tool_details WHERE seq>?").run(rows);
        store.db.prepare("DELETE FROM events WHERE seq>?").run(rows);
        truncateSync(compact, bytes);
        for (const { line } of journalLines(source, prepared.source_bytes, before.size)) {
          hash.update(line).update("\n");
          const event = JSON.parse(line.toString("utf8"));
          const compactLine = `${JSON.stringify(journalEvent(event))}\n`;
          writeFileSync(output, compactLine, { flag: "a" });
          store.add(event); rows++; bytes += Buffer.byteLength(compactLine);
        }
        fsyncSync(output);
        store.db.exec("COMMIT");
        prepared = { ...prepared, events: rows, compact_bytes: bytes, source_bytes: before.size, sha256: hash.digest("hex") };
        prepared.archive = `${source}.${prepared.sha256.slice(0, 16)}.archive.jsonl`;
        prepared.retention = store.retain();
      } finally { closeSync(output); store.close(); }
      save(paths.migration, prepared);
    }
    const after = statSync(source);
    if (["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(key => before[key] !== after[key])) throw new Error("TASK_EVENT_MIGRATION_SOURCE_CHANGED");
    if (!existsSync(prepared.archive)) renameSync(source, prepared.archive);
    chmodSync(prepared.archive, 0o400);
  } else if (!existsSync(prepared.archive)) throw new Error("TASK_EVENT_MIGRATION_ARCHIVE_MISSING");
  fault("archived");
  if (existsSync(compact)) renameSync(compact, source);
  fault("journal");
  if (existsSync(stagedDatabase)) renameSync(stagedDatabase, paths.database);
  fault("database");
  const store = new TaskEventStore(source);
  try {
    // Bind the already imported index to its compact projection, without reimporting lost defaults.
    store.bindSource();
    if (Number(store.db.prepare("SELECT COUNT(*) AS count FROM events").get().count) !== prepared.events) throw new Error("TASK_EVENT_MIGRATION_COUNT_MISMATCH");
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { store.close(); }
  const result = { ...prepared, activated_at: new Date().toISOString() };
  save(paths.marker, result);
  console.error(JSON.stringify({ event: "task_event_storage_migrated", version: 1, events: prepared.events,
    source_bytes: prepared.source_bytes, compact_bytes: prepared.compact_bytes, ...prepared.retention }));
  return { migrated: true, ...result };
}

export function recoverLegacyJournal(source) {
  const paths = storePaths(source);
  if (existsSync(paths.marker) || !existsSync(paths.migration)) return;
  const prepared = JSON.parse(readFileSync(paths.migration, "utf8"));
  if (!existsSync(prepared.archive)) return;
  // Rollback must not start the old release against a missing or half-switched journal.
  copyFileSync(prepared.archive, `${source}.restore.tmp`);
  chmodSync(`${source}.restore.tmp`, 0o600);
  durableTouch(`${source}.restore.tmp`);
  renameSync(`${source}.restore.tmp`, source);
  rmSync(paths.migration);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const source = resolve(process.argv[2] || "data/task-events.jsonl");
  if (process.argv.includes("--recover-legacy")) recoverLegacyJournal(source);
  else migrateTaskEvents(source, { prepareOnly: process.argv.includes("--prepare") });
}
