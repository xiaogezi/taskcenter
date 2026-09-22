import test from "node:test";
import assert from "node:assert/strict";
import { installReleaseDependencies, runDependencyInstall } from "../scripts/release-dependencies.mjs";
import { verifyBeforeServiceCutover } from "../scripts/service-deployment-policy.mjs";

test("热缓存只运行一次离线安装", async () => {
  const calls = [];
  assert.equal(await installReleaseDependencies(async (...args) => calls.push(args)), "offline");
  assert.equal(calls.length, 1);
  assert.ok(calls[0][0].includes("--offline"));
  assert.equal(calls[0][1], 60000);
});

test("冷缓存只回退一次受限网络安装，超时和其他失败不重试", async () => {
  const calls = [];
  assert.equal(await installReleaseDependencies(async (args, timeout) => {
    calls.push({ args, timeout });
    if (calls.length === 1) throw Object.assign(new Error("miss"), { code: "ENOTCACHED" });
  }), "network");
  assert.equal(calls.length, 2);
  assert.ok(calls[1].args.includes("--offline=false"));
  assert.equal(calls[1].timeout, 180000);
  for (const code of ["DEPENDENCY_INSTALL_TIMEOUT", "EINTEGRITY"]) {
    let count = 0;
    await assert.rejects(installReleaseDependencies(async () => {
      count++; throw Object.assign(new Error(code), { code });
    }), { code });
    assert.equal(count, 1);
  }
});

test("真实子进程缺包分类和超时退出", async () => {
  await assert.rejects(runDependencyInstall(process.execPath, ["-e", "console.error('npm error code ENOTCACHED'); process.exit(1)"], process.cwd(), 5000), { code: "ENOTCACHED" });
  await assert.rejects(runDependencyInstall(process.execPath, ["-e", "setInterval(() => {}, 1000)"], process.cwd(), 100), { code: "DEPENDENCY_INSTALL_TIMEOUT" });
});

test("依赖准备失败不执行完整测试或切换", async () => {
  const stages = [];
  await assert.rejects(verifyBeforeServiceCutover({
    original: {}, revision: "same", stages: ["artifact", "lint", "test"],
    readRevision: async () => "same", readStatus: async () => "",
    assertOriginalService: async () => {},
    runStage: async (stage) => { stages.push(stage); throw new Error("dependency unavailable"); },
  }), /dependency unavailable/);
  assert.deepEqual(stages, ["artifact"]);
});
