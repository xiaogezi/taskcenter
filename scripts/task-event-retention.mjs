import { resolve } from "node:path";
import { eventStore } from "./task-event-store.mjs";

const started = performance.now();
const store = eventStore(resolve(process.env.TASKCENTER_TASK_EVENTS_PATH || "data/task-events.jsonl"));
if (store) {
  try {
    store.sync();
    console.log(JSON.stringify({ event: "task_tool_retention", ...store.retain(), elapsed_ms: Math.round(performance.now() - started) }));
  } finally { store.close(); }
}
