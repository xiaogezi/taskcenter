import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, appendFile, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestForEvent, requestBody, evaluate, createAdvisor, createTail, auditWriter } from "../scripts/jev-advisor.mjs";

const create = { type: "task.create", task_id: "task-1", event_id: "create-1", workspace: "/project", title: "修复按钮", goal: "修复已定位的点击事件问题", acceptance_criteria: [{ description: "点击可用" }], session_id: "private-session", evidence: ["private-code"] };
const checkpoint = { type: "task.update", task_id: "task-1", event_id: "checkpoint-1", workspace: "/project", current_step: "运行定向测试", next_action: "检查失败输出", risks: ["未知环境"] };
const report = { type: "task.report", task_id: "task-1", event_id: "report-1", workspace: "/project", status: "done_claimed", tests: ["node --test"], evidence: ["local:test"], changed_files: ["a.mjs"] };

function answerFor(request) {
  const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    if (question.type === "noul") return [id, { type: "noul", noul: 0.1 }];
    const choice = id === "task_class" ? "implementation" : "continue";
    return [id, { type: "choice", choice, confidence: 0.9, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])) }];
  }));
  return { model: "jev-1.13.0", answers, usage: { input_tokens: 200, output_tokens: 20 } };
}

const request = requestForEvent(create);
const okFetch = async (_url, options) => Response.json(answerFor(JSON.parse(options.body)));
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), "jev-pilot-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("four lines use only their approved structured summaries", () => {
  assert.deepEqual(request.lineNames, ["classification"]);
  assert.deepEqual(request.state, { title: create.title, goal: create.goal, requirements: ["点击可用"] });
  const continuation = requestForEvent(checkpoint, { title: create.title, goal: create.goal, requirements: ["点击可用"] });
  assert.deepEqual(continuation.lineNames, ["continuation", "risk"]);
  assert.equal(Object.hasOwn(continuation.state, "evidence"), false);
  assert.equal(Object.keys(continuation.questions).length, 8);
  const output = requestForEvent(report, { title: create.title, goal: create.goal, requirements: ["点击可用"] });
  assert.deepEqual(output.lineNames, ["output"]);
  assert.deepEqual(output.state.delivery, { status: "done_claimed", test_count: 1, evidence_reference_count: 1, changed_file_count: 1 });
});

test("fixed HTTPS request accepts typed Choice and Noul answers", async () => {
  const result = await evaluate(request, { apiKey: "test-key", fetchImpl: async (url, options) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone"); assert.equal(options.redirect, "error");
    assert.deepEqual(JSON.parse(options.body), requestBody(request)); assert.equal(options.headers.Authorization, "Bearer test-key");
    return Response.json(answerFor(request));
  } });
  assert.equal(result.status, "succeeded"); assert.equal(result.answers.task_class.choice, "implementation");
  const continuation = requestForEvent(checkpoint, { title: create.title, goal: create.goal, requirements: [] });
  const continuationResult = await evaluate(continuation, { apiKey: "key", fetchImpl: async () => Response.json(answerFor(continuation)) });
  assert.equal(continuationResult.answers.new_evidence.type, "noul");
});

test("HTTP failure, invalid JSON, malformed answer and oversized body are bounded failures", async () => {
  const invalid = answerFor(request); invalid.answers.task_class.probabilities.implementation = 0.3;
  for (const [response, expected] of [[new Response("secret upstream body", { status: 429 }), "http_429"], [new Response("invalid private response"), "request_failed"], [Response.json(invalid), "invalid_response"], [new Response("x".repeat(40000)), "response_too_large"]]) {
    const result = await evaluate(request, { apiKey: "key", fetchImpl: async () => response });
    assert.equal(result.status, "failed"); assert.equal(result.error, expected);
  }
});

test("timeout aborts request and ignores late response", async () => {
  let complete, signal;
  const result = await evaluate(request, { timeoutMs: 10, apiKey: "key", fetchImpl: (_url, options) => { signal = options.signal; return new Promise(resolve => { complete = resolve; }); } });
  assert.equal(result.error, "timeout"); assert.equal(signal.aborted, true); complete(Response.json(answerFor(request)));
});

test("disabled, missing key and other workspace never invoke API", async () => {
  let calls = 0;
  for (const options of [{ enabled: false }, { apiKey: "" }, { workspace: "/other" }]) {
    const advise = createAdvisor({ enabled: true, apiKey: "key", workspace: "/project", record: async () => {}, fetchImpl: async () => { calls++; return okFetch(); }, ...options }); await advise(create);
  }
  assert.equal(calls, 0);
});

test("all four lines are produced from create, checkpoint and report events", async () => {
  const records = []; let calls = 0;
  const advise = createAdvisor({ enabled: true, apiKey: "key", workspace: "/project", record: async row => records.push(row), fetchImpl: async (...args) => { calls++; return okFetch(...args); } });
  await advise(create); await advise(checkpoint); await advise(report);
  assert.equal(calls, 3); assert.deepEqual(records.map(row => row.lines), [["classification"], ["continuation", "risk"], ["output"]]);
  assert.equal(records[1].answers.next_step.choice, "continue"); assert.equal(records[1].answers.production_change.type, "noul"); assert.equal(records[2].answers.unverified_completion.type, "noul");
  await advise({ type: "routing.decision", task_id: create.task_id, task_class: "mechanical", selected_executor_model: "test" }); assert.equal(records.length, 3);
});

