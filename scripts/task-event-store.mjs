import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { eventFingerprint } from "./task-event-identity.mjs";

export const TOOL_RETENTION_MS = 30 * 86400000;
export const TOOL_RETENTION_BYTES = 200 * 1024 * 1024;
export const storePaths = source => ({ database: `${source}.sqlite`, marker: `${source}.storage.json`, migration: `${source}.migration.json` });

// Keep every nonempty fact (including unexpected task mutations), timestamps and replay digest.
// Only normalized empty defaults move to the expiring detail table; no task fact is discarded.
export function journalEvent(event) {
  if (event.type !== "tool.call" || event.storage_fingerprint) return event;
  const telemetry = new Set(["agent", "provider", "model", "workspace", "project_id", "repository_root", "workspace_branch", "tool_name", "tool_use_id"]);
  const unchanged = JSON.stringify(event.previous_state) === JSON.stringify(event.new_state);
  return { ...Object.fromEntries(Object.entries(event).filter(([key, value]) => !telemetry.has(key)
    && !(unchanged && ["previous_state", "new_state"].includes(key)) && value !== "" && value !== null && value !== undefined
    && !(Array.isArray(value) && !value.length))), storage_fingerprint: eventFingerprint(event), storage_format: "tool-facts-v1" };
}

export function* journalLines(path, start = 0, until = Infinity) {
  const descriptor = openSync(path, "r"), block = Buffer.allocUnsafe(64 * 1024);
  let pending = Buffer.alloc(0), offset = start;
  try {
    const end = Math.min(fstatSync(descriptor).size, until);
    while (offset < end) {
      const count = readSync(descriptor, block, 0, Math.min(block.length, end - offset), offset);
      if (!count) break;
      offset += count;
      pending = Buffer.concat([pending, block.subarray(0, count)]);
      let newline;
      while ((newline = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, newline);
        const endOffset = offset - pending.length + newline + 1;
        pending = pending.subarray(newline + 1);
        yield { line, endOffset };
      }
      if (pending.length > 64 * 1024 * 1024) throw new Error("TASK_EVENT_LINE_TOO_LARGE");
    }
    if (pending.length) throw new Error("TASK_EVENT_JOURNAL_INCOMPLETE");
  } finally { closeSync(descriptor); }
}

function identity(path) {
  const info = statSync(path);
  return `${info.dev}:${info.ino}`;
}

function checkpoint(path, offset) {
  const descriptor = openSync(path, "r"), buffer = Buffer.alloc(Math.min(4096, offset));
  try {
    const head = readSync(descriptor, buffer, 0, buffer.length, 0);
    const hash = createHash("sha256").update(buffer.subarray(0, head));
    const tail = readSync(descriptor, buffer, 0, buffer.length, Math.max(0, offset - buffer.length));
    return hash.update(buffer.subarray(0, tail)).digest("hex");
  } finally { closeSync(descriptor); }
}

