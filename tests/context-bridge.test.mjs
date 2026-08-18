import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { parseContextToolResult, resolveContextCommand, syncContextEvent } from "../scripts/context-bridge.mjs";

function bridgeOptions(calls, savedMaps, initialMap = {}) {
  return {
    enabled: true,
    audit: false,
    timeoutMs: 1_000,
    loadMap: () => initialMap,
    saveMap: (value) => savedMaps.push(value),
    callTool: async (name, arguments_) => {
      calls.push({ name, arguments: arguments_ });
      if (name === "context.start_task") return { task_id: "context-created" };
      return { accepted: true };
    },
  };
}

test("Context bridge 优先使用项目自带的 ABI 兼容启动器", async () => {
  const root = await mkdtemp(join(tmpdir(), "taskcenter-context-command-"));
  try {
    const scripts = join(root, "scripts");
    const launcher = join(scripts, "mac-node.sh");
    await mkdir(scripts);
    await writeFile(launcher, "#!/bin/sh\nexec node \"$@\"\n");
    assert.equal(resolveContextCommand({ contextRoot: root, explicitCommand: "", platform: "darwin", assertExecutable: () => {} }), launcher);
    assert.equal(resolveContextCommand({ contextRoot: root, explicitCommand: "/custom/node" }), resolve("/custom/node"));
    assert.equal(resolveContextCommand({ contextRoot: root, explicitCommand: "", platform: "win32" }), process.execPath);
    assert.equal(resolveContextCommand({ contextRoot: root, explicitCommand: "", platform: "darwin", assertExecutable: () => { throw new Error("not executable"); } }), process.execPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Context MCP 成功响应必须是 JSON object", () => {
  assert.throws(
    () => parseContextToolResult({ content: [{ type: "text", text: "not-json" }] }, "context.report_observation"),
    /返回非 JSON 成功响应/,
  );
  assert.throws(
    () => parseContextToolResult({ content: [{ type: "text", text: "null" }] }, "context.complete_task"),
    /不是 JSON object/,
  );
  assert.deepEqual(
    parseContextToolResult({ content: [{ type: "text", text: '{"accepted":true}' }] }, "context.report_observation"),
    { accepted: true },
  );
});

test("Context MCP 非 JSON 错误响应保留原始错误", () => {
  assert.throws(
    () => parseContextToolResult({ isError: true, content: [{ type: "text", text: "IDEMPOTENCY_CONFLICT" }] }, "context.report_observation"),
    /IDEMPOTENCY_CONFLICT/,
  );
});

test("显式 contextTaskId 优先于旧映射且不会新建 Context 任务", async () => {
  const calls = [];
  const savedMaps = [];
  const result = await syncContextEvent(
    { type: "task.report", status: "done_claimed", event_id: "event-done", context_task_id: "context-explicit" },
    {
      id: "taskcenter-task",
      contextTaskId: "context-explicit",
      workspace: "/work",
      title: "正式任务",
      goal: "完成正式任务",
      status: "done_claimed",
      changedFiles: ["a.mjs"],
      tests: ["tests passed"],
    },
    bridgeOptions(calls, savedMaps, {
      "taskcenter-task": { contextTaskId: "context-stale", workspace: "/work" },
    }),
  );

  assert.equal(result.status, "synced");
  assert.equal(result.contextTaskId, "context-explicit");
  assert.deepEqual(calls.map((call) => call.name), ["context.report_observation", "context.complete_task"]);
  assert.ok(calls.every((call) => call.arguments.task_id === "context-explicit"));
  assert.equal(savedMaps.at(-1)["taskcenter-task"].contextTaskId, "context-explicit");
});

test("无显式关联且 bridge 未开启时不会创建 Context 任务", async () => {
  const calls = [];
  const result = await syncContextEvent(
    { type: "task.create", event_id: "event-create" },
    { id: "standalone-task", workspace: "/work", title: "独立任务" },
    {
      enabled: false,
      audit: false,
      callTool: async (...args) => calls.push(args),
    },
  );
  assert.equal(result.status, "disabled");
  assert.deepEqual(calls, []);
});

test("本地逾期提醒不会同步为 ProjectContext 代码证据", async () => {
  const calls = [];
  const result = await syncContextEvent(
    { type: "task.reminder", event_id: "overdue-reminder" },
    { id: "task-overdue", contextTaskId: "context-overdue", workspace: "/work" },
    bridgeOptions(calls, []),
  );
  assert.deepEqual(result, { status: "skipped", reason: "local_overdue_reminder" });
  assert.deepEqual(calls, []);
});

test("模型路由审计不会同步为 ProjectContext 代码证据", async () => {
  const calls = [];
  const result = await syncContextEvent(
    { type: "routing.decision", event_id: "routing-audit" },
    { id: "routing-task", contextTaskId: "context-routing", workspace: "/work" },
    {
      enabled: true,
      audit: false,
      callTool: async (...args) => calls.push(args),
    },
  );
  assert.deepEqual(result, { status: "skipped", reason: "routing_audit" });
  assert.deepEqual(calls, []);
});

test("人工完成 task.update 也会闭环已有 Context 任务", async () => {
  const calls = [];
  const result = await syncContextEvent(
    { type: "task.update", status: "done_claimed", event_id: "manual-done" },
    {
      id: "manual-task",
      contextTaskId: "context-manual",
      workspace: "/work",
      title: "人工完成任务",
      status: "done_claimed",
    },
    bridgeOptions(calls, []),
  );
  assert.equal(result.status, "synced");
  assert.deepEqual(calls.map((call) => call.name), ["context.report_observation", "context.complete_task"]);
});

test("显式 Context 任务同步失败时不会回退并创建新任务", async () => {
  const calls = [];
  const result = await syncContextEvent(
    { type: "task.update", status: "in_progress", event_id: "event-invalid" },
    { id: "invalid-task", contextTaskId: "context-missing", workspace: "/work", title: "无效关联" },
    {
      enabled: true,
      audit: false,
      timeoutMs: 1_000,
      loadMap: () => ({}),
      saveMap: () => {},
      callTool: async (name) => {
        calls.push(name);
        throw new Error("任务不存在");
      },
    },
  );
  assert.equal(result.status, "failed");
  assert.match(result.error, /任务不存在/);
  assert.deepEqual(calls, ["context.report_observation"]);
});

test("同一 TaskCenter event 重投时复用稳定 Context 幂等键完成补偿", async () => {
  const attempts = [];
  let failFirstObservation = true;
  const options = {
    enabled: true,
    audit: false,
    timeoutMs: 1_000,
    loadMap: () => ({}),
    saveMap: () => {},
    callTool: async (name, arguments_) => {
      attempts.push({ name, eventId: arguments_.event_id });
      if (name === "context.report_observation" && failFirstObservation) {
        failFirstObservation = false;
        throw new Error("temporary timeout");
      }
      return { accepted: true };
    },
  };
  const event = { type: "task.report", status: "done_claimed", event_id: "stable-retry" };
  const task = {
    id: "retry-task",
    contextTaskId: "context-retry",
    workspace: "/work",
    title: "补偿重试",
    status: "done_claimed",
  };

  assert.equal((await syncContextEvent(event, task, options)).status, "failed");
  assert.equal((await syncContextEvent(event, task, options)).status, "synced");
  assert.deepEqual(attempts, [
    { name: "context.report_observation", eventId: "reqradar-context-observation-stable-retry" },
    { name: "context.report_observation", eventId: "reqradar-context-observation-stable-retry" },
    { name: "context.complete_task", eventId: "reqradar-context-complete-stable-retry" },
  ]);
});

test("升级补偿保留 ReqRadar observation 的完整幂等请求", async () => {
  const calls = [];
  const savedMaps = [];
  const result = await syncContextEvent(
    { type: "task.update", event_id: "legacy-payload" },
    { id: "task-legacy", contextTaskId: "context-legacy", workspace: "/work", status: "in_progress" },
    bridgeOptions(calls, savedMaps),
  );
  assert.equal(result.status, "synced");
  const observation = calls.find((call) => call.name === "context.report_observation");
  assert.equal(observation.arguments.event_id, "reqradar-context-observation-legacy-payload");
  const content = JSON.parse(observation.arguments.content);
  assert.equal(content.reqradar_task_id, "task-legacy");
  assert.equal("taskcenter_task_id" in content, false);
  assert.equal(savedMaps.length, 1);
});

test("543 observation 已存在时以同一 event_id 回退到旧 payload", async () => {
  const calls = [];
  const options = bridgeOptions(calls, []);
  options.callTool = async (name, arguments_) => {
    calls.push({ name, arguments: arguments_ });
    if (name !== "context.report_observation") return { accepted: true };
    const content = JSON.parse(arguments_.content);
    if (content.reqradar_task_id) {
      const error = new Error("same event id has different arguments");
      error.code = "IDEMPOTENCY_CONFLICT";
      throw error;
    }
    return { accepted: true, idempotent: true };
  };

  const result = await syncContextEvent(
    { type: "task.update", event_id: "from-543" },
    { id: "task-from-543", contextTaskId: "context-from-543", workspace: "/work", status: "in_progress" },
    options,
  );

  assert.equal(result.status, "synced");
  const observations = calls.filter((call) => call.name === "context.report_observation");
  assert.equal(observations.length, 2);
  assert.ok(observations.every((call) => call.arguments.event_id === "reqradar-context-observation-from-543"));
  assert.equal(JSON.parse(observations[0].arguments.content).reqradar_task_id, "task-from-543");
  assert.equal(JSON.parse(observations[1].arguments.content).taskcenter_task_id, "task-from-543");
});
