import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { observeControlRequest } from "../scripts/control-request-observation.mjs";

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
