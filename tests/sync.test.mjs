import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturesDir = join(projectRoot, "tests", "fixtures");

function runSync(env) {
  execFileSync(process.execPath, [join(projectRoot, "scripts", "sync-codex.mjs")], {
    env,
    encoding: "utf8",
  });
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
