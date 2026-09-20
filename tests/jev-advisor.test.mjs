import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, appendFile, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { criteria, requestBody, evaluate, createAdvisor, createTail, auditWriter } from "../scripts/jev-advisor.mjs";

const event = { type: "task.create", task_id: "task-1", event_id: "event-1", workspace: "/project", title: "修复按钮", goal: "修复已定位的点击事件问题", session_id: "private-session", evidence: ["private-code"] };
function answer(choice = "implementation") {
  return { model: "jev-1.13.0", answers: { task_class: { type: "choice", choice, confidence: 0.9, probabilities: Object.fromEntries(Object.keys(criteria).map(key => [key, key === choice ? 1 : 0])) } }, usage: { input_tokens: 200, output_tokens: 20 } };
}
const okFetch = async () => Response.json(answer());
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), "jev-pilot-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("only title/goal leave the process, fixed HTTPS destination rejects redirects", async () => {
  const result = await evaluate(event, { apiKey: "test-key", fetchImpl: async (url, options) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(options.redirect, "error");
    assert.deepEqual(JSON.parse(options.body).state, { title: event.title, goal: event.goal });
    assert.equal(options.headers.Authorization, "Bearer test-key");
    return Response.json(answer());
  } });
  assert.equal(result.status, "succeeded");
  assert.equal(result.choice, "implementation");
  assert.equal(JSON.stringify(result).includes("test-key"), false);
  assert.equal(requestBody({ title: "x".repeat(500), goal: "y".repeat(2000) }).state.goal.length, 1000);
});

test("HTTP failure, invalid JSON, malformed distribution and oversized body are bounded failures", async () => {
  const invalid = answer(); invalid.answers.task_class.probabilities.implementation = 0.3;
  for (const [response, expected] of [
    [new Response("secret upstream body", { status: 429 }), "http_429"],
    [new Response("invalid private response"), "request_failed"],
    [Response.json(invalid), "invalid_response"],
    [new Response("x".repeat(40000)), "response_too_large"],
  ]) {
    const result = await evaluate(event, { apiKey: "key", fetchImpl: async () => response });
    assert.equal(result.status, "failed"); assert.equal(result.error, expected);
  }
});

test("timeout aborts request and ignores late response", async () => {
  let complete, signal;
  const result = await evaluate(event, { timeoutMs: 10, apiKey: "key", fetchImpl: (_, options) => {
    signal = options.signal;
    return new Promise(resolve => { complete = resolve; });
  } });
  assert.equal(result.error, "timeout"); assert.equal(signal.aborted, true);
  complete(Response.json(answer()));
});

test("disabled, missing key and other workspace never invoke API", async () => {
  let calls = 0;
  for (const options of [{ enabled: false }, { apiKey: "" }, { workspace: "/other" }]) {
    const advise = createAdvisor({ enabled: true, apiKey: "key", workspace: "/project", record: async () => {}, fetchImpl: async () => { calls++; return okFetch(); }, ...options });
    await advise(event);
  }
  assert.equal(calls, 0);
});

test("suspected credentials, invalid credentials, and rate limits never block task creation", async () => {
  const records = []; let calls = 0;
  const secret = createAdvisor({ enabled: true, apiKey: "key", workspace: "/project", record: async row => records.push(row), fetchImpl: async () => { calls++; return okFetch(); } });
  await secret({ ...event, task_id: "secret", title: "处理 token=abcdefghijklmnopqrstuvwxyz" });
  assert.equal(calls, 0); assert.equal(records.at(-1).reason, "suspected_secret");

  const auth = createAdvisor({ enabled: true, apiKey: "key", workspace: "/project", record: async row => records.push(row), fetchImpl: async () => { calls++; return new Response("", { status: 401 }); } });
  await auth({ ...event, task_id: "unauthorized" }); await auth({ ...event, task_id: "after-unauthorized" });
  assert.equal(calls, 1); assert.equal(records.at(-1).reason, "auth_failed");

  const throttled = createAdvisor({ enabled: true, apiKey: "key", workspace: "/project", record: async row => records.push(row), fetchImpl: async () => { calls++; return new Response("", { status: 429 }); } });
  await throttled({ ...event, task_id: "throttled" }); await throttled({ ...event, task_id: "after-throttled" });
  assert.equal(calls, 2); assert.equal(records.at(-1).reason, "cooldown");
});

