import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IDS, AGENT_CLIENTS, agentCapabilities } from "../scripts/agent-clients.mjs";
import { HARNESS_IDS, dispatchHarnessId, harnessCapabilities, invokeHarness } from "../scripts/harnesses/index.mjs";

test("Harness registry is the single source; unsupported clients never fall back to Codex", async () => {
  assert.equal(AGENT_IDS, HARNESS_IDS);
  for (const id of HARNESS_IDS) {
    assert.equal(agentCapabilities(id).label, AGENT_CLIENTS[id].label);
    assert.equal(harnessCapabilities(id).operations.openSession.supported, false);
  }
  assert.equal(harnessCapabilities("codex").operations.createSession.availability, "unknown");
  assert.equal(harnessCapabilities("kimi").usage_scope, "context_snapshot");
  assert.equal(harnessCapabilities("claude").hooks, true);
  assert.equal(harnessCapabilities("claude").operations.resumeSession.supported, false);
  assert.equal(dispatchHarnessId({ threadId: "a", harness: "codex" }, { a: { agent: "claude" } }), "claude");
  assert.equal(dispatchHarnessId({ threadId: "legacy" }), "codex");
  for (const id of ["claude", "workbuddy", "unknown", "missing", "__proto__"]) {
    await assert.rejects(invokeHarness(id, "resumeSession", {}), error => error.outcome === "not_started");
  }
  await assert.rejects(invokeHarness("codex", "toString"), error => error.code === "HARNESS_UNSUPPORTED");
  await assert.rejects(invokeHarness("codex", "createSession", { prompt: "test", workingDirectory: "relative" }), error => error.code === "HARNESS_INVALID_INPUT");
  await assert.rejects(invokeHarness("codex", "resumeSession", { prompt: "test", workingDirectory: tmpdir() }), error => error.code === "HARNESS_INVALID_INPUT");
});

test("Codex SDK adapter preserves permissions and separates delivery from terminal receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-sdk-"));
  const entry = join(root, "sdk.mjs");
  const previous = process.env.TASKCENTER_CODEX_SDK_MODULE;
  const events = [];
  try {
    await writeFile(entry, `export class Codex {
      startThread(options) {
        if (options.approvalPolicy !== "on-request" || options.sandboxMode !== "workspace-write") throw Error("permissions changed");
        return { runStreamed: async () => ({events: (async function* () {
          yield {type:"thread.started",thread_id:"native-session"};
          yield {type:"turn.started"};
          yield {type:"turn.completed"};
        })()}) };
      }
    }`);
    process.env.TASKCENTER_CODEX_SDK_MODULE = entry;
    let done;
    const completed = new Promise(resolve => { done = resolve; });
    const result = await invokeHarness("codex", "createSession", {
      workingDirectory: root, prompt: "test",
      onEvent: event => { events.push(event); if (event.status === "completed") done(); },
    });
    await completed;
    assert.equal(result.status, "accepted");
    assert.equal(result.threadId, "native-session");
    assert.deepEqual(events.map(event => event.status), ["accepted", "running", "completed"]);
    assert.ok(events.every(event => event.harness === "codex"));
    const broken = join(root, "broken.mjs");
    await writeFile(broken, 'export class Codex { startThread() { throw Error("connection lost"); } }');
    process.env.TASKCENTER_CODEX_SDK_MODULE = broken;
    await assert.rejects(invokeHarness("codex", "createSession", { workingDirectory: root, prompt: "test" }),
      error => error.code === "HARNESS_OUTCOME_UNKNOWN" && error.outcome === "unknown");
  } finally {
    if (previous === undefined) delete process.env.TASKCENTER_CODEX_SDK_MODULE;
    else process.env.TASKCENTER_CODEX_SDK_MODULE = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("Kimi uses the same invocation contract without summing context snapshots or fabricating identity", async () => {
  const sessionId = "session_019f0000-0000-7000-8000-000000000112";
  const events = [], calls = [];
  const client = {
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "initialize") return { agentCapabilities: { loadSession: true } };
      if (method === "session/new") return { sessionId };
      if (method === "session/prompt") {
        client.update({ sessionId, update: { sessionUpdate: "usage_update", used: 10, size: 100 } });
        client.update({ sessionId, update: { sessionUpdate: "usage_update", used: 12, size: 100 } });
        return { stopReason: "end_turn" };
      }
      return {};
    },
    close: async () => {},
    notify: () => {},
  };
  const result = await invokeHarness("kimi", "createSession", { workingDirectory: tmpdir(), prompt: "test", client, hook: async () => ({}), onEvent: event => events.push(event) });
  assert.equal(result.harness, "kimi");
  assert.equal(result.status, "completed");
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.taskcenterSessionId, sessionId.slice(8));
  assert.equal(result.usage.used, 12);
  assert.equal(result.usageScope, "context_snapshot");
  assert.equal(events[0].status, "accepted");
  assert.equal(events.at(-1).status, "completed");
  assert.equal(calls.filter(call => call.method === "session/new").length, 1);
  const count = calls.length;
  await assert.rejects(invokeHarness("kimi", "createSession", { workingDirectory: tmpdir(), prompt: "test", client, signal: AbortSignal.abort() }),
    error => error.code === "HARNESS_CANCELLED");
  assert.equal(calls.length, count);
});

test("Business dispatch does not import the Codex SDK or execute its CLI directly", async () => {
  const source = await readFile(new URL("../scripts/control-server.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /@openai\/codex-sdk|new Codex\(|await resumeSession\(/);
  assert.match(source, /invokeHarness\(dispatchHarness\(record\), "resumeSession"/);
});

test("CLI exit zero without a terminal receipt remains unknown and is never retried", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-cli-"));
  const cli = join(root, "cli.mjs");
  const keys = ["TASKCENTER_CODEX_COMMAND", "TASKCENTER_CODEX_PREFIX_ARGS"];
  const previous = keys.map(key => process.env[key]);
  try {
    await writeFile(cli, 'console.log(JSON.stringify({type:"thread.started",thread_id:"test-session"})); console.log(JSON.stringify({type:"turn.started"}));');
    process.env.TASKCENTER_CODEX_COMMAND = process.execPath;
    process.env.TASKCENTER_CODEX_PREFIX_ARGS = JSON.stringify([cli]);
    const events = [];
    await assert.rejects(invokeHarness("codex", "resumeSession", { sessionId: "test-session", workingDirectory: root, prompt: "test", sessionsRoot: root, onEvent: event => events.push(event) }),
      error => error.outcome === "unknown" && /完成/.test(error.message));
    assert.deepEqual(events.map(event => event.status), ["running", "unknown"]);
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    await rm(root, { recursive: true, force: true });
  }
});
