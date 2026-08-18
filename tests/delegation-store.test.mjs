import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const directory = await mkdtemp(join(tmpdir(), "taskcenter-delegation-"));
process.env.TASKCENTER_DELEGATIONS_PATH = join(directory, "delegations.json");
const {
  claimDelegation,
  DelegationError,
  grantDelegation,
  listDelegations,
  reportDelegation,
  resolveDelegation,
  revokeDelegation,
  touchDelegation,
} = await import("../scripts/delegation-store.mjs");

const workspace = join(directory, "workspace");
const parent = { id: "task-main", sessionId: "session-main", workspace, status: "in_progress" };
const delegate = { sessionId: "session-cli", workspace, status: "registered" };
const start = "2026-08-18T08:00:00.000Z";

after(() => rm(directory, { recursive: true, force: true }));

async function reset() {
  await rm(process.env.TASKCENTER_DELEGATIONS_PATH, { force: true });
}

function grantInput(overrides = {}) {
  return {
    parent_session_id: parent.sessionId,
    task_id: parent.id,
    event_id: "grant-main",
    delegation_id: "delegation-main",
    workspace,
    scope: ["scripts/"],
    allowed_tools: ["apply_patch"],
    executor_model: "gpt-5.3-codex-spark",
    channel: "cli",
    purpose: "实现明确文件范围",
    ttl_seconds: 600,
    ...overrides,
  };
}

test("delegation 幂等签发、一次领取且不创建正式任务", async () => {
  await reset();
  const first = grantDelegation(grantInput(), parent, start);
  assert.equal(first.idempotent, false);
  assert.ok(first.claimToken);
  assert.equal(first.delegation.status, "issued");
  const replay = grantDelegation(grantInput(), parent, start);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.claimToken, first.claimToken);
  assert.throws(
    () => grantDelegation(grantInput({ purpose: "不同目的" }), parent, start),
    (error) => error instanceof DelegationError && error.statusCode === 409,
  );

  const claimed = claimDelegation({ delegation_id: first.delegation.id, claim_token: first.claimToken, session_id: delegate.sessionId, workspace }, delegate, "2026-08-18T08:01:00.000Z");
  assert.equal(claimed.delegation.status, "active");
  assert.equal(claimed.delegation.delegateSessionId, delegate.sessionId);
  assert.equal(claimDelegation({ delegation_id: first.delegation.id, claim_token: "already-consumed", session_id: delegate.sessionId, workspace }, delegate, "2026-08-18T08:01:01.000Z").idempotent, true);
  assert.throws(
    () => claimDelegation({ delegation_id: first.delegation.id, claim_token: first.claimToken, session_id: "other", workspace }, { ...delegate, sessionId: "other" }, "2026-08-18T08:01:01.000Z"),
    (error) => error instanceof DelegationError && error.statusCode === 409,
  );
  assert.equal(resolveDelegation(delegate.sessionId, workspace, "2026-08-18T08:02:00.000Z")?.taskId, parent.id);
  assert.equal(listDelegations(parent.id).length, 1);
});

test("delegation 对工具、workspace 和文件 scope fail-closed", async () => {
  await reset();
  const issued = grantDelegation(grantInput(), parent, start);
  claimDelegation({ delegation_id: issued.delegation.id, claim_token: issued.claimToken, session_id: delegate.sessionId, workspace }, delegate, "2026-08-18T08:01:00.000Z");
  const touched = touchDelegation({ delegation_id: issued.delegation.id, session_id: delegate.sessionId, workspace, tool_name: "apply_patch", paths: ["scripts/example.mjs"] }, "2026-08-18T08:02:00.000Z");
  assert.equal(touched.delegation.toolCalls.apply_patch, 1);
  assert.throws(
    () => touchDelegation({ delegation_id: issued.delegation.id, session_id: delegate.sessionId, workspace, tool_name: "apply_patch", paths: ["README.md"] }, "2026-08-18T08:02:01.000Z"),
    (error) => error instanceof DelegationError && error.statusCode === 403,
  );
  assert.throws(
    () => touchDelegation({ delegation_id: issued.delegation.id, session_id: delegate.sessionId, workspace, tool_name: "exec_command" }, "2026-08-18T08:02:02.000Z"),
    (error) => error instanceof DelegationError && error.statusCode === 403,
  );
  assert.throws(
    () => touchDelegation({ delegation_id: issued.delegation.id, session_id: delegate.sessionId, workspace: join(directory, "other"), tool_name: "apply_patch", paths: ["scripts/example.mjs"] }, "2026-08-18T08:02:03.000Z"),
    (error) => error instanceof DelegationError && error.statusCode === 403,
  );
});

