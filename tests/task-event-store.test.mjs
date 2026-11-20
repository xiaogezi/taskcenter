import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskEventStore, durableTouch, journalEvent, storePaths } from "../scripts/task-event-store.mjs";
import { migrateTaskEvents, recoverLegacyJournal } from "../scripts/task-event-migration.mjs";
import { eventFingerprint } from "../scripts/task-event-identity.mjs";
import { spawn } from "node:child_process";

const now = Date.now();
const event = (id, type = "tool.call", at = now) => ({ event_id: id, task_id: "task", type, goal: "", plan: [],
  recorded_at: new Date(at).toISOString(), created_at: new Date(at).toISOString(), tool_name: "query", text_format: "multiline-v1" });
function fixture(t, events) {
  const dir = mkdtempSync(join(tmpdir(), "task-event-store-")), source = join(dir, "events.jsonl");
  writeFileSync(source, events.map(JSON.stringify).join("\n") + "\n");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return source;
}

test("durableTouch creates a missing file and never truncates existing bytes", t => {
  const source = fixture(t, [event("create", "task.create")]);
  const original = readFileSync(source);
  const missing = `${source}.new`;
  durableTouch(missing);
  assert.equal(statSync(missing).size, 0);
  durableTouch(source);
  assert.deepEqual(readFileSync(source), original);
});

test("migration preserves original bytes read-only, all critical facts and complete ID/switch queries", t => {
  const input = [event("create", "task.create"), event("old", "tool.call", now - 31 * 86400000), event("recent"),
    { ...event("switch", "task.create"), previous_task_id: "before", session_switch_id: "ticket" }];
  const source = fixture(t, input), original = readFileSync(source);
  const migration = migrateTaskEvents(source), store = new TaskEventStore(source);
  try {
    assert.deepEqual(readFileSync(migration.archive), original);
    assert.equal(statSync(migration.archive).mode & 0o222, 0);
    assert.equal([...store.events()].length, input.length);
    assert.deepEqual(store.find("create"), input[0]);
    assert.equal(store.find("old").storage_fingerprint, eventFingerprint(input[1]));
    assert.equal(store.find("absent"), null);
    assert.equal([...store.events({ switches: true })][0].event_id, "switch");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM tool_details").get().n, 1);
    assert.equal(migrateTaskEvents(source).migrated, false);
    const changed = { ...input[2], goal: "real task mutation" };
    assert.equal(journalEvent(changed).goal, changed.goal);
  } finally { store.close(); }
});

for (const boundary of ["prepared", "archived", "journal", "database"]) {
  test(`migration resumes without losing facts after crash at ${boundary}`, t => {
    const source = fixture(t, [event("create", "task.create"), event("detail")]);
    const original = readFileSync(source);
    assert.throws(() => migrateTaskEvents(source, { fault: stage => { if (stage === boundary) throw new Error("crash"); } }), /crash/);
    const result = migrateTaskEvents(source), store = new TaskEventStore(source);
    try {
      assert.deepEqual(readFileSync(result.archive), original);
      assert.equal([...store.events()].length, 2);
      assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM tool_details").get().n, 1);
      store.append([event("new", "task.update")]);
      assert.ok(store.find("new"));
    } finally { store.close(); }
  });
}

test("retention enforces age and bytes without deleting replay identities or critical facts", t => {
  const source = fixture(t, [event("create", "task.create"), event("one"), event("two"), event("three")]);
  migrateTaskEvents(source);
  const store = new TaskEventStore(source);
  try {
    const oneSize = Buffer.byteLength(JSON.stringify(event("three")));
    const retained = store.retain({ now, maxBytes: oneSize + 5 });
    assert.ok(retained.deleted >= 2);
    assert.ok(retained.detail_bytes <= oneSize + 5);
    assert.equal([...store.events()].length, 4);
    assert.equal(store.find("one").storage_fingerprint, eventFingerprint(event("one")));
    assert.equal(store.find("create").type, "task.create");
    assert.equal(store.retain({ now: now + 32 * 86400000 }).detail_bytes, 0);
  } finally { store.close(); }
});

test("index catches journal-before-index crashes, old-release appends, replacement and rewritten prefixes", t => {
  const source = fixture(t, [event("create", "task.create")]);
  migrateTaskEvents(source);
  const store = new TaskEventStore(source);
  try {
    appendFileSync(source, `${JSON.stringify(event("crash", "task.update"))}\n`);
    assert.ok(store.find("crash"));
    const replacement = [event("different", "task.create"), event("more", "task.update")];
    writeFileSync(source, replacement.map(JSON.stringify).join("\n") + "\n");
    assert.equal(store.find("create"), null);
    assert.ok(store.find("different"));
    assert.equal([...store.events()].length, 2);
    appendFileSync(source, "incomplete");
    assert.throws(() => store.find("absent"), /JOURNAL_INCOMPLETE/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 2);
  } finally { store.close(); }
});

test("malformed and changing sources never activate an incomplete authority index", t => {
  const source = fixture(t, [event("create", "task.create")]);
  appendFileSync(source, "broken\n");
  const original = readFileSync(source);
  assert.throws(() => migrateTaskEvents(source));
  assert.deepEqual(readFileSync(source), original);
  assert.throws(() => readFileSync(storePaths(source).marker), /ENOENT/);
});

