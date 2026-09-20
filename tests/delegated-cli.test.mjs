import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliProfile } from "../scripts/cli-profile.mjs";
import { claimCli } from "../scripts/delegated-cli-hook.mjs";
import { claudeInvocation, claudeReceipt, runDelegatedCli } from "../scripts/delegated-cli.mjs";

test("Claude 入口保留权限门禁、移除父身份且不把退出码当完成", () => {
  const p = cliProfile("claude-mimo");
  const command = claudeInvocation({ mode: "read-only" }, "/tmp/manifest", p, { CODEX_SESSION_ID: "parent", TASKCENTER_CALLER_SESSION_ID: "parent" });
  assert.equal(command.env.CODEX_SESSION_ID, undefined);
  assert.equal(command.env.TASKCENTER_CALLER_SESSION_ID, undefined);
  assert.equal(command.args.includes("--dangerously-skip-permissions"), false);
  assert.equal(command.args[command.args.indexOf("--tools") + 1], "Read,Glob,Grep");
  assert.equal(command.args[command.args.indexOf("--effort") + 1], p.effort);
  assert.match(command.args.at(-1), /SessionStart.*PreToolUse/);
  assert.equal(claudeReceipt({ type: "system", subtype: "init" }), null);
  assert.equal(claudeReceipt({ type: "result", subtype: "error_max_turns" }).status, "failed");
  assert.equal(claudeReceipt({ type: "result", subtype: "success", permission_denials: [{}] }).status, "failed");
});

test("CLAIM 校验父任务、真实执行身份及模型，拒绝伪成功", async () => {
  const manifest = { profile: "kimi-k3", task_id: "task", parent_session_id: "parent", workspace: "/work", delegation_id: "grant", route_id: "route", claim_token: "secret" };
  await assert.rejects(claimCli(manifest, "child", async () => ({ accepted: true, delegation: { taskId: "other" } })), /MISMATCH/);
});

test("CLI 成功和初始化失败都回写并释放原租约，未知型号不能报成功", async () => {
  for (const mode of ["success", "claim-failure", "unknown-model", "report-failure"]) {
    const dir = mkdtempSync(join(tmpdir(), "cli-test-")), calls = [];
    const manifest = { profile: "kimi-k3", task_id: "task", parent_session_id: "parent", workspace: dir, delegation_id: "grant", route_id: "route", claim_token: "secret", prompt_path: join(dir, "prompt"), output_path: join(dir, "result"), mode: "read-only" };
    writeFileSync(manifest.prompt_path, "bounded probe");
    const profile = cliProfile(manifest.profile);
    let prompted = false;
    const dependencies = {
      control: async (path, body) => {
        calls.push({ path, body });
        if (path === "/delegations/claim" && mode === "claim-failure") throw new Error("claim rejected");
        if (path === "/delegations/report" && mode === "report-failure") throw new Error("report rejected");
        return { accepted: true, delegation: { taskId: "task", parentSessionId: "parent", executorModel: profile.model, delegateSessionId: "child", workspace: dir, status: "active" } };
      },
      runKimi: async input => { assert.equal(input.thinking, profile.effort); assert.equal(input.mode, "plan"); await input.onSessionReady({ taskcenterSessionId: "child" }); prompted = true; return { stopReason: "end_turn", reportedModel: mode === "unknown-model" ? null : profile.model, reportedThinking: profile.effort, finalText: "result" }; },
    };
    try {
      if (mode === "success") await runDelegatedCli(manifest, dependencies);
      else await assert.rejects(runDelegatedCli(manifest, dependencies));
      assert.equal(prompted, mode !== "claim-failure");
      assert.equal(calls.filter(c => c.path === "/routing/result").length, 1);
      assert.equal(calls.find(c => c.path === "/routing/result").body.outcome, ["success", "report-failure"].includes(mode) ? "succeeded" : "failed");
      const output = JSON.parse(readFileSync(manifest.output_path, "utf8"));
      assert.equal(output.requested_model, profile.model);
      assert.equal(output.role, "executor");
      assert.equal(JSON.stringify(output).includes("secret"), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
