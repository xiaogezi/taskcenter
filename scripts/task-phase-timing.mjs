/** Append-only phase-event validation and auditable task timing aggregation. */

export const PHASES = [
  "planning",
  "implementing",
  "verifying",
  "reviewing",
  "reworking",
  "waiting_external",
];
export const PHASE_TRANSITIONS = ["started", "paused", "resumed", "finished"];
export const ACTIVITY_SOURCES = [
  "agent",
  "delegated_executor",
  "review_cycle",
  "build_wait",
  "external_wait",
  "other",
];

const requiredFields = [
  "task_id",
  "session_id",
  "phase",
  "transition",
  "occurred_at",
  "event_id",
  "subject_ref",
  "reason",
  "activity_source",
];
const optionalFields = ["activity_id", "delegation_id", "review_cycle_id"];
const reviewPhases = new Set(["reviewing", "reworking", "verifying"]);
const waitSources = new Set(["build_wait", "external_wait"]);
const terminalReviewOutcomes = new Set(["approved", "rejected", "cancelled"]);
const reviewPhaseOrder = ["pending_review", "reviewing", "fixing", "verifying", "completed"];

export class PhaseTimingError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "PhaseTimingError";
    this.statusCode = statusCode;
  }
}

export function streamIdentity(event) {
  if (event?.activity_id || event?.activityId) return `activity:${event.activity_id || event.activityId}`;
  if (event?.delegation_id || event?.delegationId) return `delegation:${event.delegation_id || event.delegationId}`;
  if (event?.review_cycle_id || event?.reviewCycleId) return `review_cycle:${event.review_cycle_id || event.reviewCycleId}`;
  return `session:${event?.session_id || event?.sessionId || "unknown"}`;
}

export function validatePhaseEvent(event, { taskId, previousEvents = [], reviewCycles } = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) fail("阶段事件必须是对象。");
  for (const field of requiredFields) {
    if (event[field] === undefined || event[field] === null || event[field] === "") fail(`阶段事件缺少 ${field}。`);
  }
  if (!PHASES.includes(event.phase)) fail("阶段无效。");
  if (!PHASE_TRANSITIONS.includes(event.transition)) fail("阶段转换无效。");
  if (!ACTIVITY_SOURCES.includes(event.activity_source)) fail("活动来源无效。");
  if (taskId !== undefined && String(event.task_id) !== String(taskId)) fail("跨任务阶段事件。", 409);
  const occurredAt = Date.parse(event.occurred_at);
  if (!Number.isFinite(occurredAt)) fail("occurred_at 必须是有效 ISO 时间。");
  if (event.activity_source === "delegated_executor" && !event.delegation_id) {
    fail("delegated_executor 阶段事件必须提供 delegation_id。");
  }
  if (event.delegation_id && event.activity_source !== "delegated_executor") {
    fail("delegation_id 只能用于 delegated_executor 活动来源。", 409);
  }
  if (event.activity_source === "review_cycle" && !event.review_cycle_id) {
    fail("review_cycle 阶段事件必须提供 review_cycle_id。");
  }
  if (event.review_cycle_id && !reviewPhases.has(event.phase)) {
    fail("review_cycle_id 只能用于 reviewing、reworking 或 verifying 阶段。", 409);
  }

  const normalized = phaseEventRecord(event);
  const duplicate = previousEvents.find((item) => item.event_id === normalized.event_id);
  if (duplicate) {
    if (stableJson(phaseEventRecord(duplicate)) !== stableJson(normalized)) fail("event_id 幂等冲突。", 409);
    return normalized;
  }

  const identity = streamIdentity(normalized);
  const stream = previousEvents.filter((item) => streamIdentity(item) === identity);
  const last = stream.at(-1);
  if (last && occurredAt < Date.parse(last.occurred_at)) fail("阶段事件时间顺序无效。", 409);
  const state = last?.transition || "idle";
  if (normalized.transition === "started" && !["idle", "finished"].includes(state)) fail("阶段已经开始。", 409);
  if (normalized.transition === "paused" && !["started", "resumed"].includes(state)) fail("只能暂停活动阶段。", 409);
  if (normalized.transition === "resumed" && state !== "paused") fail("只能恢复暂停阶段。", 409);
  if (normalized.transition === "finished" && !["started", "resumed", "paused"].includes(state)) fail("阶段结束早于开始。", 409);

  if (!["idle", "finished"].includes(state)) {
    const lifecycleStart = [...stream].reverse().find((item) => item.transition === "started");
    for (const field of ["task_id", "phase", "activity_source", "activity_id", "delegation_id", "review_cycle_id"]) {
      if (String(normalized[field] || "") !== String(lifecycleStart?.[field] || "")) {
        fail(`阶段生命周期内 ${field} 不可变更。`, 409);
      }
    }
    if (subjectIdentity(normalized.subject_ref) !== subjectIdentity(lifecycleStart?.subject_ref)) {
      fail("阶段生命周期内 subject_ref 不可变更。", 409);
    }
  }

  if (normalized.review_cycle_id && Array.isArray(reviewCycles)) {
    const cycle = reviewCycles.find((item) => item.cycle_id === normalized.review_cycle_id);
    if (!cycle) fail("阶段事件引用的 Review Cycle 不存在。", 404);
    if (cycle.subject_ref && subjectIdentity(cycle.subject_ref) !== subjectIdentity(normalized.subject_ref)) {
      fail("阶段事件与 Review Cycle 的 SubjectReference 不一致。", 409);
    }
  }
  return normalized;
}

