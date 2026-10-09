import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { enrichTaskWorkspaceEvent, inspectGitWorkspace } from "../lib/git-workspace.mjs";

test("省略工作区的任务事件保留任务绑定，显式工作区仍生效", () => {
  const session = { workspace: "/session-parent" };
  const task = { workspace: "/task-project" };
  assert.equal(enrichTaskWorkspaceEvent({ type: "task.update" }, session, task).workspace, task.workspace);
  assert.equal(enrichTaskWorkspaceEvent({ type: "task.update", workspace: "/explicit" }, session, task).workspace, "/explicit");
  assert.equal(enrichTaskWorkspaceEvent({ type: "task.create" }, session).workspace, session.workspace);
});

test("关联 Git worktree 自动继承主项目身份、分支和执行环境", async () => {
  const root = await mkdtemp(join(tmpdir(), "taskcenter-git-workspace-"));
  const main = join(root, "SampleProject");
  const worktree = join(root, "feature");
  try {
    execFileSync("git", ["init", "-q", main]);
    execFileSync("git", ["-C", main, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", main, "config", "user.name", "TaskCenter Test"]);
    await writeFile(join(main, "README.md"), "fixture\n");
    execFileSync("git", ["-C", main, "add", "README.md"]);
    execFileSync("git", ["-C", main, "commit", "-qm", "fixture"]);
    execFileSync("git", ["-C", main, "worktree", "add", "-qb", "feature/test", worktree]);

    assert.deepEqual(inspectGitWorkspace(worktree), {
      workspace: realpathSync(worktree),
      repositoryRoot: realpathSync(main),
      branch: "feature/test",
      executionEnvironment: "worktree",
      projectId: "sampleproject",
      label: "SampleProject",
    });
    assert.deepEqual(enrichTaskWorkspaceEvent({ type: "task.create", workspace: worktree }), {
      type: "task.create",
      workspace: worktree,
      project_id: "sampleproject",
      repository_root: realpathSync(main),
      workspace_branch: "feature/test",
      execution_environment: "worktree",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
