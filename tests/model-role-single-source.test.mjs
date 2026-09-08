import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("活跃路由代码和项目规则只引用角色配置，不复制具体型号", async () => {
  const config = JSON.parse(await readFile(new URL("config/model-roles.json", root), "utf8"));
  const configuredModels = [...new Set([
    config.roles.executor.model,
    config.roles.reviewer.model,
    ...config.roles.executor.fallback_models,
    ...config.roles.reviewer.fallback_models,
    ...config.retired_models,
  ])];
  const activeFiles = [
    "AGENTS.md",
    "scripts/model-role-config.mjs",
    "scripts/routing-control.mjs",
    "scripts/taskcenter-mcp.mjs",
    "app/page.tsx",
  ];
  for (const path of activeFiles) {
    const source = await readFile(new URL(path, root), "utf8");
    for (const model of configuredModels) {
      assert.equal(source.includes(model), false, `${path} 不应复制配置型号 ${model}`);
    }
  }
});
