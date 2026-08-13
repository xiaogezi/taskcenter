import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dataDir = join(root, "data");
const ledgerPath = join(dataDir, "task-ledger.json");
const eventsPath = join(dataDir, "task-events.jsonl");
const reconcilePath = join(dataDir, "task-reconcile.jsonl");
const merges = JSON.parse(readFileSync(join(dataDir, "session-merges.json"), "utf8"));
const aliases = new Map((merges.aliases || []).map((id) => [id, merges.canonicalSessionId]));
const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
const events = existsSync(eventsPath)
  ? readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  : [];

const recovered = [];
const next = ledger.map((task) => {
  const canonical = aliases.get(task.sessionId);
  if (!canonical || task.status !== "removed") return task;
  const prior = events.filter((event) => event.task_id === task.id && !String(event.event_id).startsWith("cleanup-")).at(-1);
  recovered.push({ id: task.id, from: task.sessionId, to: canonical, restoredEventId: prior?.event_id || null });
  return {
    ...task,
    sessionId: canonical,
    status: prior?.status || "done_claimed",
    updatedAt: prior?.created_at || task.updatedAt,
    lastEventId: prior?.event_id || task.lastEventId,
  };
});

if (!recovered.length) {
  console.log(JSON.stringify({ recovered: 0 }));
  process.exit(0);
}

const temporaryPath = `${ledgerPath}.tmp`;
writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
renameSync(temporaryPath, ledgerPath);
appendFileSync(reconcilePath, `${JSON.stringify({
  type: "task.reconcile.recovery",
  recoveredAt: new Date().toISOString(),
  reason: "Session 别名归并前的 reconcile 误隐藏，依据原始事件恢复",
  tasks: recovered,
})}\n`, { mode: 0o600 });
console.log(JSON.stringify({ recovered: recovered.length, tasks: recovered }, null, 2));
