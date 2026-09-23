import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { codexAppServerInvocation, runCodexDelegated } from "../scripts/harnesses/codex-delegated.mjs";
import { cliProfile } from "../scripts/cli-profile.mjs";
import { harnessCapabilities } from "../scripts/harnesses/index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER = join(__dirname, "helpers", "codex-app-server-fake.mjs");

const SCENARIO_KEYS = ["MODEL_MISMATCH", "MODEL_MISSING", "NO_HOOK", "BAD_HOOK_MATCHER", "HOOK_WRONG_CWD", "INVALID_JSON", "EXIT_EARLY", "SLOW_TURN", "SEND_EXEC_APPROVAL", "SEND_FILE_APPROVAL", "PRE_CLAIM_APPROVAL", "UNKNOWN_REQUEST", "WRONG_THREAD_APPROVAL", "TURN_FAIL"];

function tmpDir() { return mkdtempSync(join(tmpdir(), "codex-delegated-")); }

function makeManifest(workspace, opts = {}) {
  return { workspace, mode: opts.mode || "workspace-write" };
}

function makeProfile(overrides = {}) {
  return { model: "gpt-5.6-luna", effort: "low", ...overrides };
}

// Run runCodexDelegated against the fake app-server via the spawn env seam.
// scenario maps to fake-server env vars; captureFile records thread/turn params.
async function runWithFake(workspace, { profile, prompt = "hello", signal, onSessionReady, update, authorizeTool, scenario = {}, mode } = {}) {
  const logPath = join(workspace, "test.log");
  writeFileSync(logPath, "");
  const captureFile = join(workspace, "capture.jsonl");
  const saved = {};
  const setEnv = (key, value) => {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  setEnv("TASKCENTER_CODEX_COMMAND", process.execPath);
  setEnv("TASKCENTER_CODEX_PREFIX_ARGS", JSON.stringify([FAKE_SERVER]));
  setEnv("CAPTURE_FILE", captureFile);
  for (const key of SCENARIO_KEYS) setEnv(key, scenario[key]);
  const ac = new AbortController();
  const promise = runCodexDelegated({
    manifest: makeManifest(workspace, { mode }),
    profile: profile || makeProfile(),
    prompt,
    signal: signal || ac.signal,
    logPath,
    onSessionReady: onSessionReady || (async () => {}),
    update,
    authorizeTool,
  });
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  const readCapture = () => (existsSync(captureFile) ? readFileSync(captureFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
  return { promise, abort: () => ac.abort(), restore, readCapture };
}

// --- Static invocation contract ---

test("Codex app-server invocation strips identity and carries no approval overrides or bypass", () => {
  const profile = cliProfile("codex-luna");
  assert.equal(profile.model, "gpt-6-luna");
  assert.equal(harnessCapabilities("codex").operations.runDelegatedCli.supported, true);
  const invocation = codexAppServerInvocation({
    CODEX_SESSION_ID: "parent",
    TASKCENTER_CALLER_SESSION_ID: "parent",
    TASKCENTER_MANAGED_REVIEW: "1",
    PATH: "/bin",
  });
  assert.deepEqual(invocation.args, ["app-server", "--stdio"]);
  assert.equal(invocation.env.CODEX_SESSION_ID, undefined);
  assert.equal(invocation.env.TASKCENTER_CALLER_SESSION_ID, undefined);
  assert.equal(invocation.env.TASKCENTER_MANAGED_REVIEW, undefined);
  const serialized = JSON.stringify(invocation);
  assert.equal(serialized.includes("mcp_servers"), false, "no MCP approval_mode overrides");
  assert.equal(serialized.includes("approval_mode"), false);
  assert.equal(serialized.includes("dangerously-bypass"), false);
  assert.equal(serialized.includes("exec"), false, "legacy exec path removed");
});

// --- Hook coverage preflight (fail closed before any model tokens) ---

test("missing synchronous hook coverage fails closed before thread/start", async () => {
  const dir = tmpDir();
  const { promise, restore, readCapture } = await runWithFake(dir, { scenario: { NO_HOOK: "1" } });
  try {
    await assert.rejects(promise, /CLI_CODEX_HOOK_COVERAGE/);
    assert.equal(readCapture().length, 0, "no thread/start or turn reached the server");
  } finally { restore(); }
});

test("hook matcher without exec_command fails closed", async () => {
  const dir = tmpDir();
  const { promise, restore, readCapture } = await runWithFake(dir, { scenario: { BAD_HOOK_MATCHER: "1" } });
  try {
    await assert.rejects(promise, /CLI_CODEX_HOOK_COVERAGE/);
    assert.equal(readCapture().length, 0);
  } finally { restore(); }
});

test("hook entry for a different cwd fails closed", async () => {
  const dir = tmpDir();
  const { promise, restore, readCapture } = await runWithFake(dir, { scenario: { HOOK_WRONG_CWD: "1" } });
  try {
    await assert.rejects(promise, /CLI_CODEX_HOOK_COVERAGE/);
    assert.equal(readCapture().length, 0);
  } finally { restore(); }
});

// --- Protocol flow ---

test("successful claim-then-turn sequence with exact model verification", async () => {
  const dir = tmpDir();
  const { promise, restore, readCapture } = await runWithFake(dir, {
    onSessionReady: async (value) => {
      assert.equal(typeof value.taskcenterSessionId, "string");
      assert.ok(value.taskcenterSessionId.length > 0);
    },
  });
  try {
    const result = await promise;
    assert.equal(result.status, "completed");
    assert.deepEqual(result.reportedModels, ["gpt-5.6-luna"]);
    assert.equal(result.rawStatus, "completed");
    const threadStart = readCapture().find(e => e.kind === "thread/start");
    assert.equal(threadStart.params.model, "gpt-5.6-luna");
    assert.equal(threadStart.params.config.model, "gpt-5.6-luna");
    assert.equal(threadStart.params.config.model_reasoning_effort, "low");
    assert.equal(threadStart.params.sandbox, "workspace-write");
    const turnStart = readCapture().find(e => e.kind === "turn/start");
    assert.equal(turnStart.params.effort, "low");
    assert.equal(turnStart.params.threadId, "thread-test-001");
  } finally { restore(); }
});

test("read-only manifest mode is honored as thread sandbox", async () => {
  const dir = tmpDir();
  const { promise, restore, readCapture } = await runWithFake(dir, { mode: "read-only" });
  try {
    const result = await promise;
    assert.equal(result.status, "completed");
    assert.equal(readCapture().find(e => e.kind === "thread/start").params.sandbox, "read-only");
  } finally { restore(); }
});

test("model mismatch between requested and returned is rejected", async () => {
  const dir = tmpDir();
  const { promise, restore, readCapture } = await runWithFake(dir, { scenario: { MODEL_MISMATCH: "1" } });
  try {
    await assert.rejects(promise, /CODEX_MODEL_MISMATCH/);
    assert.equal(readCapture().some(e => e.kind === "turn/start"), false, "no turn after mismatch");
  } finally { restore(); }
});

test("missing model in thread/start result is rejected", async () => {
  const dir = tmpDir();
  const { promise, restore, readCapture } = await runWithFake(dir, { scenario: { MODEL_MISSING: "1" } });
  try {
    await assert.rejects(promise, /CODEX_MODEL_MISSING/);
    assert.equal(readCapture().some(e => e.kind === "turn/start"), false);
  } finally { restore(); }
});

test("claim failure prevents turn from being sent", async () => {
  const dir = tmpDir();
  const { promise, restore, readCapture } = await runWithFake(dir, {
    onSessionReady: async () => { throw new Error("CLAIM_REJECTED"); },
  });
  try {
    await assert.rejects(promise, /CLAIM_REJECTED/);
    assert.equal(readCapture().some(e => e.kind === "turn/start"), false);
  } finally { restore(); }
});

test("process early exit settles promptly with an error", async () => {
  const dir = tmpDir();
  const { promise, restore } = await runWithFake(dir, { scenario: { EXIT_EARLY: "1" } });
  try {
    await assert.rejects(promise, /CODEX_PROCESS_EXIT/);
  } finally { restore(); }
});

test("invalid JSON from server is fatal", async () => {
  const dir = tmpDir();
  const { promise, restore } = await runWithFake(dir, { scenario: { INVALID_JSON: "1" } });
  try {
    await assert.rejects(promise, /CODEX_STDIO_INVALID_JSON/);
  } finally { restore(); }
});

test("abort signal terminates the child and settles promptly", async () => {
  const dir = tmpDir();
  const { promise, abort, restore } = await runWithFake(dir, { scenario: { SLOW_TURN: "1" } });
  try {
    setTimeout(abort, 100);
    const result = await promise;
    assert.equal(result.status, "cancelled");
  } finally { restore(); }
});

// --- Approval routing (table-driven) ---

const approvalCases = [
  {
    name: "exec approval reaches authorizeTool with exact command/cwd and is accepted",
    scenario: { SEND_EXEC_APPROVAL: "1" },
    expectCallback: true,
    expectDecision: "accept",
    captureKind: "exec-approval-response",
  },
  {
    name: "exec approval with wrong thread identity is declined without callback",
    scenario: { WRONG_THREAD_APPROVAL: "1", SEND_EXEC_APPROVAL: "1" },
    expectCallback: false,
    expectDecision: "decline",
    captureKind: "exec-approval-response",
  },
  {
    name: "file change approval is declined without callback",
    scenario: { SEND_FILE_APPROVAL: "1" },
    expectCallback: false,
    expectDecision: "decline",
    captureKind: "file-approval-response",
  },
  {
    name: "unknown server request is answered with -32601",
    scenario: { UNKNOWN_REQUEST: "1" },
    expectCallback: false,
    expectError: -32601,
    captureKind: "unknown-response",
  },
];

for (const c of approvalCases) {
  test(c.name, async () => {
    const dir = tmpDir();
    const calls = [];
    const { promise, restore, readCapture } = await runWithFake(dir, {
      scenario: c.scenario,
      authorizeTool: async (tool, args) => {
        calls.push({ tool, args });
        return true;
      },
    });
    try {
      const result = await promise;
      assert.equal(result.status, "completed");
      if (c.expectCallback) {
        assert.equal(calls.length, 1);
        assert.equal(calls[0].tool, "Bash");
        assert.deepEqual(calls[0].args, { command: "ls -la", cwd: "/tmp" });
      } else {
        assert.equal(calls.length, 0, "authorizeTool must not be called");
      }
      const captured = readCapture().find(e => e.kind === c.captureKind);
      assert.ok(captured, `expected captured ${c.captureKind}`);
      if (c.expectError != null) {
        assert.equal(captured.params?.error?.code, c.expectError);
      } else {
        assert.equal(captured.params?.result?.decision, c.expectDecision);
      }
    } finally { restore(); }
  });
}
