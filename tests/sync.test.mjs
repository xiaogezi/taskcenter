import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import test from "node:test";

const projectRoot = new URL("..", import.meta.url).pathname;
const fixturesDir = join(projectRoot, "tests", "fixtures");

test("sync 在 all 模式下输出所有种子需求", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "taskcenter-sync-test-"));
  const dashboardPath = join(tempDir, "dashboard.json");

  try {
    execSync(`node ${join(projectRoot, "scripts", "sync-codex.mjs")}`, {
      env: {
        ...process.env,
        CODEX_HOME: fixturesDir,
        TASKCENTER_SEED_PATH: join(fixturesDir, "requirements.seed.json"),
        TASKCENTER_SELECTION_PATH: join(fixturesDir, "session-selection-all.json"),
        TASKCENTER_DASHBOARD_PATH: dashboardPath,
      },
      encoding: "utf8",
    });

    const dashboard = JSON.parse(readFileSync(dashboardPath, "utf8"));

    // 4 seed items, all should appear in "all" mode
    assert.equal(dashboard.requirements.length, 4, "all 模式应包含所有 4 个种子需求");

    // Check specific items exist
    const ids = dashboard.requirements.map((r) => r.id);
    assert.ok(ids.includes("req-test-1"), "应包含 req-test-1");
    assert.ok(ids.includes("req-test-2"), "应包含 req-test-2");
    assert.ok(ids.includes("req-test-3"), "应包含 req-test-3");
    assert.ok(ids.includes("req-atlas-1"), "应包含 req-atlas-1");

    // Check thread count
    assert.equal(dashboard.source.threadCount, 1, "应识别 1 个会话");

    // Check mode
    assert.equal(dashboard.source.sessionSelection.mode, "all");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sync 在 selected 模式下过滤无来源需求", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "taskcenter-sync-test-"));
  const dashboardPath = join(tempDir, "dashboard.json");

  try {
    execSync(`node ${join(projectRoot, "scripts", "sync-codex.mjs")}`, {
      env: {
        ...process.env,
        CODEX_HOME: fixturesDir,
        TASKCENTER_SEED_PATH: join(fixturesDir, "requirements.seed.json"),
        TASKCENTER_SELECTION_PATH: join(fixturesDir, "session-selection-selected.json"),
        TASKCENTER_DASHBOARD_PATH: dashboardPath,
      },
      encoding: "utf8",
    });

    const dashboard = JSON.parse(readFileSync(dashboardPath, "utf8"));

    // In selected mode:
    // - req-test-1 has keyword "alpha", matches session → sources.length > 0 → included
    // - req-test-2 has keyword "beta", matches session → sources.length > 0 → included
    // - req-test-3 has nonexistent keyword → no match → filtered out
    // - req-atlas-1 has empty keywords → no match → filtered out
    assert.equal(dashboard.requirements.length, 2, "selected 模式应过滤无来源需求，仅保留 2 个");

    const ids = dashboard.requirements.map((r) => r.id);
    assert.ok(ids.includes("req-test-1"), "应包含有来源的 req-test-1");
    assert.ok(ids.includes("req-test-2"), "应包含有来源的 req-test-2");
    assert.ok(!ids.includes("req-test-3"), "应过滤无来源的 req-test-3");
    assert.ok(!ids.includes("req-atlas-1"), "应过滤无关键词的 req-atlas-1");

    assert.equal(dashboard.source.sessionSelection.mode, "selected");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("关键词匹配正确识别会话中的需求", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "taskcenter-sync-test-"));
  const dashboardPath = join(tempDir, "dashboard.json");

  try {
    execSync(`node ${join(projectRoot, "scripts", "sync-codex.mjs")}`, {
      env: {
        ...process.env,
        CODEX_HOME: fixturesDir,
        TASKCENTER_SEED_PATH: join(fixturesDir, "requirements.seed.json"),
        TASKCENTER_SELECTION_PATH: join(fixturesDir, "session-selection-selected.json"),
        TASKCENTER_DASHBOARD_PATH: dashboardPath,
      },
      encoding: "utf8",
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
