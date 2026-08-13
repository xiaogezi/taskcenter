const PROJECT_LABELS = new Map([
  ["atlas", "Atlas"],
  ["taskcenter", "TaskCenter"],
]);

export function projectLabelFromWorkspace(workspace) {
  const normalized = String(workspace ?? "").replaceAll("\\", "/").replace(/\/+$/, "");
  const match = normalized.match(/(?:^|\/)projects\/([^/]+)$/i);
  return match ? PROJECT_LABELS.get(match[1].toLowerCase()) ?? null : null;
}

export function resolveTaskSessionDisplay(task, thread) {
  const projectLabel = projectLabelFromWorkspace(task?.workspace);
  if (thread?.title) {
    return {
      title: thread.title,
      detail: projectLabel ? `项目：${projectLabel}` : (task?.sessionId ? `${task.sessionId.slice(0, 8)}…` : ""),
      sessionId: task?.sessionId ?? "",
      hasSession: true,
    };
  }
  if (projectLabel) {
    return {
      title: "未关联会话",
      detail: `项目：${projectLabel}`,
      sessionId: task?.sessionId ?? "",
      hasSession: false,
    };
  }
  return null;
}

export function taskMatchesSession(task, { selectedSessionIds = [], availableSessionIds = [], selectedThread } = {}) {
  if (selectedSessionIds.includes(task?.sessionId)) return true;
  if (availableSessionIds.includes(task?.sessionId)) return false;
  const taskProject = projectLabelFromWorkspace(task?.workspace);
  if (!taskProject || !selectedThread) return false;
  const titleProject = selectedThread.title
    ? projectLabelFromWorkspace(`/projects/${selectedThread.title}`)
    : null;
  const cwdProject = projectLabelFromWorkspace(selectedThread.cwd);
  return titleProject === taskProject || cwdProject === taskProject;
}