test("CLI Run 终态、撤销与 TTL 均不改变主任务", async () => {
  await reset();
  const issued = grantDelegation(grantInput({ scope: ["."], allowed_tools: ["exec_command"] }), parent, start);
  claimDelegation({ delegation_id: issued.delegation.id, claim_token: issued.claimToken, session_id: delegate.sessionId, workspace }, delegate, "2026-08-18T08:01:00.000Z");
  touchDelegation({ delegation_id: issued.delegation.id, session_id: delegate.sessionId, workspace, tool_name: "Bash" }, "2026-08-18T08:02:00.000Z");
  assert.equal(listDelegations(parent.id)[0].toolCalls.Bash, 1);
  const finished = reportDelegation({ delegation_id: issued.delegation.id, session_id: delegate.sessionId, workspace, event_id: "run-finished", status: "succeeded", summary: "完成", tests: ["node --test"], changed_files: ["scripts/example.mjs"] }, "2026-08-18T08:03:00.000Z");
  assert.equal(finished.delegation.status, "succeeded");
  assert.equal(reportDelegation({ delegation_id: issued.delegation.id, session_id: delegate.sessionId, workspace, event_id: "run-finished", status: "succeeded", summary: "完成", tests: ["node --test"], changed_files: ["scripts/example.mjs"] }, "2026-08-18T08:03:01.000Z").idempotent, true);
  assert.throws(
    () => reportDelegation({ delegation_id: issued.delegation.id, session_id: delegate.sessionId, workspace, event_id: "run-finished", status: "succeeded", summary: "不同结果" }, "2026-08-18T08:03:01.000Z"),
    (error) => error instanceof DelegationError && error.statusCode === 409,
  );
  assert.equal(resolveDelegation(delegate.sessionId, workspace, "2026-08-18T08:03:01.000Z"), null);
  assert.equal(parent.status, "in_progress");

  await reset();
  const expiring = grantDelegation(grantInput({ ttl_seconds: 60 }), parent, start);
  assert.equal(resolveDelegation("nobody", workspace, "2026-08-18T08:01:01.000Z"), null);
  assert.equal(listDelegations(parent.id)[0].status, "expired");
  assert.throws(
    () => claimDelegation({ delegation_id: expiring.delegation.id, claim_token: expiring.claimToken, session_id: delegate.sessionId, workspace }, delegate, "2026-08-18T08:01:02.000Z"),
    (error) => error instanceof DelegationError && error.statusCode === 410,
  );

  await reset();
  const revocable = grantDelegation(grantInput(), parent, start);
  const revoked = revokeDelegation({ delegation_id: revocable.delegation.id, parent_session_id: parent.sessionId }, "2026-08-18T08:00:10.000Z");
  assert.equal(revoked.delegation.status, "revoked");
});

test("scope 拒绝绝对路径和上级目录", async () => {
  await reset();
  for (const scope of [["../secret"], [workspace]]) {
    assert.throws(
      () => grantDelegation(grantInput({ scope }), parent, start),
      (error) => error instanceof DelegationError && error.statusCode === 400,
    );
  }
});
