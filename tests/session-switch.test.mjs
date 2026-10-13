import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";

const root = mkdtempSync(join(tmpdir(), "session-switch-"));
for (const [key, file] of Object.entries({ TASKCENTER_TASK_LEDGER_PATH: "ledger.json", TASKCENTER_TASK_EVENTS_PATH: "events.jsonl", TASKCENTER_TASK_EVENT_IDS_PATH: "ids.json", TASKCENTER_SESSION_REGISTRY_PATH: "sessions.json", TASKCENTER_SESSION_MERGES_PATH: "merges.json", TASKCENTER_DELEGATIONS_PATH: "delegations.json", TASKCENTER_SESSION_SWITCH_PATH: "switch.jsonl" })) process.env[key] = join(root, file);
const { recordTaskEvent, recordSessionL0Audit, loadTasks, loadSessionRegistry } = await import("../scripts/task-ledger.mjs");
const { prepareSessionSwitch, confirmSessionSwitch, switchCheckpoint, switchTaskFingerprint, readRecoveryCheckpoint } = await import("../scripts/session-switch.mjs");
const workspace = join(root, "repo"), sessions = join(root, "rollouts");
mkdirSync(workspace); mkdirSync(sessions);
const git = (...args) => execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8" }).trim();
git("init", "-q"); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
const revision = git("rev-parse", "HEAD");
const session_id = "019f0000-0000-7000-8000-000000000888";
const log = join(sessions, `rollout-${session_id}.jsonl`);
writeFileSync(log, JSON.stringify({ type: "session_meta", payload: { id: session_id } }) + "\n");
const event = (input) => recordTaskEvent({ session_id, workspace, ...input }, { requireRegistered: true });
const checkpoint = (id = "old") => switchCheckpoint(loadTasks().find((task) => task.id === id), loadTasks(), loadSessionRegistry()[session_id]);
const request = { task_id: "old", session_id, event_id: "switch-prepare", next_task_id: "next", next_goal: "next goal" };

