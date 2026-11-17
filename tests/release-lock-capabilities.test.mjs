import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertReleaseLockCompatibility, readRuntimeCapabilities, REQUIRED_LOCK_PROTOCOL } from "../scripts/release-runtime.mjs";

function fixture(t) {
  const sourceRoot = mkdtempSync(join(tmpdir(), "taskcenter-release-locks-"));
  t.after(() => rmSync(sourceRoot, { recursive: true, force: true }));
  mkdirSync(join(sourceRoot, "config"));
  const capabilities = { launcherMutex: REQUIRED_LOCK_PROTOCOL, reuseMutex: REQUIRED_LOCK_PROTOCOL };
  return { release: { sourceRoot, revision: "new" }, capabilities,
    source: value => writeFileSync(join(sourceRoot, "config/runtime-capabilities.json"), JSON.stringify(value)),
    marker: value => writeFileSync(join(sourceRoot, ".taskcenter-release.json"), JSON.stringify(value)),
  };
}

test("旧版本无能力声明、仅单把锁升级及旧构建标记均拒绝", t => {
  const f = fixture(t);
  assert.throws(() => assertReleaseLockCompatibility(f.release), /LOCK_PROTOCOL_INCOMPATIBLE/);
  f.source({ launcherMutex: REQUIRED_LOCK_PROTOCOL });
  assert.throws(() => readRuntimeCapabilities(f.release.sourceRoot), /LOCK_PROTOCOL_INCOMPATIBLE/);
  f.source(f.capabilities);
  f.marker({ revision: "new" });
  assert.throws(() => assertReleaseLockCompatibility(f.release), /LOCK_PROTOCOL_INCOMPATIBLE/);
});

test("release 来源和构建能力同时匹配才允许启动/回滚，不把控制器能力赋予旧源码", t => {
  const f = fixture(t);
  f.source(f.capabilities);
  f.marker({ revision: "new", runtimeCapabilities: f.capabilities });
  assert.deepEqual(assertReleaseLockCompatibility(f.release), f.capabilities);
  assert.throws(() => assertReleaseLockCompatibility({ ...f.release, revision: "other" }), /LOCK_PROTOCOL_INCOMPATIBLE/);
  f.source({ ...f.capabilities, reuseMutex: "legacy" });
  assert.throws(() => assertReleaseLockCompatibility(f.release), /LOCK_PROTOCOL_INCOMPATIBLE/);
});

test("测试 worktree 可无构建标记，但不能跳过源锁协议能力", t => {
  const f = fixture(t);
  assert.throws(() => assertReleaseLockCompatibility(f.release, { allowWorktree: true }), /LOCK_PROTOCOL_INCOMPATIBLE/);
  f.source(f.capabilities);
  assert.deepEqual(assertReleaseLockCompatibility(f.release, { allowWorktree: true }), f.capabilities);
});
