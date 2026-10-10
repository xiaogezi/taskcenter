import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isReadOnlyDevKit } from "../scripts/devkit-inspection.mjs";

test("DevKit L0 精确匹配安装入口、参数与工作区", (t) => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "devkit-l0-")));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const home = join(temp, "home"), workspace = join(temp, "repo"), outside = join(temp, "outside");
  const installed = join(home, ".local/share/uv/tools/devkit-assets/bin/dev-kit"), entry = join(home, ".local/bin/dev-kit");
  for (const path of [join(home, ".local/bin"), join(home, ".local/share/uv/tools/devkit-assets/bin"), join(workspace, "src"), outside]) mkdirSync(path, { recursive: true });
  writeFileSync(installed, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  symlinkSync(installed, entry);
  symlinkSync(outside, join(workspace, "escape"));
  const prefix = ["env", "PYTHONDONTWRITEBYTECODE=1", entry];
  const classify = (args, cwd = workspace) => isReadOnlyDevKit([...prefix, ...args], { cwd, workspace, home });
  for (const args of [
    ["doctor", "--repo", ".", "--format", "json"],
    ["asset", "status", "--repo=.", "--base", "HEAD", "--format=text"],
    ["asset", "capture", "preview", "--baseline", "--all-sources", "--check", "project-ci", "--repo", "."],
    ["asset", "capture", "preview", "--baseline", "--scope", "src", "--scope=src", "--repo", "."],
    ["asset", "capture", "preview", "--base", "origin/main", "--repo", "."],
  ]) assert.equal(classify(args), true, args.join(" "));
  assert.equal(classify(["asset", "capture", "preview", "--baseline", "--scope", "src", "--repo", ".."], join(workspace, "src")), true);
  assert.equal(isReadOnlyDevKit(["/usr/bin/env", prefix[1], installed, "doctor", "--repo", workspace], { cwd: workspace, workspace, home }), true);
  for (const args of [
    ["doctor"], ["doctor", "--repo", outside], ["doctor", "--repo", ".", "--repo", "."],
    ["doctor", "--repo", ".", "--format", "yaml"], ["doctor", "--repo", ".", "--base", "HEAD"],
    ["doctor", "--repo", ".", "--profile", "x"], ["doctor", "--repo", ".", "--catalog", "x"],
    ["asset", "capture", "apply", "--repo", "."], ["scaffold", "apply", "--repo", "."], ["verify", "--repo", "."],
    ["asset", "capture", "preview", "--baseline", "--repo", "."],
    ["asset", "capture", "preview", "--baseline", "--all-sources", "--base", "HEAD", "--repo", "."],
    ["asset", "capture", "preview", "--base", "HEAD", "--scope", "src", "--repo", "."],
    ["asset", "capture", "preview", "--base", "HEAD", "--all-sources", "--repo", "."],
    ["asset", "capture", "preview", "--baseline", "--scope", "escape", "--repo", "."],
    ["asset", "capture", "preview", "--baseline", "--scope", "../outside", "--repo", "."],
    ["asset", "capture", "preview", "--base", "HEAD..main", "--repo", "."],
    ["asset", "capture", "preview", "--baseline", "--all-sources", "--all-sources", "--repo", "."],
    ["asset", "capture", "preview", "--baseline", "--all-sources", "--relocate", "--repo", "."],
    ["asset", "capture", "preview", "--baseline", "--all-sources", "--check", "../verify", "--repo", "."],
    ["doctor", "--repo"], ["--version"],
  ]) assert.equal(classify(args), false, args.join(" "));
  assert.equal(classify(["doctor", "--repo", workspace], outside), false);
  for (const tokens of [
    [entry, "doctor", "--repo", "."],
    ["env", "PYTHONDONTWRITEBYTECODE=0", entry, "doctor", "--repo", "."],
    ["env", prefix[1], "PYTHONPATH=evil", entry, "doctor", "--repo", "."],
    ["env", prefix[1], "dev-kit", "doctor", "--repo", "."],
    ["env", prefix[1], "/tmp/dev-kit", "doctor", "--repo", "."],
    ["env", prefix[1], "python", "-c", "print(1)"],
  ]) assert.equal(isReadOnlyDevKit(tokens, { cwd: workspace, workspace, home }), false);
  rmSync(entry);
  writeFileSync(entry, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.equal(classify(["doctor", "--repo", "."]), false);
});

const installed = join(homedir(), ".local/share/uv/tools/devkit-assets/bin/dev-kit");
test("已安装 DevKit baseline preview 不修改项目或执行 check", { skip: !existsSync(installed) }, (t) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "devkit-preview-")));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const write = (path, content, mode = 0o644) => {
    const parts = path.split("/"); parts.pop();
    mkdirSync(join(repo, ...parts), { recursive: true });
    writeFileSync(join(repo, path), typeof content === "string" ? content : JSON.stringify(content), { mode });
  };
  write("src/main/kotlin/Shared.kt", "package fixture\nclass SharedUnit\n");
  write("assets/catalog.json", { schema_version: "2", components: [], assets: [] });
  write("tools/verify.sh", "#!/bin/sh\ntouch check-executed\nexit 99\n", 0o755);
  write(".devkit/profile.json", {
    schema_version: "3", name: "L0 fixture", pack: "android-compose", catalog_asset_key: "android",
    path_variables: { source_root: "src/main/kotlin" }, capabilities: ["doctor", "asset_capture"],
    component_catalog: "assets/catalog.json", templates: [], checks: [],
    asset_capture: { candidate_pool: ".devkit/asset-candidates.json", default_check: "project-ci",
      checks: [{ id: "project-ci", executable: "tools/verify.sh", args: [], timeout_seconds: 30 }], exclude_paths: [], suppressions: [] },
  });
  const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git(["init", "-q"]); git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
  const snapshot = () => {
    const hash = createHash("sha256");
    const walk = (path = "") => {
      for (const item of readdirSync(join(repo, path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = join(path, item.name);
        if (item.isDirectory()) walk(file);
        else { hash.update(file); hash.update(readFileSync(join(repo, file))); }
      }
    };
    walk(); return hash.digest("hex");
  };
  const before = snapshot();
  const output = execFileSync(installed, ["asset", "capture", "preview", "--baseline", "--all-sources", "--check", "project-ci", "--repo", repo, "--format", "json"], {
    cwd: repo, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  const result = JSON.parse(output);
  assert.equal(result.ok, true, output);
  assert.equal(result.data.plan.check_id, "project-ci");
  assert.equal(result.data.plan.mode, "baseline");
  assert.equal(snapshot(), before, "包括 Git 元数据在内的文件内容不变");
  assert.equal(existsSync(join(repo, "check-executed")), false);
  assert.equal(existsSync(join(repo, ".devkit/asset-candidates.json")), false);
});
