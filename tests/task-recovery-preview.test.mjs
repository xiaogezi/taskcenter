import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { previewTaskRecovery } from "../scripts/task-recovery-preview.mjs";

test("恢复预览只读，区分缺失、移除、未知状态和活跃冲突", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "task-recovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.json");
  const eventsPath = join(dir, "events.jsonl");
  const ledger = JSON.stringify([{ id: "current", sessionId: "owner", status: "planned" }, { id: "removed", status: "removed" }]);
  const events = [
    { type: "task.create", event_id: "create-missing", task_id: "missing", session_id: "owner", title: "历史任务", new_state: { execution_status: "in_progress" } },
    { type: "review.reported", event_id: "review", task_id: "missing", session_id: "reviewer", new_state: { execution_status: "in_progress" } },
    { type: "task.update", event_id: "legacy", task_id: "unknown" },
    { type: "task.create", event_id: "create-current", task_id: "current" },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
  await writeFile(ledgerPath, ledger);
  await writeFile(eventsPath, events);
  const preview = await previewTaskRecovery({ ledgerPath, eventsPath });
  assert.equal(preview.mode, "preview_only");
  assert.equal(preview.complete, true);
  assert.equal(preview.tasks.length, 3);
  const missing = preview.tasks.find((task) => task.id === "missing");
  assert.equal(missing.sessionId, "owner");
  assert.deepEqual(missing.conflictingTaskIds, ["current"]);
  assert.ok(missing.issues.includes("active_session_conflict"));
  assert.equal(missing.creationEventId, "create-missing");
  const removed = preview.tasks.find((task) => task.id === "removed");
  assert.equal(removed.lastKnownStatus, null);
  assert.ok(removed.issues.includes("missing_creation_event"));
  assert.equal(await readFile(ledgerPath, "utf8"), ledger);
  assert.equal(await readFile(eventsPath, "utf8"), events);

  await writeFile(eventsPath, events + "invalid\n" + '{"partial":');
  const incomplete = await previewTaskRecovery({ ledgerPath, eventsPath });
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.malformedLines, 1);
  assert.ok(incomplete.trailingBytes > 0);
  assert.ok(incomplete.tasks.every((task) => task.issues.includes("incomplete_or_changing_source")));
});

const existing = { id: "existing", sessionId: "owner", status: "planned", lastEventId: "create-1" };
const created = { type: "task.create", task_id: existing.id, event_id: "create-1", session_id: "owner", new_state: { execution_status: "planned" } };
const updated = { type: "task.update", task_id: existing.id, event_id: "update-2", current_step: "durable newer fact",
  previous_state: created.new_state, new_state: { execution_status: "in_progress" } };
const derived = { ...updated, type: "acceptance.ready", event_id: "update-2:acceptance.ready" };

