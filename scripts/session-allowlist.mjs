import { existsSync, readFileSync } from "node:fs";

export const sessionIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function normalizeSessionAllowlist(value) {
  const threadIds = Array.isArray(value?.threadIds)
    ? [...new Set(value.threadIds
      .filter((id) => typeof id === "string" && sessionIdPattern.test(id))
      .map((id) => id.toLowerCase()))]
    : [];
  const legacyMode = value?.mode === "selected" || value?.mode === "all";
  return {
    version: 2,
    mode: "allowlist",
    threadIds,
    ...(typeof value?.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
    ...(legacyMode ? { migratedFrom: value.mode } : {}),
  };
}

export function readSessionAllowlist(path) {
  if (!existsSync(path)) return normalizeSessionAllowlist(null);
  try {
    return normalizeSessionAllowlist(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return normalizeSessionAllowlist(null);
  }
}

export function updateSessionAllowlist(value, sessionId, enabled, updatedAt = new Date().toISOString()) {
  const normalizedSessionId = String(sessionId || "").toLowerCase();
  if (!sessionIdPattern.test(normalizedSessionId)) throw new TypeError("Session ID 无效。");
  if (typeof enabled !== "boolean") throw new TypeError("enabled 必须是 boolean。");
  const current = normalizeSessionAllowlist(value);
  const threadIds = enabled
    ? [...new Set([...current.threadIds, normalizedSessionId])]
    : current.threadIds.filter((id) => id !== normalizedSessionId);
  return normalizeSessionAllowlist({ mode: "allowlist", threadIds, updatedAt });
}
