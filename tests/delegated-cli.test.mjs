import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cliProfile } from "../scripts/cli-profile.mjs";
import { claimCli } from "../scripts/delegated-cli-hook.mjs";
import { cliFailureKind, claudeInvocation, claudeReceipt, runDelegatedCli, runDelegatedCliFromStdin, validateCliManifest } from "../scripts/delegated-cli.mjs";
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

test("stdin 入口在领取前托管 prompt，执行后清除 prompt 并保留回执", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-stdin-test-"));
  const manifest = { profile: "kimi-k3", task_id: "task", parent_session_id: "parent", workspace: dir, delegation_id: "grant", route_id: "route", claim_token: "secret", mode: "read-only" };
  const profile = cliProfile(manifest.profile);
  let outputPath;
  try {
    const { output_path } = await runDelegatedCliFromStdin({ manifest, prompt: "bounded task" }, {
      control: async () => ({ accepted: true, delegation: { taskId: "task", parentSessionId: "parent", executorModel: profile.model, delegateSessionId: "child", workspace: dir, status: "active" } }),
      runKimi: async input => {
        await input.onSessionReady({ taskcenterSessionId: "child" });
        return { stopReason: "end_turn", reportedModel: profile.model, reportedThinking: profile.effort, finalText: "done" };
      },
    });
    outputPath = output_path;
    assert.equal(JSON.parse(readFileSync(output_path, "utf8")).status, "completed");
    assert.equal(readFileSync(output_path, "utf8").includes("secret"), false);
    assert.throws(() => readFileSync(join(dirname(output_path), "prompt.txt")), /ENOENT/);
  } finally {
    if (outputPath) rmSync(dirname(outputPath), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stdin 启动命令读取单行 JSON，不等待调用方关闭输入流", async () => {
  const child = spawn(process.execPath, [join(import.meta.dirname, "../scripts/delegated-cli.mjs"), "--stdin"], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 2_000);
  child.stdin.write('{"manifest":{},"prompt":"bounded"}\n');
  const code = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  assert.equal(code, 1);
  assert.match(stderr, /Missing profile/);
});

test("CLI 成功与确定的启动前失败释放租约，claim 未确认保留原授权", async () => {
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
      assert.equal(calls.filter(c => c.path === "/routing/result").length, mode === "claim-failure" ? 0 : 1);
      assert.equal(calls.filter(c => c.path === "/gate-denials").length, mode === "claim-failure" ? 1 : 0);
      if (mode !== "claim-failure") assert.equal(calls.find(c => c.path === "/routing/result").body.outcome, ["success", "report-failure"].includes(mode) ? "succeeded" : mode === "cancelled" ? "cancelled" : "failed");
      if (mode === "claim-failure") assert.equal(calls.some(c => c.path === "/delegations/revoke"), false);
      const output = JSON.parse(readFileSync(manifest.output_path, "utf8"));
      assert.equal(output.requested_model, profile.model);
      assert.equal(output.role, "executor");
      assert.equal(JSON.stringify(output).includes("secret"), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("重复 claim 不二次提交 prompt，显式新 attempt 正常执行", async () => {
  for (const idempotent of [true, false]) {
    const dir = mkdtempSync(join(tmpdir(), "cli-replay-test-")), calls = [];
    const manifest = { profile: "kimi-k3", task_id: "task", parent_session_id: "parent", workspace: dir, delegation_id: "grant", route_id: "route", claim_token: "secret", prompt_path: join(dir, "prompt"), output_path: join(dir, "result"), mode: "read-only" };
    writeFileSync(manifest.prompt_path, "bounded probe");
    const profile = cliProfile(manifest.profile);
    let prompted = false;
    const dependencies = {
      control: async (path, body) => {
        calls.push({ path, body });
        return { accepted: true, idempotent, delegation: { taskId: "task", parentSessionId: "parent", executorModel: profile.model, delegateSessionId: "child", workspace: dir, status: "active" } };
      },
      runKimi: async input => { await input.onSessionReady({ taskcenterSessionId: "child" }); prompted = true; return { stopReason: "end_turn", reportedModel: profile.model, reportedThinking: profile.effort, finalText: "result" }; },
    };
    try {
      if (idempotent) await assert.rejects(runDelegatedCli(manifest, dependencies), /CLI_GRANT_REPLAY/);
      else await runDelegatedCli(manifest, dependencies);
      assert.equal(prompted, !idempotent);
      assert.equal(calls.filter(c => c.path === "/delegations/claim").length, 1);
      assert.equal(calls.filter(c => c.path === "/routing/result").length, idempotent ? 0 : 1);
      if (!idempotent) assert.equal(calls.find(c => c.path === "/routing/result").body.outcome, "succeeded");
      const output = JSON.parse(readFileSync(manifest.output_path, "utf8"));
      assert.equal(output.status, idempotent ? "failed" : "completed");
      if (idempotent) {
        assert.equal(output.failure_kind, "task_permission");
        assert.equal(calls.some(c => c.path === "/delegations/revoke"), false);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("Claude SessionStart claim 未确认时不撤销原授权或释放路由", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-claude-claim-test-")), calls = [];
  const manifest = { profile: "claude-mimo", task_id: "task", parent_session_id: "parent", workspace: dir, delegation_id: "grant", route_id: "route", claim_token: "secret", prompt_path: join(dir, "prompt"), output_path: join(dir, "result"), mode: "read-only" };
  writeFileSync(manifest.prompt_path, "bounded probe");
  try {
    await assert.rejects(runDelegatedCli(manifest, {
      control: async path => { calls.push(path); return { accepted: true }; },
      runClaude: async (_received, manifestPath) => {
        const stored = JSON.parse(readFileSync(manifestPath, "utf8"));
        writeFileSync(stored.receipt_path, JSON.stringify({ claimUnconfirmed: true }));
        return { status: "failed", reportedModels: [] };
      },
    }), /CLI_NOT_CLAIMED/);
    assert.equal(calls.includes("/delegations/revoke"), false);
    assert.equal(calls.includes("/routing/result"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("受管执行能力静态注册，Kimi 权限仅转换为一次授权", async () => {
  for (const id of ["kimi", "claude"]) assert.equal(harnessCapabilities(id).operations.runDelegatedCli.supported, true);
  assert.equal(harnessCapabilities("codex").operations.runDelegatedCli.supported, false);
  assert.throws(() => requireHarnessOperation("codex", "runDelegatedCli"), /尚未适配/);
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

test("默认超时按 mode 区分，显式 timeout_ms 与 1800000 上限保持", () => {
  const base = { profile: "kimi-k3", task_id: "task", parent_session_id: "parent", route_id: "route", delegation_id: "grant", claim_token: "secret", workspace: "/work", prompt_path: "/tmp/prompt", output_path: "/tmp/result" };
  assert.equal(validateCliManifest({ ...base, mode: "read-only" }).timeout_ms, 300000);
  assert.equal(validateCliManifest({ ...base, mode: "workspace-write" }).timeout_ms, 1200000);
  assert.equal(validateCliManifest({ ...base, mode: "workspace-write", timeout_ms: 60000 }).timeout_ms, 60000);
  assert.equal(validateCliManifest({ ...base, mode: "read-only", timeout_ms: 1800000 }).timeout_ms, 1800000);
  assert.throws(() => validateCliManifest({ ...base, mode: "read-only", timeout_ms: 1800001 }), /Invalid timeout_ms/);
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