test("dedupe, no queue while busy, cap requests, capture actual classification without sending it", async () => {
  const records = []; let release, calls = 0;
  const advise = createAdvisor({ enabled: true, apiKey: "key", workspace: "/project", maxRequests: 1,
    record: async record => records.push(record), fetchImpl: () => { calls++; return new Promise(resolve => { release = resolve; }); },
  });
  const first = advise(event);
  await advise(event);
  await advise({ ...event, task_id: "task-2" });
  assert.equal(records[0].reason, "busy");
  release(Response.json(answer())); await first;
  await advise({ ...event, task_id: "task-3" });
  assert.equal(records.at(-1).reason, "request_limit");
  await advise({ type: "routing.decision", task_id: event.task_id, task_class: "mechanical" });
  assert.equal(records.at(-1).task_class, "mechanical");
  const count = records.length;
  await advise({ type: "routing.decision", task_id: "unrelated", task_class: "security" });
  assert.equal(records.length, count); assert.equal(calls, 1);
});

test("failed request frees the slot, audit failure is observable", async () => {
  let calls = 0; const records = [];
  const advise = createAdvisor({ enabled: true, apiKey: "key", workspace: "/project", record: async row => records.push(row), fetchImpl: async () => { calls++; throw new Error("private-key-should-not-be-logged"); } });
  await advise(event); await advise({ ...event, task_id: "next" });
  assert.equal(calls, 2); assert.equal(records[0].error, "request_failed");
  const broken = createAdvisor({ enabled: true, apiKey: "key", workspace: "/project", record: async () => { throw new Error("disk full"); }, fetchImpl: okFetch });
  await assert.rejects(broken(event), /disk full/);
});

test("tail skips history, handles split UTF8 and partial lines, ignores malformed input", async (t) => {
  const path = join(await temp(t), "tasks.jsonl"); const received = [];
  await writeFile(path, JSON.stringify({ ...event, task_id: "historical" }) + "\n");
  const tick = await createTail(path, value => received.push(value));
  await tick(); assert.equal(received.length, 0);
  const bytes = Buffer.from(JSON.stringify(event) + "\n");
  const split = bytes.indexOf(Buffer.from("修")) + 1;
  await appendFile(path, bytes.subarray(0, split)); await tick(); assert.equal(received.length, 0);
  await appendFile(path, bytes.subarray(split)); await tick(); assert.deepEqual(received, [event]);
  await appendFile(path, "broken\nnull\n" + JSON.stringify({ ...event, task_id: "next" }) + "\n");
  await tick(); assert.equal(received.at(-1).task_id, "next");
});

test("tail drops oversized records and does not replay replacement/truncated files", async (t) => {
  const path = join(await temp(t), "tasks.jsonl"); const received = [];
  await writeFile(path, ""); const tick = await createTail(path, value => received.push(value));
  await appendFile(path, "x".repeat(1200000) + "\n" + JSON.stringify(event) + "\n");
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(received.length, 1);
  await rename(path, `${path}.old`); await writeFile(path, JSON.stringify(event) + "\n");
  await tick(); assert.equal(received.length, 1);
  await writeFile(path, ""); await tick();
  await appendFile(path, JSON.stringify(event) + "\n"); await tick(); assert.equal(received.length, 2);
});

test("file observation continues while model request is pending", async (t) => {
  const path = join(await temp(t), "tasks.jsonl"); await writeFile(path, "");
  let release; const records = [], pending = [];
  const advise = createAdvisor({ workspace: "/project", enabled: true, apiKey: "key", record: async row => records.push(row), fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const tick = await createTail(path, value => pending.push(advise(value)));
  await appendFile(path, JSON.stringify(event) + "\n" + JSON.stringify({ ...event, task_id: "task-2" }) + "\n");
  await tick(); assert.equal(records[0].reason, "busy");
  release(Response.json(answer())); await Promise.all(pending);
  assert.equal(records.at(-1).status, "succeeded");
});

test("audit is private, serial, and rotates bounded logs", async (t) => {
  const path = join(await temp(t), "events.jsonl");
  await writeFile(path, "x".repeat(5 * 1024 * 1024 + 1), { mode: 0o644 });
  const record = auditWriter(path);
  await Promise.all([record({ status: "one" }), record({ status: "two" })]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(`${path}.1`)).size, 5 * 1024 * 1024 + 1);
  assert.deepEqual((await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line).status), ["one", "two"]);
});
