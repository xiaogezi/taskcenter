import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { ALGORITHM, FORBIDDEN_PACKAGES, buildInputHash, recordBuild, scanTree, compareMetrics, checkArtifacts, verifySavedReport } from "../scripts/artifact-size-budget.mjs";
import { verifyReleaseBudget } from "../scripts/release-dependencies.mjs";
import { verifyBeforeServiceCutover, cutoverWithRollback } from "../scripts/service-deployment-policy.mjs";

const required = ["client_bytes", "client_gzip_bytes", "largest_js_bytes", "server_bytes", "development_dependency_bytes", "production_dependency_bytes", "release_bytes"];
const limit = bytes => ({ baseline_bytes: bytes, warn_bytes: Math.floor(bytes * 1.02), max_bytes: Math.floor(bytes * 1.05) });
const env = { platform: "fixture", arch: "x64", node: "v22.13.0", npm: "10.9.2" };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "artifact-budget-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ["dist/client", "dist/server", "config", "scripts", "node_modules/example"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, "dist/client/a.js"), "console.log('test');");
  writeFileSync(join(root, "dist/server/index.js"), "export default {};");
  writeFileSync(join(root, "node_modules/example/package.json"), '{"name":"example"}');
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/example": { version: "1.0.0" } } }));
  const budgetPath = join(root, "config/artifact-size-budget.json");
  const budget = { algorithm: ALGORITHM, forbidden_packages: FORBIDDEN_PACKAGES, profiles: { "fixture-x64/v22.13.0/10.9.2": { baseline_revision: "fixture", install_strategy: "npm ci; build; npm prune --omit=dev --omit=optional", metrics: Object.fromEntries(required.map(name => [name, limit(100000)])) } } };
  writeFileSync(budgetPath, JSON.stringify(budget));
  const stamp = () => recordBuild(root, buildInputHash(root), "fixture", env);
  stamp();
  return { root, budgetPath, budget, stamp, check: (mode = "build", extra = {}) => checkArtifacts({ root, mode, env, ...extra }) };
}

test("累计固定基线，单指标和 gzip/chunk 超限不能由其他缩小抵消", () => {
  const budgets = Object.fromEntries(required.map(name => [name, limit(100)]));
  const metrics = Object.fromEntries(required.map(name => [name, 100]));
  for (const name of required) {
    const growing = { ...metrics, [name]: 103 };
    assert.equal(compareMetrics(growing, budgets, required).warning, true);
    growing[name] = 106;
    assert.equal(compareMetrics(growing, budgets, required).failed, true);
    assert.equal(budgets[name].baseline_bytes, 100);
  }
  for (let percent = 1; percent <= 10; percent++) assert.equal(compareMetrics({ client_bytes: 100 + percent }, budgets, ["client_bytes"]).failed, percent > 5);
  assert.throws(() => compareMetrics({}, budgets, required), /invalid metric/);
});

test("真实资产包括图片，缺构建/预算/平台/工具链及输入或输出变化失败", t => {
  const f = fixture(t);
  const before = f.check().metrics.client_bytes;
  writeFileSync(join(f.root, "dist/client/image.png"), Buffer.alloc(777)); f.stamp();
  assert.equal(f.check().metrics.client_bytes, before + 777);
  const profile = f.budget.profiles["fixture-x64/v22.13.0/10.9.2"];
  profile.metrics.client_bytes = limit(before);
  writeFileSync(f.budgetPath, JSON.stringify(f.budget));
  assert.equal(f.check().failed, true);
  assert.throws(() => f.check("build", { env: { ...env, arch: "arm64" } }), /environment mismatch/);
  assert.throws(() => f.check("build", { env: { ...env, node: "v22.14.0" } }), /environment mismatch/);
  const noProfile = structuredClone(f.budget); noProfile.profiles = {};
  writeFileSync(f.budgetPath, JSON.stringify(noProfile));
  assert.throws(() => f.check(), /uncalibrated/);
  writeFileSync(f.budgetPath, JSON.stringify(f.budget));
  writeFileSync(join(f.root, "scripts/changed.mjs"), "export {}; ");
  assert.throws(() => f.check(), /stale build/); f.stamp();
  writeFileSync(join(f.root, "dist/server/index.js"), "modified output");
  assert.throws(() => f.check(), /stale build/); f.stamp();
  assert.throws(() => f.check("build", { expectedRevision: "other" }), /revision mismatch/);
  rmSync(join(f.root, "dist/client"), { recursive: true });
  assert.throws(() => f.check(), /missing client/);
  rmSync(f.budgetPath); assert.throws(() => f.check(), /ENOENT/);
});

