import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "taskcenter-review-recovery-"));
const paths = {
  TASKCENTER_TASK_EVENTS_PATH: "events.jsonl",
  TASKCENTER_TASK_LEDGER_PATH: "ledger.json",
  TASKCENTER_TASK_EVENT_IDS_PATH: "event-ids.json",
  TASKCENTER_TASK_RECONCILE_PATH: "reconcile.jsonl",
  TASKCENTER_TASK_REUSE_DECISIONS_PATH: "reuse.jsonl",
  TASKCENTER_SESSION_REGISTRY_PATH: "sessions.json",
  TASKCENTER_SESSION_MERGES_PATH: "merges.json",
  TASKCENTER_CONTEXT_TASK_MAP_PATH: "context-map.json",
  TASKCENTER_CONTEXT_AUDIT_PATH: "context-audit.jsonl",
  TASKCENTER_SESSION_SWITCH_PATH: "switch.jsonl",
  TASKCENTER_USAGE_REPORT_PATH: "usage.json",
  TASKCENTER_GATE_SESSION_ALLOWLIST_PATH: "allowlist.json",
};
for (const [key, file] of Object.entries(paths)) process.env[key] = join(directory, file);
process.env.TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION = "1";
process.env.CODEX_HOME = join(directory, "codex");
after(() => rmSync(directory, { recursive: true, force: true }));
const { recordTaskEvent, loadTasks } = await import("../scripts/task-ledger.mjs");

test("durable review recovery preserves its old contract and the current blocked lifecycle", () => {
  const common = { task_id: "review-recovery", session_id: "review-recovery-session" };
  const at = "2026-11-17T01:00:00.000Z";
  const subject = { type: "artifact", value: "same-artifact", observed_at: at };
  recordTaskEvent({ ...common, type: "task.create", goal: "initial goal", contract_version: "v2", scope: ["review recovery"], non_goals: [], workflow_profile: "fast", acceptance_criteria: [{ id: "ac", description: "recovery is correct" }], status: "in_progress", review_policy: "recommended", subject_ref: subject });
  const review = {
    ...common, event_id: "persisted-review", type: "review.reported", occurred_at: at,
    review_attestation: {
      id: "review-one", reviewer: { type: "agent", id: "independent-reviewer" },
      scope: "all", subject_ref: subject, verdict: "approved", observed_at: at,
    },
  };
  recordTaskEvent(review);
  const current = recordTaskEvent({ ...common, type: "task.update", goal: "new contract", status: "blocked", blocker: "new blocker" }).task;
  assert.equal(current.contractRevision, 2);
  // Simulate a missing review projection while preserving the durable event and
  // later contract/lifecycle writes. This is not a new external review report.
  const ledgerPath = process.env.TASKCENTER_TASK_LEDGER_PATH;
  const tasks = JSON.parse(readFileSync(ledgerPath, "utf8"));
  writeFileSync(ledgerPath, JSON.stringify(tasks.map(task => ({ ...task, reviewAttestations: [] }))));
  const recovered = recordTaskEvent(review).task;
  assert.equal(recovered.reviewAttestations.length, 1);
  assert.equal(recovered.reviewAttestations[0].contract_revision, 1);
  assert.equal(recovered.contractRevision, 2);
  assert.equal(recovered.reviewStatus, "stale");
  assert.equal(recovered.status, "blocked");
  assert.equal(recovered.goal, "new contract");
  assert.equal(recovered.lastEventId, current.lastEventId);
  assert.deepEqual(recovered.runs, current.runs);
  assert.equal(recordTaskEvent(review).task.reviewAttestations.length, 1);
  // A new request cannot enable the storage-only recovery branch via flags.
  const forged = {
    ...review, event_id: "new-stale-review", trusted_recovery: true, recover_persisted: true,
    review_attestation: { ...review.review_attestation, id: "forged-review", verdict: "changes_requested" },
  };
  assert.throws(() => recordTaskEvent(forged), /CONTRACT_REVISION_MISMATCH/);
  assert.equal(loadTasks().find(task => task.id === common.task_id).reviewAttestations.length, 1);

  const fresh = {
    ...review, event_id: "current-contract-review", contract_revision: 2,
    review_attestation: { ...review.review_attestation, id: "review-two", verdict: "changes_requested" },
  };
  assert.equal(recordTaskEvent(fresh).task.reviewStatus, "changes_requested");
  const currentTasks = JSON.parse(readFileSync(ledgerPath, "utf8"));
  writeFileSync(ledgerPath, JSON.stringify(currentTasks.map(task => ({
    ...task, reviewAttestations: task.reviewAttestations.filter(item => item.id !== "review-one"),
  }))));
  const recoveredBehindCurrent = recordTaskEvent(review).task;
  assert.deepEqual(recoveredBehindCurrent.reviewAttestations.map(item => item.id), ["review-one", "review-two"]);
  assert.equal(recoveredBehindCurrent.reviewAttestations[0].contract_revision, 1);
  assert.equal(recoveredBehindCurrent.reviewStatus, "changes_requested");
  assert.equal(recoveredBehindCurrent.lastEventId, "current-contract-review");

  recordTaskEvent({ ...fresh, event_id: "later-same-contract-review", review_attestation: {
    ...fresh.review_attestation, id: "review-three", verdict: "rejected", observed_at: "2026-11-16T01:00:00.000Z",
  } });
  const beforeSameContractRecovery = JSON.parse(readFileSync(ledgerPath, "utf8"));
  writeFileSync(ledgerPath, JSON.stringify(beforeSameContractRecovery.map(task => ({
    ...task, reviewAttestations: task.reviewAttestations.filter(item => item.id !== "review-two"),
  }))));
  const sameContractRecovered = recordTaskEvent(fresh).task;
  assert.deepEqual(sameContractRecovered.reviewAttestations.map(item => item.id), ["review-one", "review-two", "review-three"]);
  assert.equal(sameContractRecovered.reviewStatus, "rejected", "持久顺序优先于生产者时间，不让恢复覆盖同版后续审查");
  assert.equal(sameContractRecovered.lastEventId, "later-same-contract-review");
});