test("host-confirmed one-use switch preserves a sealed predecessor and fails closed", async () => {
  try {
    event({ type: "session.register", agent: "codex", model: "fixture", provider: "openai" });
    event({ type: "task.create", task_id: "old", title: "old", goal: "old" });
    await assert.rejects(prepareSessionSwitch(request, sessions, checkpoint), /SWITCH_ACTIVE_TASK/);
    event({ type: "task.update", task_id: "old", status: "cancelled" });
    await assert.rejects(prepareSessionSwitch(request, sessions, checkpoint), /CANCELLATION_EVIDENCE/);
    event({ type: "task.update", task_id: "old", evidence: ["cancelled with clean commit"], retrospective: "user cancelled", subject_ref: { type: "git_commit", value: revision, observed_at: new Date().toISOString() } });
    const old = loadTasks().find((task) => task.id === "old");
    assert.throws(() => switchCheckpoint({ ...old, status: "done_claimed", completionReadiness: { completionClaim: { allowed: false } } }, [{ ...old, status: "done_claimed" }], loadSessionRegistry()[session_id]), /COMPLETION_NOT_READY/);
    assert.throws(() => switchCheckpoint(old, [old], { agent: "codex", workspace: "/other" }), /WORKSPACE_MISMATCH/);
    assert.doesNotThrow(() => switchCheckpoint(old, [old], loadSessionRegistry()[session_id], [{ status: "active" }]), "历史委派不阻塞主线切换");
    writeFileSync(join(workspace, "dirty"), "dirty");
    await assert.rejects(prepareSessionSwitch(request, sessions, checkpoint), /WORKSPACE_DIRTY/);
    rmSync(join(workspace, "dirty"));
    recordSessionL0Audit(session_id, root);
    assert.equal(loadSessionRegistry()[session_id].workspace, workspace);
    const [prepared, duplicate] = await Promise.all([prepareSessionSwitch(request, sessions, checkpoint), prepareSessionSwitch(request, sessions, checkpoint)]);
    assert.equal(prepared.switch_id, duplicate.switch_id);
    assert.equal(Date.parse(prepared.expires_at) - Date.parse(prepared.prepared_at), 15 * 60_000);
    assert.equal(prepared.host_action.executed, false);
    await assert.rejects(prepareSessionSwitch({ ...request, event_id: "competing" }, sessions, checkpoint), /PENDING_REQUEST_EXISTS/);
    await assert.rejects(prepareSessionSwitch({ ...request, next_goal: "tampered" }, sessions, checkpoint), /EVENT_CONFLICT/);
    const confirm = { switch_id: prepared.switch_id, session_id };
    await assert.rejects(confirmSessionSwitch(confirm, sessions, checkpoint), /HOST_COMPACTION_CAPABILITY_UNAVAILABLE/);
    const create = { type: "task.create", event_id: "create-next", task_id: "next", title: "next", goal: "next goal", session_switch_id: prepared.switch_id };
    assert.throws(() => event(create), /HOST_COMPACTION_REQUIRED/);
    await setTimeout(5);
    appendFileSync(log, JSON.stringify({ type: "response_item", timestamp: new Date().toISOString(), payload: { type: "context_compacted" } }) + "\n");
    await assert.rejects(confirmSessionSwitch(confirm, sessions, checkpoint), /HOST_COMPACTION_CAPABILITY_UNAVAILABLE/);
    appendFileSync(log, JSON.stringify({ type: "compacted", timestamp: new Date().toISOString(), payload: { message: "fixture host compaction" } }) + "\n");
    await assert.rejects(confirmSessionSwitch({ ...confirm, session_id: "another" }, sessions, checkpoint), /REQUEST_MISMATCH/);
    // A real-looking log alone is insufficient: the host recovery path is mandatory.
    await assert.rejects(confirmSessionSwitch(confirm, sessions, checkpoint), /HOST_COMPACTION_CAPABILITY_UNAVAILABLE/);
    const preparedJournal = readFileSync(process.env.TASKCENTER_SESSION_SWITCH_PATH, "utf8");
    const savedLog = readFileSync(log, "utf8");
    const restoreFixture = () => {
      writeFileSync(process.env.TASKCENTER_SESSION_SWITCH_PATH, preparedJournal);
      writeFileSync(log, savedLog);
    };
    const mutatePrepared = (mutate) => {
      const record = JSON.parse(preparedJournal.trim()); mutate(record);
      writeFileSync(process.env.TASKCENTER_SESSION_SWITCH_PATH, JSON.stringify(record) + "\n");
    };
    for (const [mutate, error] of [
      [(record) => { record.recovery.task.goal = "corrupted"; }, /INTEGRITY_FAILED/],
      [(record) => { record.generation++; }, /INTEGRITY_FAILED/],
      [(record) => { record.recovery.client_session_id = "other"; }, /INTEGRITY_FAILED/],
      [(record) => { record.revision = "other"; }, /INTEGRITY_FAILED/],
      [(record) => { record.expires_at = "invalid"; }, /SWITCH_EXPIRED/],
      [(record) => { record.expires_at = "2000-01-01T00:00:00.000Z"; }, /SWITCH_EXPIRED/],
    ]) {
      mutatePrepared(mutate);
      assert.throws(() => readRecoveryCheckpoint(prepared.switch_id, session_id, checkpoint), error);
      restoreFixture();
    }
    rmSync(process.env.TASKCENTER_SESSION_SWITCH_PATH);
    assert.throws(() => readRecoveryCheckpoint(prepared.switch_id, session_id, checkpoint), /REQUEST_MISMATCH/);
    restoreFixture();
    const calls = [];
    const host = {
      async compact() {
        calls.push("compact");
        assert.equal(readRecoveryCheckpoint(prepared.switch_id, session_id, checkpoint).digest, prepared.checkpoint_digest);
        await setTimeout(5);
        appendFileSync(log, JSON.stringify({ type: "compacted", timestamp: new Date().toISOString(), payload: { message: "fixture controlled host compaction" } }) + "\n");
        return { thread_id: session_id, turn_id: "turn", item_id: "item" };
      },
      async restore(recovery) {
        calls.push("restore");
        assert.deepEqual(recovery.task, prepared.recovery.task);
        return { digest: recovery.digest, generation: recovery.generation };
      },
    };
    await assert.rejects(confirmSessionSwitch(confirm, sessions, checkpoint, { ...host, async restore() { throw new Error("fixture restore failed"); } }), /restore failed/);
    assert.throws(() => event(create), /RECOVERY_FAILED/);
    restoreFixture();
    await assert.rejects(confirmSessionSwitch(confirm, sessions, checkpoint, { ...host, async restore() { return { digest: "wrong", generation: 1 }; } }), /RECOVERY_FAILED/);
    restoreFixture();
    await assert.rejects(confirmSessionSwitch(confirm, sessions, checkpoint, { ...host, async compact() {
      const result = await host.compact();
      mutatePrepared((record) => { record.recovery.task.goal = "corrupted after compaction"; });
      return result;
    }, async restore(recovery) { return host.restore(recovery); } }), /INTEGRITY_FAILED/);
    restoreFixture();
    await assert.rejects(confirmSessionSwitch(confirm, sessions, checkpoint, { ...host, async compact() { throw new Error("host failed"); } }), /host failed/);
    restoreFixture();
    calls.length = 0;
    const receipt = await confirmSessionSwitch(confirm, sessions, checkpoint, host);
    assert.deepEqual(calls, ["restore", "compact", "restore"]);
    assert.equal(receipt.checkpoint_digest, prepared.checkpoint_digest);
    assert.equal(receipt.generation, prepared.generation);
    assert.equal(receipt.evidence.source, "codex_session_jsonl");
    assert.deepEqual(await confirmSessionSwitch(confirm, sessions, checkpoint), receipt);
    assert.throws(() => event({ ...create, goal: "tampered" }), /TARGET_MISMATCH/);
    writeFileSync(join(workspace, "dirty"), "dirty");
    assert.throws(() => event(create), /WORKSPACE_DIRTY/);
    rmSync(join(workspace, "dirty"));
    const audit = readFileSync(process.env.TASKCENTER_SESSION_SWITCH_PATH, "utf8");
    writeFileSync(process.env.TASKCENTER_SESSION_SWITCH_PATH, audit.split("\n").filter(Boolean).map((line) => { const item = JSON.parse(line); if (item.kind === "prepared") item.expires_at = "2000-01-01T00:00:00.000Z"; return JSON.stringify(item); }).join("\n") + "\n");
    assert.throws(() => event(create), /SWITCH_EXPIRED/);
    writeFileSync(process.env.TASKCENTER_SESSION_SWITCH_PATH, audit);
    const before = switchTaskFingerprint(loadTasks().find((task) => task.id === "old"));
    const created = event(create);
    assert.equal(created.task.previousTaskId, "old");
    assert.equal(event(create).idempotent, true);
    assert.equal(loadTasks().filter((task) => ["planned", "in_progress", "blocked"].includes(task.status)).length, 1);
    assert.throws(() => event({ ...create, event_id: "replay", task_id: "third" }), /TARGET_MISMATCH|ALREADY_CONSUMED/);
    assert.throws(() => event({ type: "task.create", task_id: "third", title: "third", goal: "third" }), /ACTIVE_TASK_CONFLICT/);
    assert.throws(() => event({ type: "task.update", task_id: "old", status: "in_progress" }), /PREDECESSOR_SEALED/);
    assert.equal(switchTaskFingerprint(loadTasks().find((task) => task.id === "old")), before);
    const persisted = JSON.parse(readFileSync(process.env.TASKCENTER_TASK_LEDGER_PATH));
    assert.equal(persisted.find((task) => task.id === "next").sessionSwitchId, prepared.switch_id);
    // Crash after durable create event, before projection / processed IDs: fail closed.
    writeFileSync(process.env.TASKCENTER_TASK_LEDGER_PATH, JSON.stringify(persisted.filter((task) => task.id !== "next")));
    writeFileSync(process.env.TASKCENTER_TASK_EVENT_IDS_PATH, "[]");
    assert.throws(() => event(create), /SWITCH_LEDGER_RECOVERY_REQUIRED/);
    assert.throws(() => event({ ...create, event_id: "crash-retry" }), /SWITCH_ALREADY_CONSUMED/);
    assert.throws(() => event({ type: "task.update", task_id: "old", status: "in_progress" }), /PREDECESSOR_SEALED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
