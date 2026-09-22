import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "cli-profile-"));
const path = join(directory, "roles.json");
process.env.TASKCENTER_MODEL_ROLE_CONFIG_PATH = path;
const original = JSON.parse(readFileSync(new URL("../config/model-roles.json", import.meta.url), "utf8"));
const { cliProfile } = await import("../scripts/cli-profile.mjs");
const save = value => writeFileSync(path, JSON.stringify(value));
test.after(() => rmSync(directory, { recursive: true, force: true }));

test("客户端目录解析全部 Kimi 型号，旧 profiles 和无目录旧配置仍兼容", () => {
  save(original);
  for (const [name, model] of Object.entries({
    "kimi-k3": "kimi-code/k3-256k",
    "kimi-k3-standard": "kimi-code/k3",
    "kimi-k2.8-preview": "kimi-code/kimi-for-coding",
    "kimi-k2.7-highspeed": "kimi-code/kimi-for-coding-highspeed",
    "claude-mimo": "mimo-v2.5-pro",
  })) assert.equal(cliProfile(name).model, model);
  const old = structuredClone(original);
  delete old.cli_clients;
  save(old);
  assert.equal(cliProfile("kimi-k3").model, "kimi-code/k3-256k");
  assert.equal(cliProfile("claude-mimo").provider, "xiaomi");
});

test("未知客户端、型号、冲突别名和不支持的 thinking 在执行前拒绝", () => {
  for (const change of [
    config => { config.cli_profiles.probe = { harness: "unknown", model: "test", reasoning_effort: "low" }; },
    config => { config.cli_profiles["kimi-k3"].model = "unconfigured"; },
    config => { config.cli_profiles["kimi-k3"].reasoning_effort = "medium"; },
    config => { config.cli_profiles["kimi-k3"].model_key = "k3"; },
    config => { config.cli_profiles["kimi-k3"].model = "gpt-6-astra"; },
    config => { config.cli_clients.kimi.reasoning_efforts = "low"; },
  ]) {
    const input = structuredClone(original);
    change(input); save(input);
    assert.throws(() => cliProfile(input.cli_profiles.probe ? "probe" : "kimi-k3"));
  }
  save(original);
  assert.throws(() => cliProfile("missing"));
});

test("按型号反解默认路由实际使用的客户端 profile", async () => {
  const { cliProfileForModel } = await import("../scripts/cli-profile.mjs");
  save(original);
  assert.deepEqual({ name: cliProfileForModel("kimi-code/k3-256k").name, harness: cliProfileForModel("kimi-code/k3-256k").harness }, { name: "kimi-k3", harness: "kimi" });
  assert.equal(cliProfileForModel("mimo-v2.5-pro").name, "claude-mimo");
  for (const model of ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.5-pro", "mimo-v2.5"]) {
    const profile = cliProfileForModel(model);
    assert.equal(profile.model, model);
    assert.equal(profile.harness, "claude");
    assert.equal(profile.provider, "xiaomi");
    assert.equal(cliProfile(profile.name).model, model);
    assert.ok(original.quota_pools.find(pool => pool.id === "claude").models.includes(model));
  }
  assert.equal(cliProfileForModel("unknown-model"), null);
  assert.equal(cliProfileForModel(""), null);
  const manualOnly = structuredClone(original);
  manualOnly.manual_only_models = ["kimi-code/k3-256k"];
  save(manualOnly);
  assert.equal(cliProfileForModel("kimi-code/k3-256k"), null, "manual_only 型号不解析为可派发 profile");
  save(original);
});
