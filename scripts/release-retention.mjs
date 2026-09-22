import { readdirSync, readFileSync, realpathSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

// Called under the controller's deployment lock, after checking the live instance.
export async function pruneReleases({ projectRoot, active, events, assertHealthy, dryRun = false }) {
  const root = resolve(projectRoot, ".local/releases");
  if (realpathSync(root) !== root) throw new Error("拒绝清理符号链接 release 目录");
  const previous = [...events].reverse().find((event) =>
    event.stage === "deployment" && event.outcome === "succeeded" && event.revision !== active.revision);
  if (!previous) throw new Error("缺少上一不同成功版本，拒绝清理");
  if (![active.revision, previous.revision].every((revision) => /^[a-f0-9]{40}$/.test(revision))) throw new Error("保留版本 revision 无效");
  const previousRoot = resolve(root, previous.revision.slice(0, 12));
  const previousMarker = JSON.parse(readFileSync(resolve(previousRoot, ".taskcenter-release.json"), "utf8"));
  if (previousMarker.revision !== previous.revision || realpathSync(previousRoot) !== previousRoot) throw new Error("回滚构建身份不匹配");
  const keep = new Set([active.revision, previous.revision]);
  const git = (args) => execFileSync("git", args, { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const entries = readdirSync(root, { withFileTypes: true });
  const removed = [];
  const skipped = [];
  const candidates = [];
  for (const entry of entries) {
    if (!/^[a-f0-9]{12}$/.test(entry.name)) continue;
    const path = resolve(root, entry.name);
    if (path === active.sourceRoot || [...keep].some((revision) => revision.slice(0, 12) === entry.name)) continue;
    try {
      if (!entry.isDirectory() || realpathSync(path) !== path) throw new Error("非受管目录");
      const markerPath = resolve(path, ".taskcenter-release.json");
      if (lstatSync(markerPath).isSymbolicLink()) throw new Error("标记为符号链接");
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      if (marker.schemaVersion !== "taskcenter-release/v1" || marker.releaseId !== entry.name || marker.revision?.slice(0, 12) !== entry.name || git(["-C", path, "rev-parse", "HEAD"]) !== marker.revision) throw new Error("构建身份不匹配");
      if (keep.has(marker.revision)) continue;
      const changes = git(["-C", path, "status", "--porcelain", "--untracked-files=all"]).split("\n").filter(Boolean);
      if (changes.some((line) => line !== "?? .taskcenter-release.json")) throw new Error("存在用户改动");
      candidates.push(path);
    } catch (error) {
      skipped.push({ path, reason: error.message });
    }
  }
  for (const path of candidates) {
    await assertHealthy();
    if (!dryRun) git(["worktree", "remove", "--force", path]);
    removed.push(path);
  }
  return { dryRun, keep: [...keep], removed, skipped };
}
