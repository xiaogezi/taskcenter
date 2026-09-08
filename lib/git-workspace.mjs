import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

function text(path) {
  try { return readFileSync(path, "utf8").trim(); }
  catch { return ""; }
}

export function inspectGitWorkspace(workspace) {
  if (!String(workspace || "").trim()) return null;
  let root;
  try { root = realpathSync(resolve(workspace)); }
  catch { return null; }

  const marker = join(root, ".git");
  let markerStat;
  try { markerStat = lstatSync(marker); }
  catch { return null; }

  const linked = markerStat.isFile();
  const pointer = linked ? text(marker).match(/^gitdir:\s*(.+)$/i)?.[1] : "";
  if (linked && !pointer) return null;
  const gitDir = linked ? resolve(root, pointer) : marker;
  const commonPointer = text(join(gitDir, "commondir"));
  const commonGitDir = commonPointer ? resolve(gitDir, commonPointer) : gitDir;
  const repositoryRoot = basename(commonGitDir) === ".git" ? dirname(commonGitDir) : root;
  const head = text(join(gitDir, "HEAD"));
  const branch = head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : "detached";
  const label = basename(repositoryRoot);
  return {
    workspace: root,
    repositoryRoot,
    branch,
    executionEnvironment: linked ? "worktree" : "local",
    projectId: label.toLocaleLowerCase("en-US"),
    label,
  };
}

export function enrichTaskWorkspaceEvent(input, session = {}) {
  const workspace = String(input?.workspace || session.workspace || "").trim();
  const identity = inspectGitWorkspace(workspace);
  if (!identity) return workspace && !input.workspace ? { ...input, workspace } : input;
  return {
    ...input,
    workspace,
    project_id: input.project_id || session.projectId || identity.projectId,
    repository_root: identity.repositoryRoot,
    workspace_branch: identity.branch,
    ...(input.type === "task.create" && !input.execution_environment
      ? { execution_environment: identity.executionEnvironment }
      : {}),
  };
}
