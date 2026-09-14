import test from "node:test";
import assert from "node:assert/strict";
import { reviewerCommand } from "../scripts/reviewer-cli.mjs";

test("Reviewer CLI pins read-only and grants lifecycle tools without parent identity", () => {
  const options = { promptPath: "README.md", outputPath: "/tmp/reviewer-result.txt" };
  const env = { PATH: "/bin", CODEX_SESSION_ID: "parent", CODEX_THREAD_ID: "parent", TASKCENTER_CALLER_SESSION_ID: "parent" };
  const command = reviewerCommand(options, env);
  assert.deepEqual(command.args.slice(0, 3), ["exec", "-s", "read-only"]);
  assert.deepEqual(command.env, { PATH: "/bin" });
  assert.equal(env.CODEX_SESSION_ID, "parent");
  assert.deepEqual(command.args.filter((arg) => arg.includes("approval_mode")), [
    'mcp_servers.taskcenter.tools.taskcenter_session_register.approval_mode="approve"',
    'mcp_servers.taskcenter.tools.taskcenter_review_claim.approval_mode="approve"',
    'mcp_servers.taskcenter.tools.taskcenter_task_review_report.approval_mode="approve"',
  ]);
  assert.throws(() => reviewerCommand({ ...options, resume: "--yolo" }), /Invalid/);
});

test("managed launch binds workspace and lifecycle permissions without accepting inherited context", () => {
  const invocation = reviewerCommand({ promptPath: "README.md", outputPath: "/tmp/result", managed: { route_id: "route", claim_token: "capability", workspace: "/tmp", native_unavailable_reason: "native lacks independent Session" } }, { TASKCENTER_MANAGED_REVIEW: "stale" });
  assert.equal(invocation.cwd, "/tmp");
  const context = JSON.parse(invocation.env.TASKCENTER_MANAGED_REVIEW);
  assert.equal(context.route_id, "route");
  assert.equal(context.sandbox, "read-only");
  assert.match(invocation.input, /taskcenter_review_start exactly once/);
  assert.match(invocation.input, /stop immediately without retrying/);
  assert.ok(invocation.args.includes('mcp_servers.taskcenter.tools.taskcenter_review_finish.approval_mode="approve"'));
  assert.throws(() => reviewerCommand({ promptPath: "README.md", outputPath: "/tmp/result", managed: { route_id: "route" } }), /Managed review requires/);
});
