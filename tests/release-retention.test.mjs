import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pruneReleases } from "../scripts/release-retention.mjs";

test("retention protects distinct rollback, dirty trees and links; dry-run and health failure never delete", async () => {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "release-retention-")));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init");
    const revisions = [];
    for (let i = 0; i < 3; i++) {
      git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", String(i));
      const revision = git("rev-parse", "HEAD");
      revisions.push(revision);
      const path = resolve(root, ".local/releases", revision.slice(0, 12));
      mkdirSync(resolve(root, ".local/releases"), { recursive: true });
      git("worktree", "add", "--detach", path, revision);
      writeFileSync(resolve(path, ".taskcenter-release.json"), JSON.stringify({ schemaVersion: "taskcenter-release/v1", revision, releaseId: revision.slice(0, 12) }));
    }
    const paths = revisions.map((r) => resolve(root, ".local/releases", r.slice(0, 12)));
    const options = {
      projectRoot: root, active: { revision: revisions[2], sourceRoot: paths[2] },
      events: [...revisions, revisions[2]].map((revision) => ({ revision, stage: "deployment", outcome: "succeeded" })),
      assertHealthy: async () => {},
    };
    assert.deepEqual((await pruneReleases({ ...options, dryRun: true })).removed, [paths[0]]);
    assert.ok(existsSync(paths[0]));
    await assert.rejects(pruneReleases({ ...options, assertHealthy: async () => { throw new Error("unhealthy"); } }), /unhealthy/);
    assert.ok(existsSync(paths[0]));
    writeFileSync(resolve(paths[0], "user.txt"), "keep");
    assert.equal((await pruneReleases(options)).skipped.length, 1);
    rmSync(resolve(paths[0], "user.txt"));
    symlinkSync(paths[0], resolve(root, ".local/releases/aaaaaaaaaaaa"));
    const result = await pruneReleases(options);
    assert.equal(result.skipped.length, 1);
    assert.deepEqual(result.keep, [revisions[2], revisions[1]]);
    assert.deepEqual(result.removed, [paths[0]]);
    assert.ok(!existsSync(paths[0]));
    assert.ok(existsSync(paths[1]) && existsSync(paths[2]));
    assert.ok(!git("worktree", "list", "--porcelain").includes(paths[0]));
    await assert.rejects(pruneReleases({ ...options, events: [] }), /缺少上一/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