test("禁止直接、传递、可选与安装树退休依赖，历史字符串不误报", t => {
  const f = fixture(t), path = join(f.root, "package-lock.json");
  const clean = JSON.parse(readFileSync(path, "utf8"));
  for (const node of ["node_modules/@openai/codex-sdk", "node_modules/indirect/node_modules/@openai/codex", "node_modules/@openai/codex-darwin-arm64", ...FORBIDDEN_PACKAGES.map(name => `node_modules/${name}`), "node_modules/@next/swc-linux-x64-gnu"]) {
    writeFileSync(path, JSON.stringify({ ...clean, packages: { ...clean.packages, [node]: { version: "1", optional: true } } })); f.stamp();
    assert.throws(() => f.check(), /forbidden lockfile/);
  }
  writeFileSync(path, JSON.stringify(clean)); f.stamp();
  writeFileSync(join(f.root, "history.md"), "@openai/codex-sdk was removed");
  assert.equal(f.check().failed, false);
  writeFileSync(join(f.root, "node_modules/example/package.json"), '{"name":"@openai/codex-sdk"}');
  assert.throws(() => f.check(), /forbidden installed/);
  writeFileSync(join(f.root, "node_modules/example/package.json"), '{"name":"example"}');
  writeFileSync(join(f.root, "package.json"), JSON.stringify({ devDependencies: { next: "1" } })); f.stamp();
  assert.throws(() => f.check(), /forbidden manifest/);
});

test("完整开发依赖预算阻断累计增长、缺失指标，缓存不充当依赖", t => {
  const f = fixture(t), baseline = f.check().metrics.development_dependency_bytes;
  const profile = f.budget.profiles["fixture-x64/v22.13.0/10.9.2"];
  profile.metrics.development_dependency_bytes = limit(baseline);
  writeFileSync(f.budgetPath, JSON.stringify(f.budget));
  mkdirSync(join(f.root, "node_modules/.vite"));
  writeFileSync(join(f.root, "node_modules/.vite/cache.js"), Buffer.alloc(10000));
  assert.equal(f.check().metrics.development_dependency_bytes, baseline);
  writeFileSync(join(f.root, "node_modules/example/growing.js"), Buffer.alloc(100));
  assert.equal(f.check().failed, true);
  delete profile.metrics.development_dependency_bytes;
  writeFileSync(f.budgetPath, JSON.stringify(f.budget));
  assert.throws(() => f.check(), /invalid metric\/budget: development_dependency_bytes/);
});

test("production 拒绝开发/可选依赖；复用报告重测目录，不改预算或 active release", t => {
  const f = fixture(t), before = readFileSync(f.budgetPath, "utf8");
  const current = f.check("release"); assert.equal(current.failed, false);
  verifySavedReport(structuredClone(current), current);
  const outdated = structuredClone(current); outdated.config_hash = "old";
  assert.throws(() => verifySavedReport(outdated, current), /stale report/);
  const options = { sourceRoot: f.root, revision: "fixture", budgetPath: f.budgetPath, env };
  assert.throws(() => verifyReleaseBudget({ ...options, activeSourceRoot: f.root }), /cannot modify active/);
  assert.throws(() => verifyReleaseBudget({ ...options, reuse: true }), /report missing/);
  verifyReleaseBudget(options);
  verifyReleaseBudget({ ...options, reuse: true });
  writeFileSync(join(f.root, "dist/client/a.js"), "changed output"); f.stamp();
  assert.throws(() => verifyReleaseBudget({ ...options, reuse: true }), /stale report/);
  const lockPath = join(f.root, "package-lock.json"), lock = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.packages["node_modules/example"].dev = true; writeFileSync(lockPath, JSON.stringify(lock)); f.stamp();
  assert.throws(() => f.check("release"), /development\/optional/);
  assert.equal(readFileSync(f.budgetPath, "utf8"), before);
});

test("symlink 越界或循环失败，不重复计算内部目标", { skip: process.platform === "win32" ? "native Windows symlink privilege unavailable; release scanner still enforces boundary" : false }, t => {
  const f = fixture(t);
  symlinkSync(join(f.root, "dist/client/a.js"), join(f.root, "dist/client/link.js"));
  assert.equal(scanTree(join(f.root, "dist/client")).length, 1);
  symlinkSync(f.root, join(f.root, "dist/client/escape"));
  assert.throws(() => scanTree(join(f.root, "dist/client")), /escaping link/);
  rmSync(join(f.root, "dist/client/escape"));
  symlinkSync(join(f.root, "dist/client"), join(f.root, "dist/client/cycle"));
  assert.throws(() => scanTree(join(f.root, "dist/client")), /cyclic link/);
});

test("超标预检不会进入 stopOriginal，健康实例继续受保护", async () => {
  const calls = [];
  await assert.rejects((async () => {
    await verifyBeforeServiceCutover({ original: { pid: 123 }, revision: "same", stages: ["artifact"], readRevision: async () => "same", readStatus: async () => "", assertOriginalService: async () => calls.push("healthy"), runStage: async () => { calls.push("budget"); throw new Error("ARTIFACT_BUDGET_EXCEEDED"); } });
    await cutoverWithRollback({ stopOriginal: async () => calls.push("stop") });
  })(), /ARTIFACT_BUDGET_EXCEEDED/);
  assert.deepEqual(calls, ["healthy", "budget"]);
});

test("本次真实构建、固定预算与 Codex 包禁令", () => {
  const root = resolve(import.meta.dirname, "..");
  const path = join(root, "config/artifact-size-budget.json"), before = readFileSync(path, "utf8");
  const report = checkArtifacts({ root });
  assert.equal(report.failed, false, JSON.stringify(report.rows));
  assert.equal(readFileSync(path, "utf8"), before);
  console.log(JSON.stringify({ artifact_budget: report.rows, revision: report.revision, environment: report.environment }));
});
