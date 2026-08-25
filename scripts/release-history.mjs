import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export function appendReleaseEvent(path, event) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({
    schemaVersion: "release-event/v1",
    recordedAt: new Date().toISOString(),
    ...event,
  })}\n`, { mode: 0o600 });
}

export function loadReleaseEvents(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return event?.schemaVersion === "release-event/v1" ? [event] : [];
      } catch {
        return [];
      }
    });
}

export function summarizeReleaseEvents(events) {
  const terminal = events.filter((event) => ["succeeded", "rolled_back", "failed"].includes(event.outcome));
  const durations = terminal.map((event) => Number(event.durationMs)).filter(Number.isFinite).sort((a, b) => a - b);
  const succeeded = terminal.filter((event) => event.outcome === "succeeded").length;
  const rolledBack = terminal.filter((event) => event.outcome === "rolled_back").length;
  return {
    deployments: terminal.length,
    succeeded,
    rolledBack,
    failed: terminal.length - succeeded - rolledBack,
    successRate: terminal.length ? succeeded / terminal.length : null,
    rollbackRate: terminal.length ? rolledBack / terminal.length : null,
    durationMs: {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
    },
    lastDeployment: terminal.at(-1) || null,
  };
}

function percentile(sorted, ratio) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}