export function appendPhaseEvent(events = [], event, options = {}) {
  const list = Array.isArray(events) ? events : [];
  const normalized = validatePhaseEvent(event, { ...options, previousEvents: list });
  const existing = list.find((item) => item.event_id === normalized.event_id);
  return existing ? list.slice() : [...list, normalized];
}

export function validatePhaseEvents(events = [], options = {}) {
  let result = [];
  for (const event of events) result = appendPhaseEvent(result, event, options);
  return result;
}

export function buildTaskPhaseReport({ task_id, taskId, phaseEvents, reviewCycles, as_of, asOf } = {}) {
  const id = String(task_id ?? taskId ?? "");
  const requestedAsOf = as_of ?? asOf;
  const parsedAsOf = parseAsOf(requestedAsOf);
  if (requestedAsOf !== undefined && requestedAsOf !== null && requestedAsOf !== "" && parsedAsOf === null) {
    fail("as_of 必须是有效 ISO 时间。");
  }
  const now = parsedAsOf ?? Date.now();
  const reportAsOf = new Date(now).toISOString();
  if (!Array.isArray(phaseEvents) && !Array.isArray(reviewCycles)) return emptyReport(reportAsOf);

  const events = validatePhaseEvents(phaseEvents || [], { taskId: id || undefined, reviewCycles });
  const cycles = Array.isArray(reviewCycles) ? reviewCycles : [];
  if (!events.length && !cycles.length) return emptyReport(reportAsOf);

  const warnings = [];
  const eventData = buildEventIntervals(events, now);
  const cycleData = buildReviewCycleIntervals(cycles, id, now, warnings);
  reconcileLinkedReviewEvents(eventData.lifecycles, cycleData.contributions, warnings);

  const phases = {};
  const executorActive = new Map();
  const waitByKind = { build: [], external: [], paused: [], review_queue: [], other: [] };
  let unattributedActiveMs = 0;
  let reportPartial = eventData.open;

  for (const lifecycle of eventData.lifecycles) {
    for (const wait of lifecycle.waitIntervals) waitByKind[wait.kind].push(wait.interval);
  }
  for (const contribution of cycleData.contributions) {
    for (const wait of contribution.waitIntervals) waitByKind[wait.kind].push(wait.interval);
  }

  for (const phase of PHASES) {
    const eventLifecycles = eventData.lifecycles.filter((item) => item.phase === phase);
    const cycleContributions = cycleData.contributions.filter((item) => item.phase === phase);
    const linkedCycleIds = new Set(cycleContributions.map((item) => item.cycleId));
    const authoritativeEventLifecycles = eventLifecycles.filter((item) => item.reviewCycleId && linkedCycleIds.has(item.reviewCycleId));
    const independentEventLifecycles = eventLifecycles.filter((item) => !authoritativeEventLifecycles.includes(item));
    const wallIntervals = [
      ...independentEventLifecycles.map((item) => item.wallInterval),
      ...cycleContributions.flatMap((item) => item.wallIntervals),
    ];
    const waitIntervals = [
      ...eventLifecycles.flatMap((item) => item.waitIntervals.map((wait) => wait.interval)),
      ...cycleContributions.flatMap((item) => item.waitIntervals.map((wait) => wait.interval)),
    ];
    const eventActiveIntervals = independentEventLifecycles.flatMap((item) => item.activeIntervals);
    const eventActiveMs = sumIntervals(eventActiveIntervals.map((item) => item.interval));
    const cycleActiveKnown = cycleContributions.every((item) => item.activeKnown);
    const cycleActiveMs = cycleContributions.reduce((sum, item) => sum + (item.activeMs || 0), 0);
    const hasData = eventLifecycles.length > 0 || cycleContributions.length > 0;
    const activeMs = !hasData
      ? null
      : cycleContributions.length && !cycleActiveKnown
        ? null
        : eventActiveMs + cycleActiveMs;

    for (const interval of eventActiveIntervals) addDuration(executorActive, interval.executorId, intervalDuration(interval.interval));
    for (const contribution of cycleContributions) {
      if (!contribution.activeKnown || !contribution.activeMs) continue;
      const linked = authoritativeEventLifecycles.filter((item) => item.reviewCycleId === contribution.cycleId);
      const executors = new Set(linked.flatMap((item) => item.executorIds));
      if (phase === "reviewing" && contribution.reviewerId) executors.add(contribution.reviewerId);
      if (executors.size === 1) addDuration(executorActive, [...executors][0], contribution.activeMs);
      else unattributedActiveMs += contribution.activeMs;
    }

    const partial = hasData && (
      independentEventLifecycles.some((item) => item.open)
      || authoritativeEventLifecycles.some((item) => item.open)
      || cycleContributions.some((item) => item.partial)
      || (cycleContributions.length > 0 && !cycleActiveKnown)
    );
    reportPartial ||= partial;
    const hasEventSource = independentEventLifecycles.length > 0;
    const hasCycleSource = cycleContributions.length > 0;
    phases[phase] = {
      phase_wall_ms: unionDuration(wallIntervals),
      phase_active_ms: activeMs,
      phase_wait_ms: hasData ? (unionDuration(waitIntervals) ?? 0) : null,
      active_time_source: hasCycleSource && hasEventSource ? "mixed" : hasCycleSource ? "review_cycle" : hasEventSource ? "phase_events" : "unknown",
      measurement_confidence: !hasData ? "unknown" : partial ? "partial" : "complete",
    };
  }

  const allWallIntervals = PHASES.flatMap((phase) => {
    const linkedCycleIds = new Set(cycleData.contributions.filter((item) => item.phase === phase).map((item) => item.cycleId));
    return [
      ...eventData.lifecycles.filter((item) => item.phase === phase && !(item.reviewCycleId && linkedCycleIds.has(item.reviewCycleId))).map((item) => item.wallInterval),
      ...cycleData.contributions.filter((item) => item.phase === phase).flatMap((item) => item.wallIntervals),
    ];
  });
  const taskWallMs = unionDuration(allWallIntervals);
  const hasAnyData = events.length > 0 || cycleData.contributions.length > 0;
  const hasUnknownAuthoritativeActive = cycleData.contributions.some((item) => !item.activeKnown);
  const conflict = warnings.some((item) => item.code === "REVIEW_CYCLE_CONFLICT");
  const status = !hasAnyData ? "unknown" : reportPartial || cycleData.partial || conflict ? "partial" : "complete";

  return {
    schema_version: "taskcenter-task-phase-report-v1",
    status,
    as_of: reportAsOf,
    task_wall_ms: taskWallMs,
    phases,
    executor_active_ms: Object.fromEntries([...executorActive.entries()].sort(([left], [right]) => left.localeCompare(right))),
    unattributed_active_ms: hasUnknownAuthoritativeActive ? null : unattributedActiveMs,
    wait_breakdown_ms: Object.fromEntries(Object.entries(waitByKind).map(([kind, intervals]) => [kind, unionDuration(intervals) ?? 0])),
    data_sources: {
      phase_events: events.length > 0,
      review_cycles: cycleData.acceptedCycles > 0,
      review_cycle_authoritative: cycleData.contributions.length > 0,
    },
    coverage: {
      phase_event_count: events.length,
      observed_phase_count: PHASES.filter((phase) => phases[phase].measurement_confidence !== "unknown").length,
      total_phase_count: PHASES.length,
    },
    warnings,
    review_cycle_reconciliation: cycleData.summary,
  };
}