async function fixture(t, events, ledger = [existing], tail = "") {
  const dir = await mkdtemp(join(tmpdir(), "projection-diagnostics-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = { ledgerPath: join(dir, "ledger.json"), eventsPath: join(dir, "events.jsonl") };
  await writeFile(paths.ledgerPath, JSON.stringify(ledger));
  await writeFile(paths.eventsPath, events.map(event => typeof event === "string" ? event : JSON.stringify(event)).join("\n") + "\n" + tail);
  return { ...paths, dir };
}

test("现存投影：一致→journal已持久化但投影未写，重复CLI查询只报告位置而不写源", async t => {
  const paths = await fixture(t, [created]);
  assert.deepEqual((await previewTaskRecovery(paths)).projectionDiagnostics, []);
  await writeFile(paths.eventsPath, [created, updated].map(JSON.stringify).join("\n") + "\n");
  await chmod(paths.ledgerPath, 0o400); await chmod(paths.eventsPath, 0o400);
  const before = await Promise.all([readFile(paths.ledgerPath), readFile(paths.eventsPath)]);
  const expected = [{ id: "existing", state: "behind", projectedEventId: "create-1", projectedOrdinal: 1,
    latestSourceEventId: "update-2", latestSourceOrdinal: 2, issues: ["persisted_event_after_projection"] }];
  const first = await previewTaskRecovery(paths);
  assert.equal(first.complete, true); assert.deepEqual(first.tasks, []);
  assert.deepEqual(first.projectionDiagnostics, expected);
  const cli = () => JSON.parse(execFileSync(process.execPath, ["scripts/task-recovery-preview.mjs", paths.ledgerPath, paths.eventsPath], { encoding: "utf8" }));
  assert.deepEqual(cli(), first); assert.deepEqual(cli(), first);
  assert.deepEqual(await Promise.all([readFile(paths.ledgerPath), readFile(paths.eventsPath)]), before);
  assert.equal((await stat(paths.eventsPath)).mode & 0o222, 0);
  assert.deepEqual((await readdir(paths.dir)).sort(), ["events.jsonl", "ledger.json"]);
});

test("投影位置不按时间戳或最后ID猜测：派生摘要、提醒、review、重复与历史未知分开", async t => {
  const cases = [
    { name: "一致且合法连续派生", events: [created, updated, derived], anchor: "update-2", state: null },
    { name: "派生组保持同一source", events: [created, updated, derived, { ...derived, type: "review.staled", event_id: "update-2:review.staled" }], anchor: "update-2", state: null },
    { name: "提醒不推动位置", events: [created, { ...created, type: "task.reminder", event_id: "reminder" }], state: null },
    { name: "时间逆序仍按journal位置", events: [{ ...created, created_at: "2030-01-01" }, { ...updated, created_at: "2000-01-01" }], state: "behind", issue: "persisted_event_after_projection" },
    { name: "review专用补偿不推断恢复", events: [created, { ...updated, type: "review.reported" }], state: "unknown", issue: "review_evidence_requires_check", latest: "update-2" },
    { name: "review之前已投影不误报", events: [created, { ...updated, type: "review.reported" }], anchor: "update-2", state: null },
    { name: "未知锚点", events: [created, updated], anchor: "detach-outside-journal", state: "unknown", issue: "projection_anchor_missing" },
    { name: "缺锚点", events: [created, updated], anchor: null, state: "unknown", issue: "projection_anchor_missing" },
    { name: "未来类型", events: [created, { ...updated, type: "future.update" }], state: "unknown", issue: "unknown_event_semantics" },
    { name: "未来文本格式", events: [created, { ...updated, text_format: "multiline-v2" }], state: "unknown", issue: "unknown_event_semantics" },
    { name: "未来存储格式", events: [created, { ...updated, storage_format: "tool-facts-v2" }], state: "unknown", issue: "unknown_event_semantics" },
    { name: "缺事件身份", events: [created, { ...updated, event_id: undefined }], state: "unknown", issue: "unknown_event_semantics" },
    { name: "旧journal缺状态", events: [{ ...created, new_state: undefined }], state: "unknown", issue: "unknown_event_semantics" },
    { name: "压缩tool保留位置", events: [created, { type: "tool.call", task_id: "existing", event_id: "tool", storage_format: "tool-facts-v1", storage_fingerprint: "a".repeat(64) }], state: "behind", issue: "persisted_event_after_projection" },
    { name: "伪压缩tool身份", events: [created, { ...updated, type: "tool.call", new_state: undefined, storage_format: "tool-facts-v1", storage_fingerprint: "invalid" }], state: "unknown", issue: "unknown_event_semantics" },
    { name: "精确重复不推动最后位置", events: [created, updated, JSON.stringify(Object.fromEntries(Object.entries(created).reverse()))], anchor: "update-2", state: null },
    { name: "重复事实仍可报告后续落后", events: [created, created, updated], state: "behind", issue: "duplicate_event" },
    { name: "冲突ID状态不同", events: [created, { ...updated, event_id: "create-1" }], state: "unknown", issue: "ambiguous_event_identity" },
    { name: "同ID只有audit不同仍冲突", events: [created, { ...created, new_state: updated.new_state }], state: "unknown", issue: "ambiguous_event_identity" },
    { name: "跨任务重用ID", events: [created, { ...created, task_id: "other" }], state: "unknown", issue: "ambiguous_event_identity" },
    { name: "Session事件重用ID", events: [created, { type: "session.register", event_id: "create-1" }, updated], state: "unknown", issue: "ambiguous_event_identity" },
    { name: "跨任务锚点不能借用", events: [{ ...created, task_id: "other" }], state: "unknown", issue: "ambiguous_event_identity" },
    { name: "伪派生payload", events: [created, updated, { ...derived, new_state: created.new_state }], anchor: "update-2", state: "unknown", issue: "unknown_derived_event" },
    { name: "派生不连续", events: [created, updated, { type: "session.register", event_id: "registration" }, derived], anchor: "update-2", state: "unknown", issue: "unknown_derived_event" },
    { name: "派生不是合法锚点", events: [created, updated, derived], anchor: derived.event_id, state: "unknown", issue: "projection_anchor_not_source" },
  ];
  for (const item of cases) await t.test(item.name, async t => {
    const paths = await fixture(t, item.events, [{ ...existing, lastEventId: item.anchor === undefined ? "create-1" : item.anchor }]);
    const result = await previewTaskRecovery(paths);
    assert.equal(result.complete, true);
    if (item.state === null) assert.deepEqual(result.projectionDiagnostics, []);
    else {
      assert.equal(result.projectionDiagnostics[0].state, item.state); assert.ok(result.projectionDiagnostics[0].issues.includes(item.issue));
      if (item.latest) assert.equal(result.projectionDiagnostics[0].latestSourceEventId, item.latest);
    }
  });
});

test("损坏/超长/尾行不能证明投影落后，读取中源变化降为unknown", async t => {
  for (const [name, extra, tail] of [["坏行", "invalid", ""], ["超长", "x".repeat(2 * 1024 * 1024 + 1), ""], ["尾行", "", '{"partial":']]) {
    await t.test(name, async t => {
      const paths = await fixture(t, [created, updated, extra], [existing], tail);
      const result = await previewTaskRecovery(paths);
      assert.equal(result.complete, false); assert.equal(result.projectionDiagnostics[0].state, "unknown");
      assert.ok(result.projectionDiagnostics[0].issues.includes("incomplete_or_changing_source"));
      if (name === "超长") assert.equal(result.projectionDiagnostics[0].projectedOrdinal, null);
    });
  }
  const paths = await fixture(t, [created, updated]);
  // Isolated child: mutate between the scan and its final stat, without a public fault-injection API.
  const code = `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
    const target=${JSON.stringify(paths.eventsPath)}, original=fs.stat; let calls=0;
    fs.stat=async(path,...args)=>{if(path===target && ++calls===2) await fs.appendFile(target,'\\n');return original(path,...args)};
    syncBuiltinESMExports();
    const {previewTaskRecovery}=await import(${JSON.stringify(new URL("../scripts/task-recovery-preview.mjs", import.meta.url).href)});
    console.log(JSON.stringify(await previewTaskRecovery(${JSON.stringify(paths)})));`;
  const changed = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" }));
  assert.equal(changed.complete, false); assert.equal(changed.sourceChanged, true);
  assert.equal(changed.projectionDiagnostics[0].state, "unknown");
});

test("落后投影预览不解除真实幂等请求的恢复拒绝，也不修改Run或源字节", async t => {
  const { dir } = await fixture(t, [], []);
  const ledgerModule = new URL("../scripts/task-ledger.mjs", import.meta.url).href;
  const migrationModule = new URL("../scripts/task-event-migration.mjs", import.meta.url).href;
  const previewModule = new URL("../scripts/task-recovery-preview.mjs", import.meta.url).href;
  const code = `import fs from 'node:fs';import {join} from 'node:path';import assert from 'node:assert/strict';
    const dir=${JSON.stringify(dir)};
    for(const [key,file] of Object.entries({TASK_LEDGER:'ledger.json',TASK_EVENTS:'events.jsonl',TASK_EVENT_IDS:'ids.json',SESSION_REGISTRY:'sessions.json',SESSION_MERGES:'merges.json',TASK_RECONCILE:'reconcile.jsonl',SESSION_SWITCH:'switch.jsonl'})) process.env['TASKCENTER_'+key+'_PATH']=join(dir,file);
    process.env.TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION='1';process.env.CODEX_HOME=dir;
    const {recordTaskEvent}=await import(${JSON.stringify(ledgerModule)});
    const {migrateTaskEvents}=await import(${JSON.stringify(migrationModule)});
    const {previewTaskRecovery}=await import(${JSON.stringify(previewModule)});
    const ledgerPath=join(dir,'ledger.json'),eventsPath=join(dir,'events.jsonl');
    recordTaskEvent({type:'task.create',task_id:'existing',event_id:'create-1',session_id:'owner',goal:'isolated fixture'});
    const old=fs.readFileSync(ledgerPath);
    migrateTaskEvents(eventsPath);
    const update={type:'task.update',task_id:'existing',event_id:'update-2',session_id:'owner',status:'in_progress',current_step:'durable newer fact'};
    recordTaskEvent(update);
    // Simulate journal-before-projection crash only inside this disposable fixture.
    fs.writeFileSync(ledgerPath,old);
    const journal=fs.readFileSync(eventsPath);
    for(let n=0;n<2;n++){
      assert.throws(()=>recordTaskEvent(update),error=>error.statusCode===409 && error.message.includes('TASK_LEDGER_RECOVERY_REQUIRED'));
      const preview=await previewTaskRecovery({ledgerPath,eventsPath});
      assert.equal(preview.projectionDiagnostics[0].state,'behind');
      assert.deepEqual(fs.readFileSync(ledgerPath),old);assert.deepEqual(fs.readFileSync(eventsPath),journal);
    }
    console.log(JSON.stringify({denial_preserved:true,repeated_preview_readonly:true}));`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("TASKCENTER_")));
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(result.denial_preserved, true); assert.equal(result.repeated_preview_readonly, true);
});
