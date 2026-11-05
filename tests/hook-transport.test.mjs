import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createHookTransport } from "../scripts/hook-transport.mjs";
import { classifyGateDenial } from "../scripts/governance-metrics.mjs";

async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

for (const phase of ["headers", "body"]) {
  test(`stalled ${phase} aborts with safe correlated diagnostics`, async t => {
    let requestId;
    const controlUrl = await fixture(t, (req, res) => {
      requestId = req.headers["x-request-id"];
      if (phase === "body") { res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"partial":'); }
    });
    const client = createHookTransport({ controlUrl, totalMs: 500, reportMs: 100, requestMs: 200 });
    await assert.rejects(client.request("GET", "/task-prepare?workspace=private-path&session_id=private-id"), error => {
      assert.equal(classifyGateDenial({ message: error.message }), "hook_timeout");
      assert.equal(error.diagnostic.request_id, requestId);
      assert.equal(error.diagnostic.endpoint, "/task-prepare");
      assert.equal(error.diagnostic.method, "GET");
      assert.equal(error.diagnostic.limit_ms, 200);
      assert.ok(error.diagnostic.elapsed_ms >= 150);
      assert.doesNotMatch(error.message, /private-path|private-id/);
      return true;
    });
  });
}

test("successive requests and denial reporting share a deadline", async t => {
  let reports = 0;
  const controlUrl = await fixture(t, async (req, res) => {
    if (req.url === "/gate-denials") { reports++; return; }
    if (req.url === "/session-status") { await delay(300); res.end("{}"); }
  });
  const client = createHookTransport({ controlUrl, totalMs: 1_500, reportMs: 400, requestMs: 2_000 });
  const started = performance.now();
  await client.request("GET", "/session-status");
  await assert.rejects(client.request("GET", "/tasks"), /TASKCENTER_HOOK_TIMEOUT/);
  await assert.rejects(client.requestOnce("POST", "/gate-denials", {}, { report: true }), /TASKCENTER_HOOK_TIMEOUT/);
  assert.equal(reports, 1);
  assert.ok(performance.now() - started < 2_500, "no fresh per-request budget after exhaustion");
  const exhaustedAt = performance.now();
  await assert.rejects(client.request("GET", "/tasks"), /"limit_ms":0/);
  assert.ok(performance.now() - exhaustedAt < 100);
});

test("denial reporting has its own short cap even after an early failure", async t => {
  const controlUrl = await fixture(t, () => {});
  const client = createHookTransport({ controlUrl, totalMs: 2_000, reportMs: 100 });
  const started = performance.now();
  await assert.rejects(client.requestOnce("POST", "/gate-denials", {}, { report: true }), /"limit_ms":100/);
  assert.ok(performance.now() - started < 600);
});

test("slow recovery is aborted by the remaining shared budget", async t => {
  const controlUrl = await fixture(t, req => req.socket.destroy());
  let aborted = false;
  const client = createHookTransport({ controlUrl, totalMs: 500, reportMs: 100,
    recover: async signal => {
      try { await delay(10_000, null, { signal }); }
      finally { aborted = signal.aborted; }
    },
  });
  await assert.rejects(client.request("GET", "/tasks"), error => {
    assert.equal(error.diagnostic.phase, "recovery");
    assert.equal(error.diagnostic.endpoint, "control:start");
    assert.ok(error.diagnostic.hook_elapsed_ms < 850);
    return true;
  });
  assert.equal(aborted, true);
});

test("disconnected writes recover service without replay; permission denials do not recover", async t => {
  let requests = 0;
  let recoveries = 0;
  let appliedEvent;
  const controlUrl = await fixture(t, async (req, res) => {
    requests++;
    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      appliedEvent = JSON.parse(body).event_id;
      req.socket.destroy();
    }
    else { res.writeHead(403); res.end('{"error":"scope denied"}'); }
  });
  const client = createHookTransport({ controlUrl, recover: async () => { recoveries++; } });
  await assert.rejects(client.request("POST", "/task-events", { event_id: "applied-before-disconnect" }), error => {
    assert.equal(error.code, "TASKCENTER_POST_RESULT_UNKNOWN");
    assert.match(error.message, /已恢复.*结果未知.*未重放/);
    t.diagnostic(error.message);
    return true;
  });
  assert.equal(requests, 1);
  assert.equal(recoveries, 1);
  assert.equal(appliedEvent, "applied-before-disconnect");
  await assert.rejects(client.request("GET", "/tasks"), error => {
    assert.equal(error.statusCode, 403);
    assert.equal(classifyGateDenial({ message: error.message }), "task_permission");
    return true;
  });
  assert.equal(requests, 2);
  assert.equal(recoveries, 1);
});

test("GET retries once after recovery; repeated disconnection does not recover twice", async t => {
  let requests = 0, recoveries = 0;
  const controlUrl = await fixture(t, (req, res) => {
    requests++;
    if (recoveries === 1 && requests === 2) res.end('{"ok":true}');
    else req.socket.destroy();
  });
  const client = createHookTransport({ controlUrl, recover: async () => { recoveries++; } });
  assert.deepEqual(await client.request("GET", "/tasks"), { ok: true });
  await assert.rejects(client.request("GET", "/tasks"), /控制服务不可用/);
  assert.equal(requests, 3);
  assert.equal(recoveries, 1);
});

test("POST recovery failure remains a failure and never repeats the write", async t => {
  let writes = 0;
  const controlUrl = await fixture(t, req => { writes++; req.socket.destroy(); });
  const client = createHookTransport({ controlUrl, recover: async () => { throw new Error("recovery failed"); } });
  await assert.rejects(client.request("POST", "/task-events", {}), /recovery failed/);
  assert.equal(writes, 1);
});
