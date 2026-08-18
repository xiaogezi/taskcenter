import { existsSync, readFileSync } from "node:fs";

export const sessionIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function normalizeSessionAllowlist(value) {
  const threadIds = Array.isArray(value?.threadIds)
    ? [...new Set(value.threadIds.filter((id) => typeof id === "string" && sessionIdPattern.test(id)))]
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
