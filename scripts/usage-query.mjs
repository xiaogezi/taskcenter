import { buildUsageReportFromParsed, createTaskUsageAttributor } from "./usage-report.mjs";
import { boundedResponse } from "./bounded-response.mjs";

export function queryUsageReport({ report, index, tasks = [], params = new URLSearchParams() }) {
  if (params.has("cursor")) return boundedResponse(null, { cursor: params.get("cursor") });
  const allowed = new Set(["project", "session", "task", "window", "fields", "top_n", "summary_only", "cursor"]);
  if ([...params.keys()].some((key) => !allowed.has(key))) return { error: "INVALID_FILTER" };
  const window = params.get("window");
  if (window && !["5h", "24h", "7d", "lifetime"].includes(window)) return { error: "INVALID_WINDOW" };
  const top = params.has("top_n") ? Number(params.get("top_n")) : 10;
  if (!Number.isInteger(top) || top < 1 || top > 100) return { error: "INVALID_TOP_N" };
  if (params.has("summary_only") && !["true", "false"].includes(params.get("summary_only"))) return { error: "INVALID_SUMMARY_ONLY" };
  const summaryOnly = params.get("summary_only") !== "false";
  if (["project", "session", "task"].some((key) => params.has(key))) {
    if (!index?.files) return { error: "USAGE_INDEX_UNAVAILABLE", next_action: "wait_for_usage_index" };
    const attribute = createTaskUsageAttributor(tasks);
    const parsed = Object.values(index.files).filter((state) => {
      if (params.has("session") && state.sessionId !== params.get("session")) return false;
      if (!params.has("project")) return true;
      const project = params.get("project");
      return state.cwd === project || tasks.some((task) => task.projectId === project && (task.sessionId === state.sessionId || task.sessionHistory?.includes(state.sessionId)));
    }).map((state) => {
      if (!params.has("task")) return state;
      const id = params.get("task");
      const lifetime = state.lifetimeByTask?.[id];
      const belongsToTask = (sample) => attribute(state.sessionId, Array.isArray(sample) ? sample[0] : sample.at).includes(id);
      return { ...state,
        events: (state.events || []).filter(belongsToTask),
        responseInputs: (state.responseInputs || []).filter(belongsToTask),
        responseGaps: (state.responseGaps || []).filter(belongsToTask),
        sameTimestampPairs: (state.sameTimestampPairs || []).filter(belongsToTask),
        toolSamples: (state.toolSamples || []).filter(belongsToTask),
        lifetimeTotal: lifetime || { usage: { input: 0, cachedInput: 0, output: 0, reasoning: 0 }, count: 0, total: 0 },
        lifetimeByTask: lifetime ? { [id]: lifetime } : {},
        latestRateLimits: {},
      };
    });
    report = buildUsageReportFromParsed(parsed, { ledger: tasks, now: index.updatedAt || report.generatedAt });
  }
  const group = (value) => Object.fromEntries(Object.entries(value || {}).flatMap(([key, entry]) => {
    if (Array.isArray(entry)) return summaryOnly ? [] : [[key, [...entry].sort((a, b) => Number(b.count || 0) - Number(a.count || 0)).slice(0, top)]];
    return [[key, entry]];
  }));
  let payload = {
    generatedAt: report.generatedAt,
    ...(window === "lifetime" ? {} : { windows: Object.fromEntries(Object.entries(report.windows || {}).filter(([name]) => !window || name === window).map(([name, value]) => [name, group(value)])) }),
    ...(!window || window === "lifetime" ? { lifetime: group(report.lifetime) } : {}),
    source: report.source || { mode: "usage_index", retention: "7d", attribution: "estimated" },
    filters: Object.fromEntries(params),
  };
  if (params.has("fields")) {
    const fields = params.get("fields").split(",");
    if (fields.some((key) => !Object.hasOwn(payload, key))) return { error: "INVALID_FIELDS", fields: Object.keys(payload) };
    payload = Object.fromEntries(fields.map((key) => [key, payload[key]]));
  }
  return boundedResponse(payload, { summary: { generatedAt: report.generatedAt, window: window || "all", summary_only: summaryOnly, top_n: top } });
}
