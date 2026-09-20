import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliProfile } from "../scripts/cli-profile.mjs";
import { claimCli } from "../scripts/delegated-cli-hook.mjs";
import { cliFailureKind, claudeInvocation, claudeReceipt, runDelegatedCli } from "../scripts/delegated-cli.mjs";
import { harnessCapabilities, requireHarnessOperation } from "../scripts/harnesses/index.mjs";

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
  for (const mode of ["success", "claim-failure", "unknown-model", "wrong-model", "cancelled", "report-failure"]) {
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
      runKimi: async input => { assert.equal(input.thinking, profile.effort); assert.equal(input.mode, "plan"); await input.onSessionReady({ taskcenterSessionId: "child" }); prompted = true; return { cancelled: mode === "cancelled", stopReason: "end_turn", reportedModel: mode === "unknown-model" ? null : mode === "wrong-model" ? "different-model" : profile.model, reportedThinking: profile.effort, finalText: "result" }; },
    };
    try {
      if (mode === "success") await runDelegatedCli(manifest, dependencies);
      else await assert.rejects(runDelegatedCli(manifest, dependencies));
      assert.equal(prompted, mode !== "claim-failure");
      assert.equal(calls.filter(c => c.path === "/routing/result").length, 1);
      assert.equal(calls.find(c => c.path === "/routing/result").body.outcome, ["success", "report-failure"].includes(mode) ? "succeeded" : mode === "cancelled" ? "cancelled" : "failed");
      const output = JSON.parse(readFileSync(manifest.output_path, "utf8"));
      assert.equal(output.requested_model, profile.model);
      assert.equal(output.role, "executor");
      assert.equal(JSON.stringify(output).includes("secret"), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("受管执行能力静态注册，Kimi 权限仅转换为一次授权", async () => {
  for (const id of ["kimi", "claude", "codex"]) assert.equal(harnessCapabilities(id).operations.runDelegatedCli.supported, true);
  assert.throws(() => requireHarnessOperation("unknown", "runDelegatedCli"), /尚未适配/);
  const run = requireHarnessOperation("kimi", "runDelegatedCli");
  for (const allowed of [false, true]) {
    await run({ manifest: { workspace: "/work", mode: "read-only" }, profile: cliProfile("kimi-k2.8-preview"),
      onSessionReady: async () => {}, authorizeTool: async (tool, input) => {
        assert.equal(tool, "Read"); assert.deepEqual(input, { path: "README.md" }); return allowed;
      },
      dependencies: { runKimi: async input => {
        assert.equal(input.model, "kimi-code/kimi-for-coding");
        assert.equal(await input.permission({ toolCall: { kind: "read", rawInput: { path: "README.md" } }, options: [{ kind: "allow_once", optionId: "once" }, { kind: "allow_always", optionId: "always" }] }), allowed ? "once" : null);
        return { stopReason: "unknown" };
      } },
    });
  }
});

test("Claude 受管适配经统一编排验证领取回执", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-claude-test-"));
  const manifest = { profile: "claude-mimo", task_id: "task", parent_session_id: "parent", workspace: dir, delegation_id: "grant", route_id: "route", claim_token: "secret", prompt_path: join(dir, "prompt"), output_path: join(dir, "result"), mode: "read-only" };
  writeFileSync(manifest.prompt_path, "probe");
  try {
    const result = await runDelegatedCli(manifest, { control: async () => ({ accepted: true }), runClaude: async (received, manifestPath, profile) => {
      assert.equal(received.mode, "read-only");
      const stored = JSON.parse(readFileSync(manifestPath, "utf8"));
      writeFileSync(stored.receipt_path, JSON.stringify({ sessionId: "real-child" }));
      return { status: "completed", sessionId: "real-child", reportedModels: [profile.model] };
    } });
    assert.equal(result.sessionId, "real-child");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

 test("权限错误分类保留根因", () => {
  assert.equal(cliFailureKind("MCP tool call requires approval, but approval policy is never"), "tool_approval");
  assert.equal(cliFailureKind("CLI_PERMISSION_DENIED: EACCES"), "filesystem_permission");
  assert.equal(cliFailureKind("CLI_PERMISSION_DENIED: CLI_READ_ONLY"), "task_permission");
 });

test("启动前检查失败仍撤销授权并释放路由", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-preflight-")), calls = [];
  try {
    const manifest = { profile: "kimi-k3", task_id: "task", parent_session_id: "parent", workspace: join(dir, "missing"), delegation_id: "grant", route_id: "route", claim_token: "secret", prompt_path: join(dir, "prompt"), output_path: join(dir, "result"), mode: "read-only" };
    await assert.rejects(runDelegatedCli(manifest, { control: async path => { calls.push(path); }, runKimi: async () => assert.fail("must not launch") }), /ENOENT/);
    assert.deepEqual(calls, ["/delegations/revoke", "/routing/result"]);
    assert.equal(JSON.parse(readFileSync(manifest.output_path)).status, "failed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

 test("Kimi 将同一工具更新中的参数关联到精简权限请求，终态清除", async () => {
  const run = requireHarnessOperation("kimi", "runDelegatedCli");
  const seen = [];
  await run({ manifest: { workspace: "/work", mode: "workspace-write" }, profile: cliProfile("kimi-k3"), onSessionReady: async () => {}, authorizeTool: async (tool, input) => { seen.push([tool, input]); return tool === "Bash" && input?.command === "pwd"; }, dependencies: { runKimi: async input => {
    input.update({ sessionUpdate: "tool_call", toolCallId: "a", kind: "execute" });
    input.update({ sessionUpdate: "tool_call_update", toolCallId: "a", rawInput: { command: "pwd" } });
    const options = [{ kind: "allow_once", optionId: "once" }];
    input.update({ sessionUpdate: "tool_call", toolCallId: "snapshot", kind: "execute" });
    input.update({ sessionUpdate: "tool_call_update", toolCallId: "snapshot", status: "in_progress", content: [{ type: "content", content: { type: "text", text: '{"command":"pwd"}' } }] });
    assert.equal(await input.permission({ toolCall: { toolCallId: "snapshot" }, options }), "once");
    input.update({ sessionUpdate: "tool_call_update", toolCallId: "snapshot", status: "in_progress", content: [{ type: "content", content: { type: "text", text: '{"command":' } }] });
    assert.equal(await input.permission({ toolCall: { toolCallId: "snapshot" }, options }), null);
    assert.equal(await input.permission({ toolCall: { toolCallId: "a" }, options }), "once");
    assert.equal(await input.permission({ toolCall: { toolCallId: "b" }, options }), null);
    input.update({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" });
    assert.equal(await input.permission({ toolCall: { toolCallId: "a" }, options }), null);
    return { stopReason: "end_turn" };
  } } });
  assert.deepEqual(seen[0], ["Bash", { command: "pwd" }]);
 });
