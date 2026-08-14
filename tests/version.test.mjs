import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { TASKCENTER_VERSION } from "../scripts/version.mjs";

test("公开版本由 package.json 单源提供且 README 一致", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.equal(TASKCENTER_VERSION, "0.1.4");
  assert.equal(packageJson.version, TASKCENTER_VERSION);
  assert.ok(readme.includes(`当前版本：\`v${TASKCENTER_VERSION}\``));
});