export const taskcenterTaskPhaseReport = buildTaskPhaseReport;

export function buildTaskPhaseTiming(task, asOf) {
  const phaseEvents = task?.phaseEvents ?? task?.phase_events;
  const reviewCycles = task?.reviewCycles ?? task?.review_cycles;
  const hasTimingRecords = (Array.isArray(phaseEvents) && phaseEvents.length > 0) || (Array.isArray(reviewCycles) && reviewCycles.length > 0);
  return buildTaskPhaseReport({
    task_id: task?.task_id ?? task?.id,
    phaseEvents,
    reviewCycles,
    as_of: asOf || (!hasTimingRecords ? task?.updatedAt || task?.createdAt : undefined),
  });
}

export function withTaskPhaseTiming(task, asOf) {
  return { ...task, phaseTiming: buildTaskPhaseTiming(task, asOf) };
}

export function applyTaskPhaseEvent(task, event) {
  const taskId = task?.task_id ?? task?.id;
  const phaseEvents = appendPhaseEvent(task?.phaseEvents ?? task?.phase_events ?? [], event, {
    taskId,
    reviewCycles: task?.reviewCycles ?? task?.review_cycles,
  });
  return withTaskPhaseTiming({ ...task, phaseEvents });
}

function buildEventIntervals(events, now) {
  const grouped = new Map();
  for (const event of events) {
    const key = streamIdentity(event);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(event);
  }
  const lifecycles = [];
  let hasOpenLifecycle = false;
  for (const stream of grouped.values()) {
    let lifecycle = null;
    let state = "idle";
    let segmentStart = null;
    let pausedAt = null;
    for (const event of stream) {
      const at = Date.parse(event.occurred_at);
      if (event.transition === "started") {
        lifecycle = {
          phase: event.phase,
          source: event.activity_source,
          reviewCycleId: event.review_cycle_id || "",
          startedAt: at,
          wallInterval: null,
          activeIntervals: [],
          waitIntervals: [],
          executorIds: new Set(),
          open: false,
        };
        state = "active";
        segmentStart = { at, event };
        pausedAt = null;
      } else if (event.transition === "paused") {
        closeOperationalSegment(lifecycle, segmentStart, at);
        state = "paused";
        segmentStart = null;
        pausedAt = at;
      } else if (event.transition === "resumed") {
        lifecycle.waitIntervals.push({ interval: [pausedAt, at], kind: "paused" });
        state = "active";
        segmentStart = { at, event };
        pausedAt = null;
      } else if (event.transition === "finished") {
        if (state === "paused") lifecycle.waitIntervals.push({ interval: [pausedAt, at], kind: "paused" });
        else closeOperationalSegment(lifecycle, segmentStart, at);
        lifecycle.wallInterval = [lifecycle.startedAt, at];
        lifecycles.push(finishLifecycle(lifecycle));
        lifecycle = null;
        state = "finished";
        segmentStart = null;
        pausedAt = null;
      }
    }
    if (lifecycle) {
      if (state === "paused") lifecycle.waitIntervals.push({ interval: [pausedAt, now], kind: "paused" });
      else closeOperationalSegment(lifecycle, segmentStart, now);
      lifecycle.wallInterval = [lifecycle.startedAt, now];
      lifecycle.open = true;
      lifecycles.push(finishLifecycle(lifecycle));
      hasOpenLifecycle = true;
    }
  }
  return { lifecycles, open: hasOpenLifecycle };
}