test("secrets, invalid credentials and rate limits skip advice without blocking task events", async () => {
  const records = []; let calls = 0;
  const secret = createAdvisor({ enabled: true, apiKey: "key", workspace: "/project", record: async row => records.push(row), fetchImpl: async () => { calls++; return okFetch(); } });
  await secret({ ...create, event_id: "secret", title: "处理 token=abcdefghijklmnopqrstuvwxyz" }); assert.equal(calls, 0); assert.equal(records.at(-1).reason, "suspected_secret");
  const auth = createAdvisor({ enabled: true, apiKey: "key", workspace: "/project", record: async row => records.push(row), fetchImpl: async () => { calls++; return new Response("", { status: 401 }); } });
  await auth({ ...create, event_id: "unauthorized" }); await auth({ ...create, task_id: "next", event_id: "after-unauthorized" }); assert.equal(calls, 1); assert.equal(records.at(-1).reason, "auth_failed");
  const throttled = createAdvisor({ enabled: true, apiKey: "key", workspace: "/project", record: async row => records.push(row), fetchImpl: async () => { calls++; return new Response("", { status: 429 }); } });
  await throttled({ ...create, event_id: "throttled" }); await throttled({ ...create, task_id: "later", event_id: "after-throttled" }); assert.equal(calls, 2); assert.equal(records.at(-1).reason, "cooldown");
});

test("no queue while busy, cap requests, and audit failures remain observable", async () => {
  const records = []; let release, calls = 0;
  const advise = createAdvisor({ enabled: true, apiKey: "key", workspace: "/project", maxRequests: 1, record: async row => records.push(row), fetchImpl: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const first = advise(create); await advise({ ...create, task_id: "task-2", event_id: "busy" }); assert.equal(records[0].reason, "busy"); release(Response.json(answerFor(request))); await first;
  await advise({ ...create, task_id: "task-3", event_id: "capped" }); assert.equal(records.at(-1).reason, "request_limit");
  const broken = createAdvisor({ enabled: true, apiKey: "key", workspace: "/project", record: async () => { throw new Error("disk full"); }, fetchImpl: okFetch }); await assert.rejects(broken(create), /disk full/); assert.equal(calls, 1);
});

test("tail skips history, handles split UTF8 and partial lines, ignores malformed input", async (t) => {
  const path = join(await temp(t), "tasks.jsonl"); const received = [];
  await writeFile(path, JSON.stringify(create) + "\n"); const tick = await createTail(path, value => received.push(value)); await tick(); assert.equal(received.length, 0);
  const bytes = Buffer.from(JSON.stringify(create) + "\n"); const split = bytes.indexOf(Buffer.from("修")) + 1;
  await appendFile(path, bytes.subarray(0, split)); await tick(); assert.equal(received.length, 0); await appendFile(path, bytes.subarray(split)); await tick(); assert.deepEqual(received, [create]);
  await appendFile(path, "broken\nnull\n" + JSON.stringify({ ...create, event_id: "next" }) + "\n"); await tick(); assert.equal(received.at(-1).event_id, "next");
});

test("tail drops oversized records and does not replay replacement/truncated files", async (t) => {
  const path = join(await temp(t), "tasks.jsonl"); const received = [];
  await writeFile(path, ""); const tick = await createTail(path, value => received.push(value)); await appendFile(path, "x".repeat(1200000) + "\n" + JSON.stringify(create) + "\n"); for (let i = 0; i < 6; i++) await tick(); assert.equal(received.length, 1);
  await rename(path, `${path}.old`); await writeFile(path, JSON.stringify(create) + "\n"); await tick(); assert.equal(received.length, 1); await writeFile(path, ""); await tick(); await appendFile(path, JSON.stringify(create) + "\n"); await tick(); assert.equal(received.length, 2);
});

test("file observation continues while model request is pending", async (t) => {
  const path = join(await temp(t), "tasks.jsonl"); await writeFile(path, ""); let release; const records = [], pending = [];
  const advise = createAdvisor({ workspace: "/project", enabled: true, apiKey: "key", record: async row => records.push(row), fetchImpl: () => new Promise(resolve => { release = resolve; }) }); const tick = await createTail(path, value => pending.push(advise(value)));
  await appendFile(path, JSON.stringify(create) + "\n" + JSON.stringify({ ...create, task_id: "task-2", event_id: "busy" }) + "\n"); await tick(); assert.equal(records[0].reason, "busy"); release(Response.json(answerFor(request))); await Promise.all(pending); assert.equal(records.at(-1).status, "succeeded");
});

test("audit is private, serial, and rotates bounded logs", async (t) => {
  const path = join(await temp(t), "events.jsonl"); await writeFile(path, "x".repeat(5 * 1024 * 1024 + 1), { mode: 0o644 }); const record = auditWriter(path); await Promise.all([record({ status: "one" }), record({ status: "two" })]);
  assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal((await stat(`${path}.1`)).size, 5 * 1024 * 1024 + 1); assert.deepEqual((await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line).status), ["one", "two"]);
});
