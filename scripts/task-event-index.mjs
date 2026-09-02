import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";

import { consumeJsonl, jsonlCheckpointFingerprint } from "./jsonl-stream.mjs";
import { writeJsonAtomic } from "./usage-index.mjs";

const INDEX_VERSION = 6;

export async function updateTaskEventIndex(options) {
  const now = Number(options.now || Date.now());
  const cutoff = now - Number(options.retentionMs || 24 * 60 * 60_000);
  const info = existsSync(options.sourcePath) ? await stat(options.sourcePath) : null;
  const previous = await readJson(options.indexPath, null);
  const identity = info ? `${info.dev || 0}:${info.ino || 0}` : "missing";
  const previousOffset = Number(previous?.offset || 0);
  const checkpointMatches = info && previous?.checkpointHash && previous?.headHash
    && previous.checkpointHash === await jsonlCheckpointFingerprint(options.sourcePath, previousOffset)
    && previous.headHash === await jsonlCheckpointFingerprint(options.sourcePath, Math.min(previousOffset, 4096));
  const reusable = previous?.version === INDEX_VERSION && previous.identity === identity && info && info.size >= previousOffset && checkpointMatches;
  const index = reusable ? previous : { version: INDEX_VERSION, identity, offset: 0, events: [], byTask: {}, skippedOversizedLines: 0, checkpointHash: "", headHash: "" };

  if (info && info.size > Number(index.offset || 0)) {
    const result = await consumeJsonl(options.sourcePath, {
      start: Number(index.offset || 0),
      end: info.size - 1,
      onLine(line) {
        try {
          const event = JSON.parse(line.toString("utf8"));
          const at = eventTime(event);
          if (Number.isFinite(at) && at >= cutoff) index.events.push(compactMetricEvent(event));
          if (event.task_id) index.byTask[event.task_id] = [...(index.byTask[event.task_id] || []), compactTaskEvent(event)].slice(-100);
        } catch {
          // 损坏行不进入派生指标；原始不可变账本保持不动。
        }
      },
    });
    index.offset = result.offset;
    index.skippedOversizedLines = Number(index.skippedOversizedLines || 0) + result.skippedOversizedLines;
  }
  index.identity = identity;
  index.size = info?.size || 0;
  index.checkpointHash = info ? await jsonlCheckpointFingerprint(options.sourcePath, index.offset) : "";
  index.headHash = info ? await jsonlCheckpointFingerprint(options.sourcePath, Math.min(index.offset, 4096)) : "";
  index.events = (index.events || []).filter((event) => eventTime(event) >= cutoff);
  index.updatedAt = new Date(now).toISOString();
  await writeJsonAtomic(options.indexPath, index);
  return index;
}

function eventTime(event) {
  return Date.parse(event?.recorded_at || event?.recordedAt || event?.created_at || event?.createdAt || "");
}

function compactMetricEvent(event) {
  return {
    event_id: event.event_id,
    task_id: event.task_id,
    type: event.type,
    recorded_at: event.recorded_at || event.recordedAt || event.created_at || event.createdAt,
  };
}

function compactTaskEvent(event) {
  const keys = [
    "event_id", "task_id", "type", "status", "session_id", "created_at", "occurred_at", "recorded_at", "current_step", "tool_name", "review_reason", "next_action", "reason",
    "orchestrator_model", "selected_executor_model", "dispatch_channel", "routing_outcome", "routing_reason",
    "requirement_result", "verification_claim", "review_attestation", "review_cycle", "acceptance_record",
    "phase", "transition", "activity_source", "activity_id", "delegation_id", "review_cycle_id", "subject_ref",
  ];
  return Object.fromEntries(keys.flatMap((key) => event[key] === undefined ? [] : [[key, event[key]]]));
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}