function finishLifecycle(lifecycle) {
  return { ...lifecycle, executorIds: [...lifecycle.executorIds] };
}

function closeOperationalSegment(lifecycle, start, end) {
  if (!lifecycle || !start || !Number.isFinite(start.at) || !Number.isFinite(end)) return;
  const interval = [start.at, Math.max(start.at, end)];
  if (waitSources.has(lifecycle.source)) {
    lifecycle.waitIntervals.push({ interval, kind: lifecycle.source === "build_wait" ? "build" : "external" });
    return;
  }
  const executorId = executorIdentity(start.event);
  lifecycle.activeIntervals.push({ interval, executorId });
  lifecycle.executorIds.add(executorId);
}

function buildReviewCycleIntervals(cycles, taskId, now, warnings) {
  const contributions = [];
  const summaryRows = [];
  let acceptedCycles = 0;
  let partial = false;
  for (const cycle of cycles) {
    const cycleTaskId = String(cycle?.task_id ?? cycle?.taskId ?? "");
    if (cycleTaskId && taskId && cycleTaskId !== taskId) {
      warnings.push({ code: "CROSS_TASK_REVIEW_CYCLE", cycle_id: cycle?.cycle_id || "", task_id: cycleTaskId });
      partial = true;
      continue;
    }
    if (!cycle?.cycle_id) {
      warnings.push({ code: "INVALID_REVIEW_CYCLE", reason: "missing_cycle_id" });
      partial = true;
      continue;
    }
    const row = reviewCycleRow(cycle, now, warnings);
    acceptedCycles += 1;
    partial ||= row.partial;
    contributions.push(...row.contributions);
    summaryRows.push(row.summary);
  }
  const sumKnown = (field) => {
    const values = summaryRows.map((item) => item[field]).filter(Number.isFinite);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  return {
    contributions,
    acceptedCycles,
    partial,
    summary: {
      status: !acceptedCycles || !contributions.length ? "unknown" : partial ? "partial" : "reconciled",
      cycles: acceptedCycles,
      mapped: contributions.length,
      wait_ms: sumKnown("wait_ms"),
      review_elapsed_ms: sumKnown("review_elapsed_ms"),
      fix_elapsed_ms: sumKnown("fix_elapsed_ms"),
      verification_elapsed_ms: sumKnown("verification_elapsed_ms"),
      wall_ms: sumKnown("wall_ms"),
      active_ms: sumKnown("active_ms"),
    },
  };
}

function reviewCycleRow(cycle, now, warnings) {
  const parse = (field) => parseCycleTime(cycle, field, warnings);
  const implementationReady = parse("implementation_ready_at");
  const requested = parse("review_requested_at");
  const reviewStarted = parse("review_started_at");
  const reviewFinished = parse("review_finished_at");
  const fixStarted = parse("fix_started_at");
  const fixFinished = parse("fix_finished_at");
  const verificationFinished = parse("verification_finished_at");
  const cyclePhase = cycle.phase || "";
  const cyclePhaseIndex = reviewPhaseOrder.indexOf(cyclePhase);
  const terminal = terminalReviewOutcomes.has(cycle.outcome || "") || cyclePhase === "completed";
  const contributions = [];
  let partial = false;

  const reviewing = makeCycleContribution({
    cycle,
    phase: "reviewing",
    wallStart: requested ?? reviewStarted,
    executionStart: reviewStarted,
    finish: reviewFinished,
    mayBeOpen: !terminal && ["pending_review", "reviewing"].includes(cyclePhase),
    waitStart: requested,
    waitEnd: reviewStarted,
    activeField: "review_active_ms",
    now,
  });
  if (reviewing) {
    contributions.push(reviewing);
    partial ||= reviewing.partial;
  } else if (cyclePhaseIndex >= reviewPhaseOrder.indexOf("fixing") && reviewStarted !== null && reviewFinished === null) {
    warnings.push({ code: "INCOMPLETE_REVIEW_CYCLE_TIME", cycle_id: cycle.cycle_id, phase: "reviewing", missing: "review_finished_at" });
    partial = true;
  }

  const reworking = makeCycleContribution({
    cycle,
    phase: "reworking",
    wallStart: fixStarted,
    executionStart: fixStarted,
    finish: fixFinished,
    mayBeOpen: !terminal && cyclePhase === "fixing",
    activeField: "fix_active_ms",
    now,
  });
  if (reworking) {
    contributions.push(reworking);
    partial ||= reworking.partial;
  } else if (cyclePhaseIndex >= reviewPhaseOrder.indexOf("verifying") && fixStarted !== null && fixFinished === null) {
    warnings.push({ code: "INCOMPLETE_REVIEW_CYCLE_TIME", cycle_id: cycle.cycle_id, phase: "reworking", missing: "fix_finished_at" });
    partial = true;
  }

  const verificationStarted = fixFinished ?? reviewFinished;
  const verifying = makeCycleContribution({
    cycle,
    phase: "verifying",
    wallStart: verificationStarted,
    executionStart: verificationStarted,
    finish: verificationFinished,
    mayBeOpen: !terminal && cyclePhase === "verifying",
    activeField: "verification_active_ms",
    now,
  });
  if (verifying && (verificationFinished !== null || cyclePhase === "verifying" || cycle.verification_active_ms !== undefined)) {
    contributions.push(verifying);
    partial ||= verifying.partial;
  }

  const wallEnd = verificationFinished ?? fixFinished ?? reviewFinished;
  const activeValues = [cycle.review_active_ms, cycle.fix_active_ms, cycle.verification_active_ms].filter(Number.isFinite);
  return {
    contributions,
    partial,
    summary: {
      cycle_id: cycle.cycle_id,
      wait_ms: span(requested, reviewStarted),
      review_elapsed_ms: span(reviewStarted, reviewFinished),
      fix_elapsed_ms: span(fixStarted, fixFinished),
      verification_elapsed_ms: span(verificationStarted, verificationFinished),
      wall_ms: span(implementationReady, wallEnd),
      active_ms: activeValues.length ? activeValues.reduce((sum, value) => sum + value, 0) : null,
    },
  };
}

function makeCycleContribution({ cycle, phase, wallStart, executionStart, finish, mayBeOpen, waitStart = null, waitEnd = null, activeField, now }) {
  if (wallStart === null && executionStart === null) return null;
  const end = finish ?? (mayBeOpen ? now : null);
  const activeValue = Number.isFinite(cycle[activeField]) ? Number(cycle[activeField]) : null;
  const pendingOnly = phase === "reviewing" && executionStart === null && waitStart !== null && mayBeOpen;
  const activeKnown = activeValue !== null || pendingOnly;
  const wallIntervals = end === null || wallStart === null ? [] : [[wallStart, Math.max(wallStart, end)]];
  const waitIntervals = waitStart !== null
    ? [{ interval: [waitStart, Math.max(waitStart, waitEnd ?? (mayBeOpen ? now : waitStart))], kind: "review_queue" }]
    : [];
  return {
    phase,
    cycleId: cycle.cycle_id,
    reviewerId: phase === "reviewing" ? reviewerIdentity(cycle.reviewer) : "",
    wallIntervals,
    executionIntervals: executionStart !== null && end !== null ? [[executionStart, Math.max(executionStart, end)]] : [],
    waitIntervals,
    activeKnown,
    activeMs: activeValue ?? (pendingOnly ? 0 : null),
    partial: finish === null || !activeKnown || !wallIntervals.length,
  };
}

function reconcileLinkedReviewEvents(lifecycles, contributions, warnings) {
  for (const contribution of contributions) {
    const linked = lifecycles.filter((item) => item.reviewCycleId === contribution.cycleId && item.phase === contribution.phase);
    if (!linked.length) continue;
    const eventWall = unionDuration(linked.map((item) => item.wallInterval));
    const cycleWall = unionDuration(contribution.executionIntervals);
    if (eventWall !== null && cycleWall !== null && eventWall !== cycleWall) {
      warnings.push({ code: "REVIEW_CYCLE_CONFLICT", cycle_id: contribution.cycleId, phase: contribution.phase, field: "wall_ms", review_cycle_ms: cycleWall, phase_event_ms: eventWall });
    }
  }
}

function phaseEventRecord(event) {
  return Object.fromEntries([...requiredFields, ...optionalFields].flatMap((field) => event[field] === undefined || event[field] === "" ? [] : [[field, event[field]]]));
}

function executorIdentity(event) {
  if (event?.delegation_id) return `delegation:${event.delegation_id}`;
  return `session:${event?.session_id || "unknown"}`;
}

function reviewerIdentity(reviewer) {
  if (!reviewer || typeof reviewer !== "object") return "";
  if (reviewer.session_id) return `session:${reviewer.session_id}`;
  return reviewer.id ? `reviewer:${reviewer.id}` : "";
}

function subjectIdentity(subject) {
  if (!subject || typeof subject !== "object") return "";
  return stableJson({ type: subject.type || "", value: subject.value || "", repository: subject.repository || "", branch: subject.branch || "" });
}

function parseCycleTime(cycle, field, warnings) {
  if (!cycle[field]) return null;
  const value = Date.parse(cycle[field]);
  if (Number.isFinite(value)) return value;
  warnings.push({ code: "INVALID_REVIEW_CYCLE_TIME", cycle_id: cycle.cycle_id || "", field });
  return null;
}

function parseAsOf(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function span(start, end) {
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function intervalDuration(interval) {
  return Math.max(0, interval[1] - interval[0]);
}

function sumIntervals(intervals) {
  return intervals.reduce((sum, interval) => sum + intervalDuration(interval), 0);
}

function unionDuration(intervals) {
  const valid = intervals
    .filter((item) => Array.isArray(item) && Number.isFinite(item[0]) && Number.isFinite(item[1]))
    .map(([start, end]) => [start, Math.max(start, end)])
    .sort((left, right) => left[0] - right[0]);
  if (!valid.length) return null;
  let total = 0;
  let currentStart = valid[0][0];
  let currentEnd = valid[0][1];
  for (const [start, end] of valid.slice(1)) {
    if (start <= currentEnd) currentEnd = Math.max(currentEnd, end);
    else {
      total += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    }
  }
  return total + currentEnd - currentStart;
}

function addDuration(map, key, duration) {
  if (!key || !Number.isFinite(duration)) return;
  map.set(key, (map.get(key) || 0) + duration);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function emptyReport(asOf) {
  return {
    schema_version: "taskcenter-task-phase-report-v1",
    status: "unknown",
    as_of: asOf,
    task_wall_ms: null,
    phases: Object.fromEntries(PHASES.map((phase) => [phase, {
      phase_wall_ms: null,
      phase_active_ms: null,
      phase_wait_ms: null,
      active_time_source: "unknown",
      measurement_confidence: "unknown",
    }])),
    executor_active_ms: {},
    unattributed_active_ms: null,
    wait_breakdown_ms: { build: null, external: null, paused: null, review_queue: null, other: null },
    data_sources: { phase_events: false, review_cycles: false, review_cycle_authoritative: false },
    coverage: { phase_event_count: 0, observed_phase_count: 0, total_phase_count: PHASES.length },
    warnings: [],
    review_cycle_reconciliation: {
      status: "unknown",
      cycles: 0,
      mapped: 0,
      wait_ms: null,
      review_elapsed_ms: null,
      fix_elapsed_ms: null,
      verification_elapsed_ms: null,
      wall_ms: null,
      active_ms: null,
    },
  };
}

function fail(message, statusCode = 400) {
  throw new PhaseTimingError(message, statusCode);
}
