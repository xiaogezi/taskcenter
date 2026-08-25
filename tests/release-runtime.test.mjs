import assert from "node:assert/strict";
import test from "node:test";

import { buildReleaseEnvironment, resolveStartupRelease, resolveStopTarget } from "../scripts/release-runtime.mjs";

test("正式 release 从不可变源码运行但继续绑定正式数据目录", () => {
  const environment = buildReleaseEnvironment({
    sourceRoot: "/release/abc",
    runtimeRoot: "/taskcenter/runtime",
    logRoot: "/taskcenter/logs",
    dataRoot: "/taskcenter/data",
    revision: "abc",
    releaseId: "abc",
    webMode: "start",
    webPort: 3000,
    controlPort: 3001,
  }, { controllerRoot: "/taskcenter", baseEnvironment: {} });
  assert.equal(environment.TASKCENTER_SOURCE_ROOT, "/release/abc");
  assert.equal(environment.TASKCENTER_WEB_MODE, "start");
  assert.equal(environment.TASKCENTER_TASK_LEDGER_PATH, "/taskcenter/data/task-ledger.json");
  assert.equal(environment.TASKCENTER_DASHBOARD_PATH, "/taskcenter/data/dashboard.json");
});

test("候选 release 隔离 Codex、账本、runtime、端口并强制 dry-run", () => {
  const environment = buildReleaseEnvironment({
    sourceRoot: "/release/def",
    runtimeRoot: "/candidate/runtime",
    logRoot: "/candidate/logs",
    dataRoot: "/candidate/data",
    candidateCodex: "/candidate/codex",
    revision: "def",
    releaseId: "def",
    webMode: "start",
    webPort: 4100,
    controlPort: 4101,
  }, { controllerRoot: "/taskcenter", baseEnvironment: {} });
  assert.equal(environment.CODEX_HOME, "/candidate/codex");
  assert.equal(environment.TASKCENTER_SESSIONS_ROOT, "/candidate/codex/sessions");
  assert.equal(environment.TASKCENTER_TASK_LEDGER_PATH, "/candidate/data/task-ledger.json");
  assert.equal(environment.TASKCENTER_RUNTIME_DIR, "/candidate/runtime");
  assert.equal(environment.TASKCENTER_CONTROL_URL, "http://127.0.0.1:4101");
  assert.equal(environment.TASKCENTER_DISPATCH_DRY_RUN, "1");
  assert.equal(environment.TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION, "1");
});

test("缺少 active release 时正式启动进入 bootstrap 而不是开发模式", () => {
  assert.deepEqual(resolveStartupRelease(null, { projectRoot: "/taskcenter" }), { mode: "bootstrap", release: null });
  const testOnly = resolveStartupRelease(null, { projectRoot: "/taskcenter", allowLegacyDev: true });
  assert.equal(testOnly.mode, "legacy_test_only");
  assert.equal(testOnly.release.webMode, "dev");
});

test("候选停止使用持久化 PID 和 token，不依赖 heartbeat 新鲜度", () => {
  const state = { pid: 42, token: "candidate", startedAt: "2026-08-25T00:00:00.000Z" };
  assert.equal(resolveStopTarget(state), state);
  assert.equal(resolveStopTarget({ pid: 42, token: "" }), null);
  assert.equal(resolveStopTarget({ pid: 0, token: "candidate" }), null);
});
