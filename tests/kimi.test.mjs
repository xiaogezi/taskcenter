import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KimiAcp, reportedUsage } from "../scripts/kimi-acp.mjs";
import { runKimi } from "../scripts/kimi-run.mjs";
import { handleKimiHook } from "../scripts/kimi-context-hook.mjs";
import { kimiHooks } from "../scripts/print-integrations.mjs";

const taskcenterSessionId = "019f0000-0000-7000-8000-000000000112";
const sessionId = `session_${taskcenterSessionId}`;
test("Kimi managed run binds real identity, injects context, commits final summary and closes", async () => {
  const calls = [], lifecycle = [];
  const client = {
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "initialize") return { agentCapabilities: { loadSession: true } };
      if (method === "session/new") return { sessionId };
      if (method === "session/load") client.update({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "historical replay" } } });
      if (method === "session/prompt") {
        client.update({ sessionId: "other", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "wrong" } } });
        client.update({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } });
        client.update({ sessionId, update: { sessionUpdate: "usage_update", used: 10, size: 100 } });
        client.update({ sessionId, update: { sessionUpdate: "usage_update", used: 12, size: 100 } });
        return { stopReason: "end_turn" };
      }
      return {};
    }, close: async () => calls.push({ method: "close" }), notify: () => {},
  };
  const result = await runKimi({ cwd: tmpdir(), prompt: "test", client, hook: async (payload, options) => {
    lifecycle.push({ payload, options }); return { hookSpecificOutput: { additionalContext: "context" } };
  } });
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.taskcenterSessionId, taskcenterSessionId);
  assert.equal(lifecycle[0].payload.session_id, taskcenterSessionId);
  assert.equal(result.usage.used, 12);
  assert.equal(result.usage.cost, null);
  assert.equal(calls.find(c => c.method === "session/load").params.mcpServers[0].env[0].value, taskcenterSessionId);
  assert.equal(calls.find(c => c.method === "session/prompt").params.prompt[1].text, "context");
  assert.deepEqual(lifecycle.map(e => e.payload.hook_event_name), ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]);
  assert.equal(lifecycle[2].options.summary, "done");
  assert.equal(calls.at(-1).method, "close");
});

test("Kimi resume never creates another session; invalid identity fails closed", async () => {
  let created = false, closed = false;
  const client = { request: async method => { if (method === "initialize") return { agentCapabilities: { loadSession: true } }; if (method === "session/new") created = true; return {}; }, close: async () => { closed = true; } };
  await assert.rejects(runKimi({ cwd: tmpdir(), session: "not-a-uuid", prompt: "test", client }), /non-UUID/);
  assert.equal(created, false); assert.equal(closed, true);
  assert.equal(reportedUsage({ sessionUpdate: "agent_message_chunk" }), null);
  assert.deepEqual(reportedUsage({ sessionUpdate: "usage_update", used: -1 }), { used: null, size: null, cost: null, currency: null });
});

test("Kimi Hook isolates failures, uses distinct PCA client and never needs transcript", async () => {
  let closed = false, clientIdentity;
  const pca = {
    connectionTimeoutsForEvent: () => ({}),
    createClientIdentity: value => value,
    createConnectedCallTool: async () => ({ callTool: () => {}, close: async () => { closed = true; } }),
    handleHook: async (_payload, deps) => { clientIdentity = deps.client; return { hookSpecificOutput: { additionalContext: "PCA context" } }; },
  };
  const result = await handleKimiHook({ hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd: tmpdir() }, { taskcenter: async () => { throw new Error("offline"); }, pca });
  assert.equal(result.continue, true); assert.equal(result.hookSpecificOutput.additionalContext, "PCA context");
  assert.equal(clientIdentity.id, "kimi"); assert.equal(closed, true);
  assert.match(kimiHooks("/tmp/Task Center"), /event = "SessionStart"/);
});

test("Kimi Hook normalizes content-block prompt before PCA bridging", async () => {
  let pcaPrompt;
  const pca = {
    connectionTimeoutsForEvent: () => ({}),
    createClientIdentity: value => value,
    createConnectedCallTool: async () => ({ callTool: () => {}, close: async () => {} }),
    handleHook: async (payload) => { pcaPrompt = payload.prompt; return { continue: true }; },
  };
  const payload = {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd: tmpdir(),
    prompt: [{ type: "text", text: "前段" }, { type: "image" }, { type: "text", text: "后段" }],
  };
  const result = await handleKimiHook(payload, { taskcenter: async () => "", pca });
  assert.equal(result.continue, true);
  assert.equal(pcaPrompt, "前段后段");
});

test("ACP wire preserves permission denial and allow-once", async context => {
  if (process.platform === "win32") return context.skip("POSIX executable fixture");
  const dir = await mkdtemp(join(tmpdir(), "kimi-wire-")); context.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, "fake-kimi");
  await writeFile(script, String.raw`#!/usr/bin/env node
let buffer='';
process.stdin.on('data', chunk=>{buffer+=chunk; let i; while((i=buffer.indexOf('\n'))>=0){const msg=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);
if(msg.method==='probe')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:99,method:'session/request_permission',params:{options:[{optionId:'once',kind:'allow_once'},{optionId:'always',kind:'allow_always'}]}})+'\n');
else if(msg.id===99)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:msg.result})+'\n');
}});
`); await chmod(script, 0o755);
  for (const selected of [null, "always", "once"]) {
    const acp = new KimiAcp({ command: script, permission: async () => selected, timeout: 2000 });
    try {
      const result = await acp.request("probe", {});
      assert.equal(result.outcome.outcome, selected === "once" ? "selected" : "cancelled");
    } finally { await acp.close(); }
  }
});

test("Kimi cancels the active turn without committing completion", async () => {
  const controller = new AbortController(), events = [];
  let finish;
  const client = {
    request: async (method) => {
      if (method === "initialize") return { agentCapabilities: { loadSession: true } };
      if (method === "session/new") return { sessionId };
      if (method === "session/prompt") return new Promise(resolve => { finish = resolve; queueMicrotask(() => controller.abort()); });
      return {};
    },
    notify: (method, params) => { assert.equal(method, "session/cancel"); assert.equal(params.sessionId, sessionId); finish({ stopReason: "cancelled" }); },
    close: async () => {},
  };
  const result = await runKimi({ cwd: tmpdir(), prompt: "test", client, signal: controller.signal, hook: async payload => { events.push(payload.hook_event_name); return {}; } });
  assert.equal(result.cancelled, true);
  assert.equal(result.usage, null);
  assert.equal(events.includes("Stop"), false);
  assert.equal(events.at(-1), "SessionEnd");
});

test("Kimi resume refuses another workspace before load", async () => {
  let loaded = false;
  const client = {
    request: async method => {
      if (method === "initialize") return { agentCapabilities: { loadSession: true } };
      if (method === "session/list") return { sessions: [{ sessionId, cwd: "/another-workspace" }] };
      if (method === "session/load") loaded = true;
      return {};
    }, close: async () => {},
  };
  await assert.rejects(runKimi({ cwd: tmpdir(), session: sessionId, prompt: "test", client }), /requested workspace/);
  assert.equal(loaded, false);
});
