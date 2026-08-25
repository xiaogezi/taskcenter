import assert from "node:assert/strict";
import test from "node:test";

import { cutoverWithRollback, verifyBeforeServiceCutover } from "../scripts/service-deployment-policy.mjs";

const original = { pid: 42, token: "original" };

test("部署前验证全部通过后才允许进入切换阶段", async () => {
  const stages = [];
  await verifyBeforeServiceCutover({
    original,
    revision: "abc123",
    stages: ["lint", "test"],
    runStage: async (stage) => { stages.push(stage); },
    assertOriginalService: async (service, stage) => {
      assert.equal(service, original);
      stages.push(`healthy:${stage}`);
    },
    readRevision: async () => "abc123",
    readStatus: async () => "",
  });
  assert.deepEqual(stages, ["lint", "healthy:lint", "test", "healthy:test"]);
});

test("工作区不干净时不运行任何部署验证", async () => {
  let ran = false;
  await assert.rejects(() => verifyBeforeServiceCutover({
    original,
    revision: "abc123",
    stages: ["lint", "test"],
    runStage: async () => { ran = true; },
    assertOriginalService: async () => {},
    readRevision: async () => "abc123",
    readStatus: async () => " M scripts/taskcenter-control.mjs",
  }), /工作区存在未提交改动/);
  assert.equal(ran, false);
});

test("验证命令失败时立即中止且不运行后续阶段", async () => {
  const stages = [];
  await assert.rejects(() => verifyBeforeServiceCutover({
    original,
    revision: "abc123",
    stages: ["lint", "test"],
    runStage: async (stage) => {
      stages.push(stage);
      if (stage === "lint") throw new Error("lint failed");
    },
    assertOriginalService: async () => {},
    readRevision: async () => "abc123",
    readStatus: async () => "",
  }), /lint failed/);
  assert.deepEqual(stages, ["lint"]);
});

test("验证期间原服务变化或 revision 变化时禁止切换", async () => {
  await assert.rejects(() => verifyBeforeServiceCutover({
    original,
    revision: "abc123",
    stages: ["lint"],
    runStage: async () => {},
    assertOriginalService: async () => { throw new Error("original changed"); },
    readRevision: async () => "abc123",
    readStatus: async () => "",
  }), /original changed/);

  let reads = 0;
  await assert.rejects(() => verifyBeforeServiceCutover({
    original,
    revision: "abc123",
    stages: ["lint"],
    runStage: async () => {},
    assertOriginalService: async () => {},
    readRevision: async () => (++reads === 1 ? "abc123" : "def456"),
    readStatus: async () => "",
  }), /Git revision 已变化/);
});

test("新版本稳定端口健康后完成切换", async () => {
  const calls = [];
  const result = await cutoverWithRollback({
    stopOriginal: async () => { calls.push("stop-original"); },
    startCandidate: async () => { calls.push("start-candidate"); },
    assertCandidateHealthy: async () => { calls.push("healthy-candidate"); },
    restoreOriginal: async () => { calls.push("restore-original"); },
  });
  assert.deepEqual(result, { outcome: "succeeded", rollback: false });
  assert.deepEqual(calls, ["stop-original", "start-candidate", "healthy-candidate"]);
});

test("新版本启动失败时自动恢复上一版本", async () => {
  const calls = [];
  await assert.rejects(() => cutoverWithRollback({
    stopOriginal: async () => { calls.push("stop-original"); },
    startCandidate: async () => { calls.push("start-candidate"); throw new Error("boot failed"); },
    assertCandidateHealthy: async () => { calls.push("healthy-candidate"); },
    restoreOriginal: async () => { calls.push("restore-original"); },
  }), (error) => error.code === "TASKCENTER_RELEASE_ROLLED_BACK" && /已恢复上一版本/.test(error.message));
  assert.deepEqual(calls, ["stop-original", "start-candidate", "restore-original"]);
});

test("新旧版本都启动失败时报告双重故障", async () => {
  await assert.rejects(() => cutoverWithRollback({
    stopOriginal: async () => {},
    startCandidate: async () => { throw new Error("new failed"); },
    assertCandidateHealthy: async () => {},
    restoreOriginal: async () => { throw new Error("old failed"); },
  }), (error) => error instanceof AggregateError && /新版本启动失败且旧版本恢复失败/.test(error.message));
});
