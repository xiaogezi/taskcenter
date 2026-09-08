import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturesDir = join(projectRoot, "tests", "fixtures");

function runSync(env) {
  execFileSync(process.execPath, [join(projectRoot, "scripts", "sync-codex.mjs")], {
    env,
    encoding: "utf8",
  });
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("等待 Watcher 同步超时");
}

test("sync 只读取白名单 Session 且保留仓库内审核需求", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "taskcenter-sync-test-"));
  const dashboardPath = join(tempDir, "nested", "dashboard.json");

  try {
    runSync({
      ...process.env,
      CODEX_HOME: fixturesDir,
      TASKCENTER_SEED_PATH: join(fixturesDir, "requirements.seed.json"),
      TASKCENTER_SELECTION_PATH: join(fixturesDir, "session-selection-all.json"),
      TASKCENTER_DASHBOARD_PATH: dashboardPath,
    });

    const dashboard = JSON.parse(readFileSync(dashboardPath, "utf8"));

    assert.equal(dashboard.requirements.length, 8, "白名单不应隐藏仓库内已审核的 seed 需求");

    // Check specific items exist
    const ids = dashboard.requirements.map((r) => r.id);
    assert.ok(ids.includes("req-test-1"), "应包含 req-test-1");
    assert.ok(ids.includes("req-test-2"), "应包含 req-test-2");
    assert.ok(ids.includes("req-test-3"), "应保留没有会话来源的已审核 req-test-3");
    assert.ok(ids.includes("example-platform-governance"), "应保留仓库内的示例 Epic");
    assert.equal(dashboard.requirements.find((item) => item.id === "req-test-3").sources.length, 0);

    // Check thread count
    assert.equal(dashboard.source.threadCount, 1, "应识别 1 个会话");

    // Check mode
    assert.equal(dashboard.source.sessionSelection.mode, "allowlist");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sync 将旧 selected 配置安全迁移为白名单", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "taskcenter-sync-test-"));
  const dashboardPath = join(tempDir, "dashboard.json");

  try {
    runSync({
      ...process.env,
      CODEX_HOME: fixturesDir,
      TASKCENTER_SEED_PATH: join(fixturesDir, "requirements.seed.json"),
      TASKCENTER_SELECTION_PATH: join(fixturesDir, "session-selection-selected.json"),
      TASKCENTER_DASHBOARD_PATH: dashboardPath,
    });

    const dashboard = JSON.parse(readFileSync(dashboardPath, "utf8"));

    // In selected mode:
    // - req-test-1 has keyword "alpha", matches session → sources.length > 0 → included
    // - req-test-2 has keyword "beta", matches session → sources.length > 0 → included
    // - req-test-3 has nonexistent keyword → no match → filtered out
    // - 中性示例 fixture items have empty keywords → no match → filtered out
    assert.equal(dashboard.requirements.length, 8, "旧 selected 迁移后仍保留已审核 seed 需求");

    const ids = dashboard.requirements.map((r) => r.id);
    assert.ok(ids.includes("req-test-1"), "应包含有来源的 req-test-1");
    assert.ok(ids.includes("req-test-2"), "应包含有来源的 req-test-2");
    assert.ok(ids.includes("req-test-3"), "应保留无来源的已审核 req-test-3");
    assert.ok(ids.includes("example-platform-governance"), "应保留无关键词的示例 Epic");

    assert.equal(dashboard.source.sessionSelection.mode, "allowlist");
    assert.equal(dashboard.source.sessionSelection.migratedFrom, "selected");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("关键词匹配正确识别会话中的需求", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "taskcenter-sync-test-"));
  const dashboardPath = join(tempDir, "dashboard.json");

  try {
    runSync({
      ...process.env,
      CODEX_HOME: fixturesDir,
      TASKCENTER_SEED_PATH: join(fixturesDir, "requirements.seed.json"),
      TASKCENTER_SELECTION_PATH: join(fixturesDir, "session-selection-selected.json"),
      TASKCENTER_DASHBOARD_PATH: dashboardPath,
    });

    const dashboard = JSON.parse(readFileSync(dashboardPath, "utf8"));

    const req1 = dashboard.requirements.find((r) => r.id === "req-test-1");
    const req2 = dashboard.requirements.find((r) => r.id === "req-test-2");

    // req-test-1 has keyword "alpha", should match "实现 alpha 功能"
    assert.ok(req1.sources.length > 0, "req-test-1 应有来源");
    assert.ok(req1.sources.some((s) => s.excerpt.toLowerCase().includes("alpha")), "来源应包含 alpha");

    // req-test-2 has keyword "beta", should match "完成 beta 功能"
    assert.ok(req2.sources.length > 0, "req-test-2 应有来源");
    assert.ok(req2.sources.some((s) => s.excerpt.toLowerCase().includes("beta")), "来源应包含 beta");

    // Check claimedDone for req-test-2 (session has "已完成 beta")
    assert.equal(req2.claimedDone, true, "req-test-2 应标记为 claimedDone");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("缺少白名单配置时不解析任何 Session 正文", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "taskcenter-sync-test-"));
  const dashboardPath = join(tempDir, "dashboard.json");

  try {
    runSync({
      ...process.env,
      CODEX_HOME: fixturesDir,
      TASKCENTER_SEED_PATH: join(fixturesDir, "requirements.seed.json"),
      TASKCENTER_SELECTION_PATH: join(tempDir, "missing-allowlist.json"),
      TASKCENTER_DASHBOARD_PATH: dashboardPath,
    });

    const dashboard = JSON.parse(readFileSync(dashboardPath, "utf8"));
    assert.equal(dashboard.source.threadCount, 0);
    assert.equal(dashboard.source.messageCount, 0);
    assert.equal(dashboard.source.availableThreadCount, 1);
    assert.equal(dashboard.requirements.length, 8);
    assert.ok(dashboard.requirements.every((requirement) => requirement.sources.length === 0));
    assert.equal(dashboard.source.availableThreads[0].allowed, false);
    assert.equal(dashboard.source.availableThreads[0].cwd, undefined);
    assert.equal(dashboard.source.availableThreads[0].requirementCount, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sync 按 canonical Session 聚合子 Agent，标题只来自 session_index", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "taskcenter-canonical-session-test-"));
  const codexHome = join(tempDir, "codex");
  const sessionsDir = join(codexHome, "sessions", "2026", "08", "20");
  const dashboardPath = join(tempDir, "dashboard.json");
  const parentSessionId = "019ffae8-80bf-7aa2-88ab-8746b37d7b6f";
  const indexOnlySessionId = "019ffae8-80bf-7aa2-88ab-8746b37d7b70";
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(codexHome, "session_index.jsonl"), [
    JSON.stringify({ id: parentSessionId, thread_name: "实现首页三分区" }),
    JSON.stringify({ id: indexOnlySessionId, thread_name: "排查新任务未记录问题" }),
  ].join("\n"));
  writeFileSync(join(codexHome, "selection.json"), `${JSON.stringify({ version: 1, mode: "allowlist", threadIds: [parentSessionId] })}\n`);
  writeFileSync(join(sessionsDir, "rollout-root-01a01ee5-b7e8-7543-97cf-07f32c0724b6.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { session_id: parentSessionId, id: "01a01ee5-b7e8-7543-97cf-07f32c0724b6", cwd: "/work/CyberRole", thread_source: "root" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "实现首页三分区" }, timestamp: "2026-08-20T10:00:00Z" }),
  ].join("\n"));
  writeFileSync(join(sessionsDir, "rollout-root-01a01ee5-b7e8-7543-97cf-07f32c0724b7.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { session_id: parentSessionId, id: "01a01ee5-b7e8-7543-97cf-07f32c0724b7", cwd: "/work/CyberRole", thread_source: "root" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "补充首页 Stories" }, timestamp: "2026-08-20T10:05:00Z" }),
  ].join("\n"));
  writeFileSync(join(sessionsDir, "rollout-review-01a01ee6-ad17-7500-8fe4-980d5e948c3e.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { session_id: "01a01ee6-ad17-7500-8fe4-980d5e948c3e", id: "01a01ee6-ad17-7500-8fe4-980d5e948c3e", parent_thread_id: parentSessionId, cwd: "/work/CyberRole", thread_source: "subagent", agent_role: "ocr_reviewer" } })}\n`);

  try {
    runSync({
      ...process.env,
      CODEX_HOME: codexHome,
      TASKCENTER_SEED_PATH: join(fixturesDir, "requirements.seed.json"),
      TASKCENTER_SELECTION_PATH: join(codexHome, "selection.json"),
      TASKCENTER_DASHBOARD_PATH: dashboardPath,
    });
    const dashboard = JSON.parse(readFileSync(dashboardPath, "utf8"));
    assert.equal(dashboard.source.availableThreadCount, 1);
    assert.deepEqual(dashboard.source.availableThreads.map((thread) => thread.id), [parentSessionId]);
    assert.equal(dashboard.source.availableThreads[0].title, "实现首页三分区");
    assert.deepEqual(dashboard.source.sessionTitles.find((thread) => thread.id === indexOnlySessionId), { id: indexOnlySessionId, title: "排查新任务未记录问题" });
    assert.equal(dashboard.source.availableThreads.some((thread) => thread.id === indexOnlySessionId), false, "仅有索引标题的会话不能扩大正文读取范围");
    assert.equal(dashboard.threads[0].title, "实现首页三分区");
    assert.equal(dashboard.source.messageCount, 2, "同一 canonical Session 的多个 root rollout 都应纳入且不重复");
    assert.equal(dashboard.source.availableThreads.some((thread) => thread.id.startsWith("01a01ee")), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sync 缺少权威标题时使用安全的项目元数据标题，不泄漏任务或 rollout ID", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "taskcenter-missing-title-test-"));
  const codexHome = join(tempDir, "codex");
  const sessionsDir = join(codexHome, "sessions");
  const dashboardPath = join(tempDir, "dashboard.json");
  const parentSessionId = "019ffae8-80bf-7aa2-88ab-8746b37d7b6f";
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(codexHome, "session_index.jsonl"), "");
  writeFileSync(join(codexHome, "selection.json"), `${JSON.stringify({ version: 1, mode: "allowlist", threadIds: [parentSessionId] })}\n`);
  writeFileSync(join(sessionsDir, "rollout-review-01a01ee6-ad17-7500-8fe4-980d5e948c3e.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { session_id: parentSessionId, id: "01a01ee6-ad17-7500-8fe4-980d5e948c3e", parent_thread_id: parentSessionId, thread_source: "subagent", cwd: "/work/ReqRadar" } })}\n`);

  try {
    runSync({
      ...process.env,
      CODEX_HOME: codexHome,
      TASKCENTER_SEED_PATH: join(fixturesDir, "requirements.seed.json"),
      TASKCENTER_SELECTION_PATH: join(codexHome, "selection.json"),
      TASKCENTER_DASHBOARD_PATH: dashboardPath,
    });
    const dashboard = JSON.parse(readFileSync(dashboardPath, "utf8"));
    assert.equal(dashboard.source.availableThreads[0].title, "ReqRadar · 019ffae8…");
    assert.doesNotMatch(dashboard.source.availableThreads[0].title, /cyberrole-home-sections|01a01ee6/);
    assert.equal(dashboard.threads[0].userRequirements, undefined);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Watcher 监听 session_index，Codex 补齐标题后自动纠正显示", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "taskcenter-title-watcher-test-"));
  const codexHome = join(tempDir, "codex");
  const sessionsDir = join(codexHome, "sessions");
  const dashboardPath = join(tempDir, "dashboard.json");
  const selectionPath = join(codexHome, "selection.json");
  const indexPath = join(codexHome, "session_index.jsonl");
  const parentSessionId = "019ffae8-80bf-7aa2-88ab-8746b37d7b6f";
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(indexPath, "");
  writeFileSync(selectionPath, `${JSON.stringify({ version: 1, mode: "allowlist", threadIds: [parentSessionId] })}\n`);
  writeFileSync(join(sessionsDir, "rollout-root-01a01ee5-b7e8-7543-97cf-07f32c0724b6.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { session_id: parentSessionId, id: "01a01ee5-b7e8-7543-97cf-07f32c0724b6", thread_source: "root" } })}\n`);
  const child = spawn(process.execPath, [join(projectRoot, "scripts", "watch-codex.mjs")], {
    cwd: projectRoot,
    stdio: "ignore",
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      TASKCENTER_SEED_PATH: join(fixturesDir, "requirements.seed.json"),
      TASKCENTER_SELECTION_PATH: selectionPath,
      TASKCENTER_DASHBOARD_PATH: dashboardPath,
      TASKCENTER_WATCHER_HEARTBEAT_PATH: join(tempDir, "watcher-heartbeat.json"),
      TASKCENTER_THREADS: parentSessionId,
      TASKCENTER_POLL_INTERVAL_MS: "20",
      TASKCENTER_QUIET_PERIOD_MS: "20",
    },
  });
  try {
    await waitFor(() => dashboardTitle(dashboardPath) === "Codex 会话 · 019ffae8…");
    writeFileSync(indexPath, `${JSON.stringify({ id: parentSessionId, thread_name: "实现首页三分区" })}\n`);
    await waitFor(() => dashboardTitle(dashboardPath) === "实现首页三分区");
  } finally {
    child.kill("SIGTERM");
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function dashboardTitle(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8")).source.availableThreads[0]?.title || "";
  } catch {
    return "";
  }
}