test("middle rewrites with append and restored mtime cannot leave a false complete index", t => {
  const input = Array.from({ length: 300 }, (_, n) => ({ ...event(`id-${n}`, "task.update"), padding: "x".repeat(1000) }));
  const source = fixture(t, input);
  migrateTaskEvents(source);
  const store = new TaskEventStore(source);
  try {
    assert.ok(store.find("id-150"));
    const before = statSync(source);
    const changed = readFileSync(source, "utf8").replace('"event_id":"id-150"', '"event_id":"id-XYZ"');
    writeFileSync(source, changed + JSON.stringify(event("after", "task.update")) + "\n");
    utimesSync(source, before.atime, before.mtime);
    assert.equal(store.find("id-150"), null);
    assert.ok(store.find("id-XYZ"));
    assert.ok(store.find("after"));
  } finally { store.close(); }
});

test("online preparation imports the cutover delta and incomplete cutover restores original bytes for rollback", t => {
  const source = fixture(t, [event("create", "task.create")]);
  migrateTaskEvents(source, { prepareOnly: true });
  assert.throws(() => readFileSync(storePaths(source).marker), /ENOENT/);
  appendFileSync(source, `${JSON.stringify(event("delta", "task.update"))}\n`);
  const original = readFileSync(source);
  const result = migrateTaskEvents(source), store = new TaskEventStore(source);
  try {
    assert.ok(store.find("delta"));
    assert.deepEqual(readFileSync(result.archive), original);
    assert.equal(result.events, 2);
  } finally { store.close(); }
  const second = fixture(t, [event("other", "task.create")]);
  const before = readFileSync(second);
  assert.throws(() => migrateTaskEvents(second, { fault: stage => { if (stage === "archived") throw new Error("crash"); } }));
  recoverLegacyJournal(second);
  assert.deepEqual(readFileSync(second), before);
  assert.ok(statSync(second).mode & 0o200);
  const retry = migrateTaskEvents(second);
  assert.deepEqual(readFileSync(retry.archive), before);
});

test("independent writers serialize journal/index appends without dropping retained details", async t => {
  const source = fixture(t, [event("create", "task.create")]);
  migrateTaskEvents(source);
  const moduleUrl = new URL("../scripts/task-event-store.mjs", import.meta.url).href;
  await Promise.all(Array.from({ length: 4 }, (_, worker) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import {TaskEventStore} from ${JSON.stringify(moduleUrl)};
      const store=new TaskEventStore(${JSON.stringify(source)});
      for(let i=0;i<20;i++)store.append([{event_id:${JSON.stringify(`${worker}:`)}+i,task_id:'task',type:'tool.call',tool_name:'query',recorded_at:new Date().toISOString()}]);store.close();`], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  const store = new TaskEventStore(source);
  try {
    assert.equal([...store.events()].length, 81);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM tool_details").get().n, 80);
    assert.equal(readFileSync(source, "utf8").trim().split("\n").length, 81);
    assert.equal(store.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { store.close(); }
});

test("ledger retries remain exact after detail expiry and ID cache expiry", async t => {
  const source = fixture(t, []), dir = join(source, "..");
  for (const [key, name] of Object.entries({ TASKCENTER_TASK_EVENTS_PATH: "events.jsonl", TASKCENTER_TASK_LEDGER_PATH: "ledger.json",
    TASKCENTER_TASK_EVENT_IDS_PATH: "ids.json", TASKCENTER_SESSION_REGISTRY_PATH: "registry.json", TASKCENTER_SESSION_MERGES_PATH: "merges.json" })) process.env[key] = join(dir, name);
  const { recordTaskEvent } = await import("../scripts/task-ledger.mjs");
  const owner = { session_id: "owner" };
  recordTaskEvent({ ...owner, type: "session.register", event_id: "register" });
  recordTaskEvent({ ...owner, type: "task.create", task_id: "task", event_id: "creation", goal: "fixture" });
  const tool = { ...owner, type: "tool.call", task_id: "task", event_id: "tool-one", tool_name: "query", tool_use_id: "original" };
  recordTaskEvent(tool);
  migrateTaskEvents(source);
  const store = new TaskEventStore(source);
  store.retain({ now: Date.now() + 32 * 86400000 }); store.close();
  writeFileSync(process.env.TASKCENTER_TASK_EVENT_IDS_PATH, "[]");
  assert.equal(recordTaskEvent(tool).idempotent, true);
  assert.throws(() => recordTaskEvent({ ...tool, tool_use_id: "different" }), /不同事件/);
  assert.equal(recordTaskEvent({ ...owner, type: "task.create", task_id: "task", event_id: "creation", goal: "fixture" }).idempotent, true);
  const beforeProjection = readFileSync(process.env.TASKCENTER_TASK_LEDGER_PATH);
  const update = { ...owner, type: "task.update", task_id: "task", event_id: "persisted-before-crash", current_step: "new fact" };
  recordTaskEvent(update);
  writeFileSync(process.env.TASKCENTER_TASK_LEDGER_PATH, beforeProjection);
  assert.throws(() => recordTaskEvent(update), /任务投影落后/);
});
