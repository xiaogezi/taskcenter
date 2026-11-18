import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { markPrepareStage, observeControlRequest } from "../scripts/control-request-observation.mjs";

test("slow or abandoned gate requests log correlated safe fields exactly once", () => {
  for (const endpoint of ["/task-prepare", "/tasks"]) for (const aborted of [true, false]) {
    let tick = 0;
    const lines = [], response = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: !aborted });
    const id = "11111111-1111-4111-8111-111111111111";
    const requestId = observeControlRequest({ url: `${endpoint}?task_id=private&session_id=private&workspace=/private`, method: "GET", headers: { "x-request-id": id } }, response, { now: () => tick, write: line => lines.push(JSON.parse(line)) });
    assert.equal(requestId, id);
    tick = aborted ? 500 : 1200;
    response.emit(aborted ? "close" : "finish"); response.emit("close");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].request_id, id);
    assert.equal(lines[0].status, aborted ? 499 : 200);
    assert.equal(lines[0].elapsed_ms, tick);
    assert.equal(lines[0].endpoint, endpoint);
    assert.doesNotMatch(JSON.stringify(lines), /private|session_id|workspace/);
  }
});

test("fast success stays quiet and untrusted request IDs are replaced", () => {
  const lines = [], response = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: true });
  observeControlRequest({ url: "/task-events", method: "POST", headers: { "x-request-id": "private-content" } }, response, { now: () => 0, write: line => lines.push(line) });
  response.emit("finish");
  assert.deepEqual(lines, []);
  const aborted = Object.assign(new EventEmitter(), { writableFinished: false });
  observeControlRequest({ url: "/task-events", method: "POST", headers: { "x-request-id": "private-content" } }, aborted, { now: () => 0, write: line => lines.push(line) });
  aborted.emit("close");
  assert.doesNotMatch(lines[0], /private-content/);
});

test("real delayed HTTP response persists safe correlated slow-request evidence", async t => {
  const dir = mkdtempSync(join(tmpdir(), "control-observation-")), path = join(dir, "requests.jsonl");
  const server = createServer((request, response) => {
    observeControlRequest(request, response, { write: line => appendFileSync(path, line + "\n") });
    setTimeout(() => response.end("{}"), 1100);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  const id = "22222222-2222-4222-8222-222222222222";
  const response = await fetch(`http://127.0.0.1:${server.address().port}/tasks?task_id=private&workspace=private`, { headers: { "X-Request-ID": id } });
  await response.text();
  const content = readFileSync(path, "utf8"), row = JSON.parse(content);
  assert.equal(row.request_id, id);
  assert.equal(row.status, 200);
  assert.equal(row.endpoint, "/tasks");
  assert.ok(row.elapsed_ms >= 1000);
  assert.doesNotMatch(content, /private|workspace/);
  t.diagnostic(content.trim());
});


test("prepare phases distinguish completed work from the phase active on disconnect", () => {
  const request = { url: "/task-prepare?session_id=private", method: "GET", headers: {} };
  const response = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false });
  let tick = 0;
  const lines = [];
  observeControlRequest(request, response, { now: () => tick, write: line => lines.push(JSON.parse(line)) });
  markPrepareStage(request, "registry");
  tick = 10;
  markPrepareStage(request, "tasks");
  tick = 35;
  markPrepareStage(request, "budget");
  markPrepareStage(request, "private-session-id");
  tick = 7500;
  response.emit("close");
  tick = 9000;
  markPrepareStage(request, "response");
  response.emit("finish");
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].stage_elapsed_ms, { registry: 10, tasks: 25, budget: 7465 });
  assert.equal(lines[0].active_stage, "budget");
  assert.equal(lines[0].client_aborted, true);
  assert.doesNotMatch(JSON.stringify(lines), /private/);
});

test("completed prepare phases exclude response flush time and preserve total latency", () => {
  const request = { url: "/task-prepare?session_id=private", method: "GET", headers: {} };
  const response = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: true });
  let tick = 0;
  const lines = [];
  observeControlRequest(request, response, { now: () => tick, write: line => lines.push(JSON.parse(line)) });
  markPrepareStage(request, "budget");
  tick = 1100;
  markPrepareStage(request, "response");
  tick = 1200;
  markPrepareStage(request, null);
  tick = 1300;
  response.emit("finish");
  assert.deepEqual(lines[0].stage_elapsed_ms, { budget: 1100, response: 100 });
  assert.equal(lines[0].active_stage, null);
  assert.equal(lines[0].elapsed_ms, 1300);
  assert.equal(lines[0].client_aborted, false);
});

test("real client disconnect records active budget phase without later duplicate evidence", async t => {
  const lines = [];
  let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  let seen;
  const started = new Promise(resolve => { seen = resolve; });
  const server = createServer((request, response) => {
    observeControlRequest(request, response, { write: line => lines.push(JSON.parse(line)) });
    markPrepareStage(request, "budget");
    response.once("close", closed);
    seen();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const controller = new AbortController();
  const pending = fetch(`http://127.0.0.1:${server.address().port}/task-prepare?session_id=private`, { signal: controller.signal });
  // Attach rejection handling before aborting, without a timing-based sleep.
  const rejected = assert.rejects(pending, error => error.name === "AbortError");
  await started;
  controller.abort();
  await rejected;
  await disconnected;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].active_stage, "budget");
  assert.equal(lines[0].client_aborted, true);
  assert.equal(lines[0].status, 499);
  assert.equal(typeof lines[0].stage_elapsed_ms.budget, "number");
  assert.doesNotMatch(JSON.stringify(lines), /private|session_id/);
});
