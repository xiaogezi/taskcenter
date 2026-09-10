import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { withCodexCompactionHost } from "../scripts/codex-compaction-host.mjs";

const content = { client_session_id: "session", workspace: "/fixture", generation: 1, task: { goal: "restore the complete task" } };
const checkpoint = { ...content, digest: createHash("sha256").update(JSON.stringify(content)).digest("hex") };
function fixture(behavior = "success") {
  const requests = [];
  class Socket extends EventTarget {
    readyState = 0;
    constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }); }
    emit(message) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
    send(raw) {
      const message = JSON.parse(raw); requests.push(message);
      const { id, method, params } = message;
      queueMicrotask(() => {
        if (method === "initialized") return;
        if (method === "initialize") { assert.equal(params.capabilities.experimentalApi, true); this.emit({ id, result: {} }); return; }
        if (method === "thread/loaded/list") { this.emit({ id, result: { data: ["session"] } }); return; }
        if (method === "thread/read") {
          this.emit({ id, result: { thread: { id: "session", sessionId: "session", cwd: "/fixture", status: { type: "idle" } } } }); return;
        }
        assert.equal(params.threadId, "session");
        if (method === "thread/compact/start") {
          this.emit({ id, result: {} });
          if (behavior === "ack-only") return;
          if (behavior === "disconnect") { this.close(); return; }
          const threadId = behavior === "wrong-thread" ? "other" : "session";
          this.emit({ method: "turn/started", params: { threadId, turn: { id: "turn" } } });
          const item = { id: "item", type: behavior === "normal-item" ? "agentMessage" : "contextCompaction" };
          this.emit({ method: "item/started", params: { threadId, turnId: "turn", item } });
          this.emit({ method: "item/completed", params: { threadId, turnId: behavior === "wrong-turn" ? "other" : "turn", item } });
          this.emit({ method: "turn/completed", params: { threadId, turn: { id: "turn", status: behavior === "failed-turn" ? "failed" : "completed", error: null } } });
          return;
        }
        assert.equal(method, "thread/inject_items");
        assert.equal(params.items[0].type, "message");
        assert.equal(params.items[0].content[0].type, "input_text");
        assert.ok(params.items[0].content[0].text.includes(JSON.stringify(checkpoint)));
        if (behavior === "concurrent-turn") this.emit({ method: "turn/started", params: { threadId: "session", turn: { id: "unexpected" } } });
        this.emit(behavior === "restore-failed" ? { id, error: { message: "inject unavailable" } } : { id, result: {} });
      });
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  const run = (operation) => withCodexCompactionHost({ url: "ws://127.0.0.1:1234", sessionId: "session", workspace: "/fixture", timeout: 100, WebSocket: Socket }, operation);
  return { run, requests };
}

test("host waits for completed compaction and injects the full recovery checkpoint without a new turn", async () => {
  const { run, requests } = fixture();
  await run(async (host) => {
    await host.restore(checkpoint);
    assert.deepEqual(await host.compact(), { thread_id: "session", turn_id: "turn", item_id: "item" });
    assert.deepEqual(await host.restore(checkpoint), { digest: checkpoint.digest, generation: 1 });
  });
  assert.deepEqual(requests.map((r) => r.method), ["initialize", "initialized", "thread/loaded/list", "thread/read", "thread/inject_items", "thread/compact/start", "thread/inject_items"]);
});

for (const behavior of ["ack-only", "disconnect", "wrong-thread", "normal-item", "wrong-turn", "failed-turn", "restore-failed", "concurrent-turn"]) {
  test(`host fails closed: ${behavior}`, async () => {
    const { run } = fixture(behavior);
    await assert.rejects(run(async (host) => { await host.restore(checkpoint); await host.compact(); await host.restore(checkpoint); }), /HOST_/);
  });
}

test("host rejects corrupt recovery data before injection", async () => {
  const { run, requests } = fixture();
  await assert.rejects(run(async (host) => { await host.restore({ ...checkpoint, generation: 2 }); }), /HOST_RECOVERY_MISMATCH/);
  assert.ok(!requests.some((r) => r.method === "thread/inject_items"));
});

test("host rejects remote endpoints and credential-bearing URLs before connection", async () => {
  for (const url of ["ws://example.com", "ws://127.0.0.1@evil.test", "ws://user:secret@127.0.0.1", "ws://127.0.0.1?token=secret", "https://127.0.0.1"]) {
    await assert.rejects(withCodexCompactionHost({ url, sessionId: "session" }, () => assert.fail("must not connect")), /HOST_LOCAL_ENDPOINT_REQUIRED/);
  }
});
