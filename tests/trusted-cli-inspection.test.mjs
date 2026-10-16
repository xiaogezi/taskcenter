import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { inspectTrustedCli } from "../scripts/trusted-cli-inspection.mjs";
import { isTrustedCliEntry } from "../scripts/trusted-cli-identity.mjs";

const binary = join(homedir(), ".local/share/android-ui-dcb/releases/0.4.0-alpha.1-67e73ab4e599d2c9/dcb");
test("受信入口拒绝同名脚本、错误摘要与替换链接", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cli-identity-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installed = join(root, "installed"), alias = join(root, "alias");
  writeFileSync(installed, "fixture", { mode: 0o755 });
  symlinkSync(installed, alias);
  const policy = { installed, aliases: [alias], sha256: createHash("sha256").update("fixture").digest("hex") };
  assert.equal(isTrustedCliEntry(alias, policy), true);
  assert.equal(isTrustedCliEntry("installed", policy), false);
  assert.equal(isTrustedCliEntry(alias, { ...policy, sha256: "0".repeat(64) }), false);
  rmSync(alias); writeFileSync(alias, "fixture", { mode: 0o755 });
  assert.equal(isTrustedCliEntry(alias, policy), false);
  chmodSync(installed, 0o644);
  assert.equal(isTrustedCliEntry(installed, policy), false);
});

test("DCB 统一分派只接受审核入口和精确只读参数", { skip: !existsSync(binary) }, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dcb-l0-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), workspace = join(root, "repo");
  const installed = join(home, ".local/share/android-ui-dcb/releases/0.4.0-alpha.1-67e73ab4e599d2c9/dcb");
  const entry = join(home, ".codex/skills/android-ui-implement/bin/dcb"), alias = join(home, ".local/bin/dcb");
  for (const file of [installed, entry, alias, join(workspace, "src/x")]) mkdirSync(dirname(file), { recursive: true });
  copyFileSync(binary, installed); symlinkSync(installed, alias); symlinkSync(alias, entry);
  const map = join(root, "map.json"); writeFileSync(map, "{}");
  const context = { home, workspace, cwd: workspace };
  const check = args => inspectTrustedCli([entry, ...args], context);
  const graph = ["interaction", "graph", "--project-root", ".", "--interaction-map", map];
  const query = ["interaction", "query", ...graph.slice(2), "--screen", "home", "--direction", "outgoing"];
  for (const args of [["--version"], ["--help"], ["doctor", "--project-root", "."], graph, ["interaction", "check", ...graph.slice(2)], query,
    ["interaction", "query", ...graph.slice(2), "--entity", "dialog", "--direction", "incoming"]]) assert.equal(check(args), true, args.join(" "));
  for (const prefix of [["rtk", "proxy"], ["/opt/homebrew/bin/rtk", "proxy"]]) assert.equal(inspectTrustedCli([...prefix, entry, ...graph], context), true);
  for (const args of [["--version", "--output", "x"], ["doctor"], ["doctor", "--project-root", ".."], ["doctor", "--project-root", ".", "--screen", "home"],
    ["interaction", "preview", ...graph.slice(2)], ["interaction", "apply", ...graph.slice(2)], ["capture", "x"], ["index", "rebuild"],
    [...graph, "--project-root", "."], [...graph, "--output", "x"], [...query, "--entity", "x"], [...query, "--direction", "incoming"],
    [...query.slice(0, -1), "invalid"], ["interaction", "query", ...graph.slice(2), "--entity", "x", "--state", "x", "--direction", "incoming"],
    ["interaction", "graph", "--project-root", ".", "--interaction-map", "relative.json"]]) assert.equal(check(args), false, args.join(" "));
  for (const words of [["/tmp/dcb", "--version"], ["dcb", "--version"], ["/tmp/rtk", "proxy", entry, "--version"], ["rtk", entry, "--version"],
    ["env", "INJECT=1", entry, "--version"], ["/bin/env", "INJECT=1", entry, "--version"]]) assert.notEqual(inspectTrustedCli(words, context), true);
  assert.equal(inspectTrustedCli(["constructor"], context), null);
  assert.equal(inspectTrustedCli([entry, ...graph], { ...context, cwd: root }), false);
  rmSync(entry); writeFileSync(entry, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.equal(check(["--version"]), false);
  writeFileSync(installed, "#!/bin/sh\nexit 0\n");
  assert.equal(inspectTrustedCli([installed, "--version"], context), false);
});

test("审核 DCB 真正执行版本、doctor 与 interaction 查询不写项目含 Git 元数据", { skip: !existsSync(binary) }, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dcb-readonly-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "design-registry"));
  writeFileSync(join(root, "design-registry/registry.json"), JSON.stringify({ schema_version: "1.0", screens: {} }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const map = join(root, "map.json");
  writeFileSync(map, JSON.stringify({ schema_version: "dcb-interaction-candidate/1", project_id: "legacy", run_id: "fixture",
    baseline: { repo_id: "app", revision: "a".repeat(40), base_dcb_snapshot: null },
    entities: [{ id: "dialog", kind: "dialog", label: "Dialog", screen_id: null, state_id: null }], sources: [], edges: [] }));
  const snapshot = () => {
    const hash = createHash("sha256");
    const walk = path => { for (const item of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(path, item.name); hash.update(file);
      if (item.isDirectory()) walk(file); else hash.update(readFileSync(file));
    } };
    walk(root); return hash.digest("hex");
  };
  const before = snapshot();
  for (const args of [["--version"], ["doctor", "--project-root", root], ...["graph", "check", "query"].map(verb => ["interaction", verb, "--project-root", root, "--interaction-map", map, ...(verb === "query" ? ["--entity", "dialog", "--direction", "outgoing"] : [])])]) {
    try { execFileSync(binary, args, { cwd: root, stdio: "pipe", timeout: 5000 }); }
    catch (error) { assert.fail(`${args.join(" ")}: ${error.stderr}`); }
    assert.equal(snapshot(), before, args.join(" "));
  }
});