export class TaskEventStore {
  constructor(source, database = storePaths(source).database) {
    this.source = source;
    mkdirSync(dirname(database), { recursive: true });
    if (!existsSync(database)) writeFileSync(database, "", { mode: 0o600 });
    chmodSync(database, 0o600);
    this.db = new DatabaseSync(database);
    this.db.exec(`PRAGMA busy_timeout=1500; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_blocks (position INTEGER PRIMARY KEY, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL, task_id TEXT NOT NULL,
        type TEXT NOT NULL, recorded_at TEXT NOT NULL, is_switch INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_id ON events(event_id,seq);
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id,type,seq);
      CREATE INDEX IF NOT EXISTS events_type ON events(type,seq);
      CREATE INDEX IF NOT EXISTS events_switch ON events(is_switch,seq);
      CREATE INDEX IF NOT EXISTS events_time ON events(recorded_at,seq);
      CREATE TABLE IF NOT EXISTS tool_details (seq INTEGER PRIMARY KEY REFERENCES events(seq), recorded_at TEXT NOT NULL, bytes INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS details_time ON tool_details(recorded_at,seq);
      CREATE TABLE IF NOT EXISTS detail_totals (id INTEGER PRIMARY KEY CHECK(id=1), bytes INTEGER NOT NULL);
      INSERT OR IGNORE INTO detail_totals VALUES(1,0);
      CREATE TRIGGER IF NOT EXISTS detail_added AFTER INSERT ON tool_details BEGIN UPDATE detail_totals SET bytes=bytes+new.bytes WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS detail_removed AFTER DELETE ON tool_details BEGIN UPDATE detail_totals SET bytes=bytes-old.bytes WHERE id=1; END;`);
    this.insert = this.db.prepare("INSERT INTO events(event_id,task_id,type,recorded_at,is_switch,payload) VALUES(?,?,?,?,?,?)");
  }
  meta(key) { return this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key)?.value; }
  setMeta(key, value) { this.db.prepare("INSERT OR REPLACE INTO metadata VALUES(?,?)").run(key, String(value)); }
  bindSource() {
    const info = statSync(this.source);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM source_blocks");
      this.updateBlocks(0);
      for (const [key, value] of Object.entries({ offset: info.size, identity: identity(this.source),
        mtime: info.mtimeMs, ctime: info.ctimeMs, checkpoint: checkpoint(this.source, info.size) })) this.setMeta(key, value);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  updateBlocks(offset) {
    const descriptor = openSync(this.source, "r"), block = Buffer.allocUnsafe(64 * 1024);
    const insert = this.db.prepare("INSERT OR REPLACE INTO source_blocks VALUES(?,?,?)");
    try {
      const size = fstatSync(descriptor).size;
      for (let position = Math.floor(offset / block.length) * block.length; position < size; position += block.length) {
        const bytes = readSync(descriptor, block, 0, Math.min(block.length, size - position), position);
        insert.run(position, bytes, createHash("sha256").update(block.subarray(0, bytes)).digest("hex"));
      }
    } finally { closeSync(descriptor); }
  }
  prefixMatches(offset) {
    const descriptor = openSync(this.source, "r"), block = Buffer.allocUnsafe(64 * 1024);
    let checked = 0;
    try {
      for (const row of this.db.prepare("SELECT position,bytes,sha256 FROM source_blocks ORDER BY position").iterate()) {
        const bytes = readSync(descriptor, block, 0, row.bytes, row.position);
        if (bytes !== row.bytes || createHash("sha256").update(block.subarray(0, bytes)).digest("hex") !== row.sha256) return false;
        checked += bytes;
      }
      return checked === offset;
    } finally { closeSync(descriptor); }
  }
  add(event, detail = event) {
    const timestamp = Date.parse(event.recorded_at || event.recordedAt || event.created_at || event.createdAt || "");
    const at = new Date(Number.isFinite(timestamp) ? timestamp : 0).toISOString();
    const row = this.insert.run(event.event_id || "", event.task_id || "", event.type || "", at,
      event.previous_task_id && event.session_switch_id ? 1 : 0, JSON.stringify(journalEvent(event)));
    if (event.type === "tool.call" && !detail.storage_fingerprint) {
      const payload = JSON.stringify(detail);
      this.db.prepare("INSERT INTO tool_details VALUES(?,?,?,?)").run(row.lastInsertRowid, at, Buffer.byteLength(payload), payload);
    }
  }
  sync() {
    if (!existsSync(this.source)) throw new Error("TASK_EVENT_SOURCE_MISSING");
    let info = statSync(this.source);
    const offset = Number(this.meta("offset") || 0);
    const originalIdentity = this.meta("identity");
    if (originalIdentity === identity(this.source) && info.size === offset && this.meta("mtime") === String(info.mtimeMs)
      && this.meta("ctime") === String(info.ctimeMs)) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Recheck after obtaining the writer lock: another process may have caught up.
      info = statSync(this.source);
      const currentOffset = Number(this.meta("offset") || 0);
      if (this.meta("identity") === identity(this.source) && info.size === currentOffset
        && this.meta("mtime") === String(info.mtimeMs) && this.meta("ctime") === String(info.ctimeMs)) {
        this.db.exec("COMMIT"); return;
      }
      const reset = this.meta("identity") !== identity(this.source) || info.size < currentOffset
        || !this.prefixMatches(currentOffset);
      if (reset) this.db.exec("DELETE FROM tool_details; DELETE FROM events; DELETE FROM source_blocks;");
      let endOffset = reset ? 0 : currentOffset;
      for (const item of journalLines(this.source, endOffset, info.size)) {
        if (item.line.length) this.add(JSON.parse(item.line.toString("utf8")));
        endOffset = item.endOffset;
      }
      const after = statSync(this.source);
      if (["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(key => info[key] !== after[key])) throw new Error("TASK_EVENT_SOURCE_CHANGED_DURING_RECOVERY");
      this.setMeta("offset", endOffset);
      this.setMeta("identity", identity(this.source));
      this.setMeta("mtime", statSync(this.source).mtimeMs);
      this.setMeta("ctime", statSync(this.source).ctimeMs);
      this.setMeta("checkpoint", checkpoint(this.source, endOffset));
      this.updateBlocks(reset ? 0 : currentOffset);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  append(events) {
    this.sync();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previousOffset = Number(this.meta("offset") || 0);
      // Journal precedes index/projections. A crash leaves facts that sync() can recover.
      const descriptor = openSync(this.source, "a", 0o600);
      try {
        for (const event of events) {
          writeFileSync(descriptor, `${JSON.stringify(journalEvent(event))}\n`);
          this.add(event);
        }
        fsyncSync(descriptor);
      } finally { closeSync(descriptor); }
      const info = statSync(this.source);
      this.setMeta("offset", info.size); this.setMeta("identity", identity(this.source)); this.setMeta("mtime", info.mtimeMs);
      this.setMeta("ctime", info.ctimeMs); this.setMeta("checkpoint", checkpoint(this.source, info.size));
      this.updateBlocks(previousOffset);
      const retention = this.prune();
      this.db.exec("COMMIT");
      if (retention.deleted) console.error(JSON.stringify({ event: "task_tool_retention", ...retention }));
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  find(eventId, taskId = "") {
    this.sync();
    const row = this.db.prepare("SELECT seq,payload FROM events WHERE event_id=? OR (?<>'' AND task_id=? AND type='task.create') ORDER BY seq DESC LIMIT 1").get(eventId, taskId, taskId);
    if (!row) return null;
    const detail = this.db.prepare("SELECT payload FROM tool_details WHERE seq=?").get(row.seq);
    return detail ? JSON.parse(detail.payload) : JSON.parse(row.payload);
  }
  *events({ taskId, type, switches = false, since } = {}) {
    this.sync();
    const where = [], args = [];
    if (taskId !== undefined) { where.push("task_id=?"); args.push(taskId); }
    if (type) { where.push("type=?"); args.push(type); }
    if (switches) where.push("is_switch=1");
    if (since) { where.push("recorded_at>=?"); args.push(since); }
    for (const row of this.db.prepare(`SELECT payload FROM events${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY seq`).iterate(...args)) yield JSON.parse(row.payload);
  }
  recentTaskEvents(taskId, limit = 100) {
    this.sync();
    return this.db.prepare("SELECT COALESCE(d.payload,e.payload) AS payload FROM events e LEFT JOIN tool_details d ON d.seq=e.seq WHERE e.task_id=? ORDER BY e.seq DESC LIMIT ?").all(taskId, limit).reverse().map(row => JSON.parse(row.payload));
  }
  projectionBehind(eventId, projectedEventId) {
    const sequence = id => this.db.prepare("SELECT seq FROM events WHERE event_id=? ORDER BY seq DESC LIMIT 1").get(id)?.seq;
    const persisted = sequence(eventId), projected = sequence(projectedEventId || "");
    return persisted !== undefined && (projected === undefined || persisted > projected);
  }
  retain({ now = Date.now(), maxBytes = TOOL_RETENTION_BYTES, retentionMs = TOOL_RETENTION_MS } = {}) {
    this.db.exec("BEGIN IMMEDIATE");
    let result;
    try {
      result = this.prune({ now, maxBytes, retentionMs });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.db.exec("PRAGMA incremental_vacuum(256); PRAGMA wal_checkpoint(PASSIVE)");
    return result;
  }
  prune({ now = Date.now(), maxBytes = TOOL_RETENTION_BYTES, retentionMs = TOOL_RETENTION_MS } = {}) {
    let deleted = Number(this.db.prepare("DELETE FROM tool_details WHERE recorded_at < ?").run(new Date(now - retentionMs).toISOString()).changes);
    let bytes = Number(this.db.prepare("SELECT bytes FROM detail_totals WHERE id=1").get().bytes);
    const remove = this.db.prepare("DELETE FROM tool_details WHERE seq=?");
    while (bytes > maxBytes) {
      const oldest = this.db.prepare("SELECT seq,bytes FROM tool_details ORDER BY recorded_at,seq LIMIT 100").all();
      for (const row of oldest) {
        if (bytes <= maxBytes) break;
        remove.run(row.seq); bytes -= Number(row.bytes); deleted++;
      }
    }
    return { deleted, detail_bytes: bytes, max_bytes: maxBytes, retention_days: retentionMs / 86400000 };
  }
  close() { this.db.close(); }
}

const stores = new Map();
export function eventStore(source) {
  const paths = storePaths(source);
  if (!existsSync(paths.marker)) return null;
  const marker = JSON.parse(readFileSync(paths.marker, "utf8"));
  if (marker.version !== 1) throw new Error("TASK_EVENT_STORAGE_VERSION_UNSUPPORTED");
  if (!stores.has(source)) stores.set(source, new TaskEventStore(source));
  return stores.get(source);
}

export function durableTouch(path) {
  // Windows fsync needs write access; create missing files without truncating existing data.
  const descriptor = openSync(path, constants.O_CREAT | constants.O_WRONLY, 0o600);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
