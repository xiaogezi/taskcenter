function cleanTitle(title) {
  return typeof title === "string" ? title.trim().replace(/\s+/g, " ") : "";
}

function workspaceLabel(cwd) {
  const canonical = cleanTitle(cwd).replace(/[\\/]+$/, "");
  if (!canonical) return "Codex 会话";
  return canonical.split(/[\\/]/).filter(Boolean).at(-1) || "Codex 会话";
}

export function sessionDisplayTitle(title, sessionId, cwd = "") {
  const canonical = cleanTitle(title);
  if (canonical) return canonical;
  const suffix = typeof sessionId === "string" && sessionId ? `${sessionId.slice(0, 8)}…` : "未知 ID";
  return `${workspaceLabel(cwd)} · ${suffix}`;
}

function isFallbackSessionTitle(thread, sessionId) {
  const canonical = cleanTitle(thread?.title);
  const suffix = typeof sessionId === "string" && sessionId ? `${sessionId.slice(0, 8)}…` : "未知 ID";
  return thread?.titleSource === "metadata"
    || !canonical
    || canonical === `未命名会话 · ${suffix}`
    || canonical === sessionDisplayTitle("", sessionId, thread?.cwd);
}

export function enrichSessionTitles(threads, tasks) {
  const taskTitlesBySession = new Map();
  for (const task of tasks) {
    const sessionId = typeof task?.sessionId === "string" ? task.sessionId.trim() : "";
    const title = cleanTitle(task?.title);
    if (!sessionId || !title || task.status === "removed") continue;
    const createdAt = Date.parse(task.createdAt ?? "");
    const candidate = {
      title,
      createdAt: Number.isFinite(createdAt) ? createdAt : Number.POSITIVE_INFINITY,
      id: String(task.id ?? ""),
    };
    const current = taskTitlesBySession.get(sessionId);
    if (
      !current
      || candidate.createdAt < current.createdAt
      || (candidate.createdAt === current.createdAt && candidate.id.localeCompare(current.id) < 0)
    ) {
      taskTitlesBySession.set(sessionId, candidate);
    }
  }

  return threads.map((thread) => {
    const sessionId = typeof thread?.id === "string" ? thread.id : "";
    if (!sessionId || !isFallbackSessionTitle(thread, sessionId)) return thread;
    const taskTitle = taskTitlesBySession.get(sessionId)?.title;
    return taskTitle ? { ...thread, title: taskTitle, titleSource: "task" } : thread;
  });
}

export function sessionGroupKey(thread) {
  const title = cleanTitle(thread.title);
  return title ? `title:${title.toLocaleLowerCase("zh-CN")}` : `session:${thread.id ?? "unknown"}`;
}

export function groupSessions(threads) {
  const groups = new Map();
  for (const thread of threads) {
    const sessionId = typeof thread.id === "string" ? thread.id : "";
    if (!sessionId) continue;
    const key = sessionGroupKey(thread);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        ...thread,
        id: key,
        groupKey: key,
        title: sessionDisplayTitle(thread.title, sessionId, thread.cwd),
        sessionIds: [sessionId],
        sessionCount: 1,
      });
      continue;
    }
    existing.sessionIds.push(sessionId);
    existing.sessionCount = existing.sessionIds.length;
    existing.requirementCount = (existing.requirementCount ?? existing.requirementsCount ?? 0)
      + (thread.requirementCount ?? thread.requirementsCount ?? 0);
    if (new Date(thread.updatedAt ?? thread.lastActivity ?? 0).getTime() > new Date(existing.updatedAt ?? existing.lastActivity ?? 0).getTime()) {
      existing.updatedAt = thread.updatedAt ?? thread.lastActivity;
      existing.lastActivity = thread.lastActivity ?? thread.updatedAt;
      existing.cwd = thread.cwd ?? existing.cwd;
    }
  }
  return [...groups.values()].sort((left, right) => {
    const leftTime = new Date(left.updatedAt ?? left.lastActivity ?? 0).getTime() || 0;
    const rightTime = new Date(right.updatedAt ?? right.lastActivity ?? 0).getTime() || 0;
    return rightTime - leftTime;
  });
}

export function mergeTaskSessions(threads, tasks, availableThreads = threads) {
  const titledThreads = enrichSessionTitles(threads, tasks);
  const titledAvailableThreads = enrichSessionTitles(availableThreads, tasks);
  const merged = [...titledThreads];
  const knownIds = new Set(threads.flatMap((thread) => [thread.id, ...(thread.sessionIds ?? [])]).filter(Boolean));
  const latestTaskBySession = new Map();
  for (const task of tasks) {
    if (!task?.sessionId || task.status === "removed") continue;
    const previous = latestTaskBySession.get(task.sessionId);
    if (!previous || new Date(task.updatedAt ?? 0).getTime() > new Date(previous.updatedAt ?? 0).getTime()) {
      latestTaskBySession.set(task.sessionId, task);
    }
  }
  for (const sessionId of latestTaskBySession.keys()) {
    if (knownIds.has(sessionId)) continue;
    const source = titledAvailableThreads.find((thread) => thread.id === sessionId || thread.sessionIds?.includes(sessionId));
    if (!source) continue;
    merged.push({
      ...source,
      id: sessionId,
      sessionIds: [sessionId],
      sessionCount: 1,
      sessionSource: "codex",
    });
    knownIds.add(sessionId);
  }
  return merged;
}

export function sessionIdsForGroup(selectedGroupId, groups) {
  return groups.find((group) => group.id === selectedGroupId)?.sessionIds ?? [];
}

export function requirementThreadIds(requirements) {
  const ids = new Set();
  for (const requirement of requirements) {
    if (requirement.threadId) ids.add(requirement.threadId);
    const sources = requirement.sources?.length
      ? requirement.sources
      : requirement.source
        ? [requirement.source]
        : [];
    for (const source of sources) {
      if (source.threadId) ids.add(source.threadId);
    }
  }
  return ids;
}

export function filterThreadsWithRequirements(threads, requirements, tasks = []) {
  const requiredIds = requirementThreadIds(requirements);
  for (const task of tasks) {
    if (task?.sessionId) requiredIds.add(task.sessionId);
  }
  return threads.filter((thread) => {
    const sessionId = thread.id;
    if (!sessionId) return false;
    if (thread.sessionIds?.some((id) => requiredIds.has(id))) return true;
    return requiredIds.has(sessionId);
  });
}

export function taskThreadIds(tasks) {
  return new Set(tasks.filter((task) => task?.status !== "removed" && task?.sessionId).map((task) => task.sessionId));
}

export function filterThreadsWithTasks(threads, tasks) {
  const taskIds = taskThreadIds(tasks);
  return threads.filter((thread) => {
    const sessionId = thread.id;
    if (!sessionId) return false;
    if (thread.sessionIds?.some((id) => taskIds.has(id))) return true;
    return taskIds.has(sessionId);
  });
}
