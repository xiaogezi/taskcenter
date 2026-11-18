import assert from "node:assert/strict";
import test from "node:test";

import { assertExpectedServiceIdentity, restoreOwnedCandidate, cutoverWithRollback, deploymentFailureDetails, verifyBeforeServiceCutover, verifyOriginalServiceWithRetries } from "../scripts/service-deployment-policy.mjs";

const original = { pid: 42, token: "original" };

test("原服务短暂探测失败后须连续健康，身份变化立即中止", async () => {
  const results = [false, true, false, true, true];
  let reads = 0;
  await verifyOriginalServiceWithRetries(async () => ({ identityMatches: true, healthy: results[reads++] }), { delay: async () => {} });
  assert.equal(reads, 5);

  reads = 0;
  await assert.rejects(() => verifyOriginalServiceWithRetries(async () => {
    reads += 1;
    return reads === 2 ? { identityChanged: true } : { identityMatches: true, healthy: true };
  }, { delay: async () => {} }), /identity changed/);
  assert.equal(reads, 2);
});

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
  assert.deepEqual(stages, ["healthy:preflight", "lint", "healthy:lint", "test", "healthy:test"]);
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


test("原服务预检失败时不开始构建、lint 或测试", async () => {
  const calls = [];
  await assert.rejects(() => verifyBeforeServiceCutover({
    original, revision: "abc123", stages: ["artifact", "lint", "test"],
    runStage: async stage => calls.push(stage),
    assertOriginalService: async (service, stage) => {
      calls.push(stage);
      await verifyOriginalServiceWithRetries(async () => ({ identityChanged: true }));
    },
    readRevision: async () => "abc123", readStatus: async () => "",
  }), error => error.code === "TASKCENTER_RELEASE_IDENTITY_CHANGED");
  assert.deepEqual(calls, ["preflight"]);
});

test("阶段失败保留分类与阶段，不把健康失败误报身份变化", async () => {
  let failure;
  try {
    await verifyBeforeServiceCutover({
      original, revision: "abc123", stages: ["test"],
      runStage: async () => { throw new Error("test failed"); },
      assertOriginalService: async () => {},
      readRevision: async () => "abc123", readStatus: async () => "",
    });
  } catch (error) { failure = error; }
  assert.deepEqual(deploymentFailureDetails(failure), {
    failureCode: "TASKCENTER_RELEASE_STAGE_FAILED", failedStage: "test",
    retryAction: "先修复失败阶段并核对输出，再重新执行完整部署验证。",
  });
  await assert.rejects(() => verifyOriginalServiceWithRetries(
    async () => ({ identityMatches: true, healthy: false }),
    { attempts: 1 },
  ), error => error.code === "TASKCENTER_RELEASE_UNHEALTHY");
  const details = deploymentFailureDetails({ code: "TASKCENTER_RELEASE_IDENTITY_CHANGED", last: { token: "private" } });
  assert.match(details.retryAction, /不要盲目重复构建/);
  assert.ok(!JSON.stringify(details).includes("private"));
});


test("切换前身份变化不能停止替换实例或开始候选/回滚", async () => {
  for (const replacement of [null, { pid: 99, token: "replacement" }, { pid: 42, token: "new-generation" }]) {
    const calls = [];
    await assert.rejects(() => cutoverWithRollback({
      stopOriginal: async () => {
        assertExpectedServiceIdentity(original, replacement);
        calls.push("stop");
      },
      startCandidate: async () => calls.push("start"),
      assertCandidateHealthy: async () => calls.push("health"),
      restoreOriginal: async () => calls.push("rollback"),
    }), error => error.code === "TASKCENTER_RELEASE_IDENTITY_CHANGED");
    assert.deepEqual(calls, []);
  }
  assert.equal(assertExpectedServiceIdentity(original, original), original);
});


test("回滚只停止本次候选，未知或替换实例绝不恢复覆盖", async () => {
  for (const candidate of [undefined, original]) for (const current of [
    { pid: 99, token: "other" }, { pid: 42, token: "new-generation" },
  ]) {
    const calls = [];
    await assert.rejects(() => restoreOwnedCandidate({
      candidate, readCurrent: () => current,
      stopCandidate: async () => calls.push("stop"),
      assertVacant: async () => calls.push("vacant"), restore: async () => calls.push("restore"),
    }), error => error.code === "TASKCENTER_RELEASE_IDENTITY_CHANGED");
    assert.deepEqual(calls, []);
  }
  const calls = [];
  await restoreOwnedCandidate({ candidate: original, readCurrent: () => original,
    stopCandidate: async identity => { assert.equal(identity, original); calls.push("stop-owned"); },
    assertVacant: async identity => { assert.equal(identity, original); calls.push("vacant"); },
    restore: async () => calls.push("restore"),
  });
  assert.deepEqual(calls, ["stop-owned", "vacant", "restore"]);
  let restored = false;
  await assert.rejects(() => restoreOwnedCandidate({ candidate: original, readCurrent: () => null,
    stopCandidate: async () => assert.fail("missing state must not signal"),
    assertVacant: async () => { throw new Error("port occupied or pending launch"); },
    restore: async () => { restored = true; },
  }), /port occupied/);
  assert.equal(restored, false);
});
