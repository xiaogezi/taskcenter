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
