import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { reviewerCommand } from "../scripts/reviewer-cli.mjs";

test("retired Reviewer launcher rejects before reading input or spawning Codex", () => {
  assert.throws(() => reviewerCommand({ promptPath: "missing", outputPath: "missing" }), /RETIRED_CODEX_EXECUTION/);
  for (const args of [["missing", "missing"], ["--managed", "missing", "missing"]]) {
    const result = spawnSync(process.execPath, ["scripts/reviewer-cli.mjs", ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /RETIRED_CODEX_EXECUTION/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  }
});
