import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { explorationCommand, isReadOnlyJev } from "../scripts/jev-inspection.mjs";
import { inspectionWords } from "../scripts/inspection-command.mjs";
import { inspectTrustedCli } from "../scripts/trusted-cli-inspection.mjs";

test("Jev report validates exact query and complete reviewed local import graph", t => {
  const home = mkdtempSync(join(tmpdir(), "jev-report-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "Documents/project/ProjectContextAgent");
  const artifacts = {};
  for (const path of ["scripts/jev-decision.mjs", "mcp/client/jev-decisions.mjs", "mcp/runtime/file-lease.mjs", "mcp/runtime/path-safety.mjs"]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), path, { mode: 0o755 });
    artifacts[path] = createHash("sha256").update(path).digest("hex");
  }
  const installed = join(root, "scripts/jev-decision.mjs"), alias = join(home, ".local/bin/jev-decision");
  mkdirSync(dirname(alias), { recursive: true }); symlinkSync(installed, alias);
  const options = { home, env: {}, artifacts };
  for (const entry of [installed, alias]) for (const args of [["report"], ["report", "task-a"]]) assert.equal(isReadOnlyJev([entry, ...args], options), true);
  for (const args of [["advise"], ["record"], ["declare"], ["report", "--help"], ["report", "a/b"], ["report", "task-a", "extra"]]) assert.equal(isReadOnlyJev([alias, ...args], options), false);
  assert.equal(isReadOnlyJev(["jev-decision", "report"], options), false);
  assert.equal(isReadOnlyJev([alias, "report"], { ...options, env: { NODE_OPTIONS: "--import=evil" } }), false);
  const session = "00000000-0000-0000-0000-000000000001";
  const turn = "00000000-0000-0000-0000-000000000002";
  const command = `rtk proxy "${alias}" explore '{"state":{"summary":"literal $(echo example)"},"sanitized":true}'`;
  assert.deepEqual(inspectionWords(explorationCommand(command, session, turn, options)),
    [process.execPath, installed, "explore", session, turn, '{"state":{"summary":"literal $(echo example)"},"sanitized":true}']);
  for (const invalid of [command + " && pwd", command + " > out",
    `"${alias}" explore '{"task_id":null}'`, `/tmp/jev-decision explore '{}'`]) {
    assert.equal(explorationCommand(invalid, session, turn, options), null);
  }
  assert.equal(explorationCommand(command, session, "", options), null);
  const dependency = join(root, "mcp/runtime/file-lease.mjs"), outside = join(home, "outside.mjs");
  writeFileSync(outside, "mcp/runtime/file-lease.mjs", { mode: 0o755 });
  rmSync(dependency); symlinkSync(outside, dependency);
  assert.equal(isReadOnlyJev([alias, "report"], options), false, "same-content symlink must not change relative import resolution");
  rmSync(dependency); writeFileSync(dependency, "mcp/runtime/file-lease.mjs", { mode: 0o755 });
  writeFileSync(join(root, "mcp/runtime/path-safety.mjs"), "replacement");
  assert.equal(isReadOnlyJev([alias, "report"], options), false);
  assert.equal(explorationCommand(command, session, turn, options), null);
});

test("installed audited Jev report is routed through trusted CLI with RTK", () => {
  const entry = join(homedir(), ".local/bin/jev-decision");
  if (!isReadOnlyJev([entry, "report"])) return;
  const context = { cwd: process.cwd(), workspace: process.cwd() };
  assert.equal(inspectTrustedCli(["rtk", "proxy", entry, "report", "task-a"], context), true);
  assert.equal(inspectTrustedCli(["/tmp/rtk", "proxy", entry, "report"], context), false);
  assert.equal(inspectTrustedCli([entry, "record"], context), false);
});
