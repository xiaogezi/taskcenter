import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readTaskEvents(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

// ── 门禁重复拒绝即时检测 ──────────────────────────────────────────────
// 拒绝发生时由 Hook/CLI 上报安全字段（分类/时间/Session/task/run），服务端
// 同步评估短窗口去重后的批量与重复拒绝；不持久化原始命令、错误正文或敏感文本。

export const GATE_DENIAL_WINDOW_MS = 3_600_000;
export const GATE_DENIAL_DEDUPE_MS = 60_000;
export const GATE_DENIAL_BATCH_TASKS = 3;
export const GATE_DENIAL_BATCH_RUNS = 5;
export const GATE_DENIAL_CONSECUTIVE = 3;
const GATE_DENIAL_LOG_MAX_BYTES = 1_000_000;
const GATE_DENIAL_LOG_RETAINED = 2_000;

const KNOWN_FAILURE_KINDS = new Set(["tool_approval", "filesystem_permission", "task_permission"]);

const GATE_DENIAL_GUIDANCE = {
  no_active_task: {
    reason: "PreToolUse 未识别为 L0 确定性只读，且 Session 没有活跃任务；这不等于检测到写入。",
    recovery: "若确为只读，先拆开复合命令；RTK 包装仅在规则明确允许等价原生命令时降级，并经过同一 Hook，不为只读另建无关任务。实际执行则同一交付用 taskcenter_task_resume 接续，独立目标用 taskcenter_task_begin。",
    verification: "只读调用应返回“L0 确定性只读检查放行”；实际执行应返回“任务门禁通过”。",
  },
  session_unregistered: {
    reason: "门禁拒绝：当前 Session 尚未完成 SessionStart 登记。",
    recovery: "先用真实 session_id 调用 taskcenter_session_register（或由 Hook session-start 自动登记），不要改用 local_ 前缀或自拟 ID。",
    verification: "GET /session-status 中该 session 状态为 registered 后重试原操作。",
  },
  interactive_command: {
    reason: "门禁拒绝：检测到可由 write_stdin 续写的交互式命令。",
    recovery: "改为一次性非交互命令，不启动可由 write_stdin 续写的会话。",
    verification: "以非交互形式重试，Hook 应 exit 0；若仍拒绝，检查是否混入 -i/--interactive 或管道等待输入。",
  },
  missing_route: {
    reason: "历史路由门禁拒绝：模型路由现已退役。",
    recovery: "核对主线任务、真实 Session、工作区和授权范围；同一交付调用 taskcenter_task_resume。模型路由已退役。",
    verification: "核对客户端已加载现行主线 Hook；主线只校验任务身份和所有权。",
  },
  task_permission: {
    reason: "任务权限拒绝：scope、workspace 或任务所有权与当前执行不匹配。",
    recovery: "核对真实 Session、主线任务所有权、scope 和 workspace；旧派发授权不再授予任务权限。",
    verification: "主线任务所有权和工作区校验通过后检查实际工具结果。",
  },
  tool_approval: {
    reason: "Harness 工具审批拒绝：执行器未获得该工具的一次性授权。",
    recovery: "按当前宿主语义使用已授权工具；确实缺少授权时说明具体工具和所需用户操作，宿主不允许审批时停止该调用，不绕过审批策略。",
    verification: "重试后该工具调用成功完成，Run 不再出现 permission_denials。",
  },
  filesystem_permission: {
    reason: "文件系统权限拒绝：路径不可写、只读挂载或沙箱越界。",
    recovery: "核对任务 scope、workspace 与宿主允许的可写路径；纠正目标目录或使用已授权路径，不提升沙箱权限，不改审批策略。",
    verification: "对修正后的路径重试写入成功，failure_kind 不再是 filesystem_permission。",
  },
  scheduled_readonly_scope: {
    reason: "scheduled_readonly 拒绝：操作超出绑定报告的确定性读取/托管写入范围。",
    recovery: "只保留绑定项目内只读与绑定报告的托管区块写入；业务修改回到有权限的任务 Session，不静默退出或修改 scheduled_readonly 模式。",
    verification: "重试限定操作返回放行；越权操作仍被拒绝且不影响已写入报告的 sha256 校验。",
  },
  reviewer_readonly: {
    reason: "独立 Reviewer 拒绝：该 Session 只允许确定性只读与 Review 报告。",
    recovery: "托管 Reviewer 已退役；外部审查由用户与宿主安排。",
    verification: "核对客户端不再调用托管 Reviewer 接口；审查证据使用外部报告入口。",
  },
  gate_other: {
    reason: "门禁拒绝：未归入更具体分类的 Hook/CLI 拒绝。",
    recovery: "按 Hook 返回的原始提示修复前置条件（任务、登记或授权），再重试；不要绕过 Hook 或关闭门禁。",
    verification: "同一工具调用重试后 Hook exit 0，且 /gate-denials 不再新增同类记录。",
  },
  taskcenter_unavailable: {
    reason: "TaskCenter 控制面不可用，无法确认当前主线任务。",
    recovery: "本仓库 gate-enabled 维护仅继续只读并报告 TASKCENTER_UNAVAILABLE；核对服务状态，使用既有固定恢复入口。保护健康实例，不直接停止或 restart，不关闭门禁。",
    verification: "服务恢复后重新核对真实 Session 登记、活跃任务，再执行原操作；此限制不扩散到外部项目构建。",
  },
};

// 从 Hook 错误提示或 CLI failure_kind 推导稳定分类码；不返回原始消息。
export function classifyGateDenial(input) {
  const kind = String(input?.failure_kind || "");
  if (KNOWN_FAILURE_KINDS.has(kind)) return kind;
  const message = String(input?.message || input?.error || "");
  if (/TASKCENTER_UNAVAILABLE|控制服务不可用|控制面不可用|fetch failed|ECONNREFUSED/i.test(message)) return "taskcenter_unavailable";
  if (/MCP tool call requires approval|approval policy is never/i.test(message)) return "tool_approval";
  if (/EACCES|EPERM|sandbox|read.only file system/i.test(message)) return "filesystem_permission";
  if (/无活跃任务|活跃正式任务|任务不存在|TASK_NOT_FOUND|L0_COMMAND_NOT_RECOGNIZED/.test(message)) return "no_active_task";
  if (/尚未登记|SESSION_NOT_REGISTERED/.test(message)) return "session_unregistered";
  if (/交互式命令/.test(message)) return "interactive_command";
  if (/缺少有效路由/.test(message)) return "missing_route";
  if (/scheduled_readonly/.test(message)) return "scheduled_readonly_scope";
  if (/Reviewer Session/.test(message)) return "reviewer_readonly";
  if (/CLI_(?:PERMISSION_DENIED|READ_ONLY|TOOL_UNSUPPORTED|NOT_CLAIMED|GRANT_MISMATCH|GRANT_REPLAY)|claim rejected|grant|scope|workspace|无权|绑定|所有权|TaskCenter.*门禁/i.test(message)) return "task_permission";
  if (/CLI_|TaskCenter/i.test(message)) return "gate_other";
  return "gate_other";
}

export function sanitizeGateDenialId(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,200}$/.test(text) ? text : "";
}

export function sanitizeGateDenialFailureKind(value) {
  const text = String(value || "").trim();
  return KNOWN_FAILURE_KINDS.has(text) ? text : "";
}

export function readGateDenials(path) {
  if (!path) return [];
  let content;
  try { content = readFileSync(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return content.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const value = JSON.parse(line);
      return value && typeof value === "object" ? [value] : [];
    } catch { return []; }
  });
}

export function gateDenialSnapshot(path, { limit = 20, now = Date.now() } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new RangeError("拒绝记录条数须为 1–50。");
  if (path) {
    try { if (statSync(path).size > GATE_DENIAL_LOG_MAX_BYTES) throw new Error("拒绝日志超出读取上限。"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const events = readGateDenials(path).flatMap(value => {
    const at = typeof value.at === "string" && value.at.length <= 40 ? Date.parse(value.at) : NaN;
    if (!Number.isFinite(at) || at > now + 5_000) return [];
    return [{ at: new Date(at).toISOString(),
      category: typeof value.category === "string" && Object.hasOwn(GATE_DENIAL_GUIDANCE, value.category) ? value.category : "gate_other",
      source: ["hook", "cli"].includes(value.source) ? value.source : "hook",
      ...Object.fromEntries(["session_id", "task_id", "run_id"].map(key => [key, sanitizeGateDenialId(value[key])])),
      failure_kind: sanitizeGateDenialFailureKind(value.failure_kind),
    }];
  });
  const records = events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
  const assessments = [...new Set(records.map(record => record.category))].map(category => evaluateGateDenials(events, { now, category }));
  return { generated_at: new Date(now).toISOString(), records, assessments };
}

// 短窗口去重：同一 分类+Session+task/run 在 dedupeMs 内的连续上报只计一次，
// 避免 tight retry 把单次根因放大成批量异常；窗口内事件按时间排序后评估。
export function evaluateGateDenials(events, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const windowMs = Number.isFinite(options.windowMs) ? options.windowMs : GATE_DENIAL_WINDOW_MS;
  const dedupeMs = Number.isFinite(options.dedupeMs) ? options.dedupeMs : GATE_DENIAL_DEDUPE_MS;
  const sorted = (Array.isArray(events) ? events : [])
    .map((event) => ({ event, at: Date.parse(event?.at || "") }))
    .filter((row) => Number.isFinite(row.at) && row.at <= now + 5_000 && row.at > now - windowMs)
    .sort((left, right) => left.at - right.at);
  const category = String(options.category || sorted.at(-1)?.event?.category || "gate_other");
  const sameCategory = [];
  const keptIdentities = [];
  for (const { event, at } of sorted) {
    if (String(event.category || "") !== category) continue;
    const identity = `${category}|${event.session_id || ""}|${event.run_id || event.task_id || ""}`;
    const lastKept = keptIdentities.find((row) => row.identity === identity && at - row.at < dedupeMs);
    if (lastKept) continue;
    keptIdentities.push({ identity, at });
    sameCategory.push({ ...event, at });
  }
  const taskIds = [...new Set(sameCategory.map((event) => event.task_id).filter(Boolean))];
  const runIds = [...new Set(sameCategory.map((event) => event.run_id).filter(Boolean))];
  const sessionIds = [...new Set(sameCategory.map((event) => event.session_id).filter(Boolean))];
  const unitCounts = new Map();
  for (const event of sameCategory) {
    const unit = event.task_id || event.session_id || "";
    if (!unit) continue;
    unitCounts.set(unit, (unitCounts.get(unit) || 0) + 1);
  }
  const repeated = Math.max(0, ...unitCounts.values());
  const repeatedUnit = [...unitCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "";
  const noStructuredId = taskIds.length === 0 && runIds.length === 0;
  let level = "single";
  if (taskIds.length >= GATE_DENIAL_BATCH_TASKS || runIds.length >= GATE_DENIAL_BATCH_RUNS || (noStructuredId && sessionIds.length >= GATE_DENIAL_BATCH_TASKS)) {
    level = "batch";
  } else if (repeated >= GATE_DENIAL_CONSECUTIVE) {
    level = "repeated";
  }
  const base = GATE_DENIAL_GUIDANCE[category] || GATE_DENIAL_GUIDANCE.gate_other;
  let reason = base.reason;
  let recovery = base.recovery;
  if (level === "batch") {
    reason = `批量异常：1 小时窗口去重后同类拒绝涉及 ${taskIds.length} 个任务、${runIds.length} 个 Run${noStructuredId ? `、${sessionIds.length} 个 Session` : ""}。${base.reason}`;
    recovery = `先修复共性根因（任务状态、路由或授权范围），再按单次恢复步骤重试；不要并发重复撞击同一门禁。${base.recovery}`;
  } else if (level === "repeated") {
    const unitLabel = taskIds.includes(repeatedUnit) ? "任务" : "Session";
    reason = `重复异常：同一${unitLabel}在 1 小时内同类拒绝去重后已达 ${repeated} 次。${base.reason}`;
    recovery = `停止对同一路径的重复重试，先完成恢复步骤并验证通过后再执行。${base.recovery}`;
  }
  return {
    level,
    category,
    window_ms: windowMs,
    dedupe_ms: dedupeMs,
    counts: {
      events: sameCategory.length,
      tasks: taskIds.length,
      runs: runIds.length,
      sessions: sessionIds.length,
      repeated,
      repeated_unit: repeatedUnit,
    },
    reason,
    recovery,
    verification: base.verification,
  };
}

export function formatGateDenialAssessment(assessment) {
  if (!assessment || !assessment.level) return "";
  return [
    `TaskCenter 拒绝评估：${assessment.level}（${assessment.category}）— ${assessment.reason}`,
    `恢复：${assessment.recovery}`,
    `验证：${assessment.verification}`,
  ].join("\n");
}

// 落盘一条安全拒绝记录并立即评估；只接受分类码与 ID 字段，不写原始命令或错误正文。
export function recordGateDenial(path, input, now = Date.now()) {
  if (!path) throw new Error("gate denial path required");
  const at = new Date(Number.isFinite(now) ? now : Date.now()).toISOString();
  const record = {
    at,
    category: classifyGateDenial(input),
    source: ["hook", "cli"].includes(String(input?.source || "")) ? String(input.source) : "hook",
    session_id: sanitizeGateDenialId(input?.session_id),
    task_id: sanitizeGateDenialId(input?.task_id),
    run_id: sanitizeGateDenialId(input?.run_id),
    failure_kind: sanitizeGateDenialFailureKind(input?.failure_kind),
  };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  let events = readGateDenials(path);
  if (statSync(path).size > GATE_DENIAL_LOG_MAX_BYTES) {
    events = events.filter((item) => Date.parse(item.at || "") > now - GATE_DENIAL_WINDOW_MS).slice(-GATE_DENIAL_LOG_RETAINED);
    writeFileSync(path, `${events.map((item) => JSON.stringify(item)).join("\n")}\n`, { mode: 0o600 });
  }
  const assessment = evaluateGateDenials(events, { now: Number.isFinite(now) ? now : Date.now(), category: record.category });
  return { record, assessment };
}

export function buildGovernanceMetrics({ tasks = [], events = [], usageReport = null } = {}) {
  const visible = tasks.filter((task) => task.status !== "removed");
  const groups = {
    workflow_profile: groupMetrics(visible, events, (task) => task.workflowProfile || "legacy"),
    task_class: groupMetrics(visible, events, (task) => task.taskClass || "unclassified"),
    model: groupMetrics(visible, events, (task) => task.model || "unknown"),
  };
  const generatedAt = Date.parse(usageReport?.generatedAt || "");
  const windowDuration = Number(usageReport?.windows?.["24h"]?.durationMs || 86_400_000);
  const windowStart = Number.isFinite(generatedAt) ? generatedAt - windowDuration : -Infinity;
  const completed = visible.filter((task) => isCompleted(task) && timestampOf(task) >= windowStart);
  const windowEvents = events.filter((event) => eventTimestamp(event) >= windowStart);
  const touchedTaskIds = new Set(windowEvents.map((event) => event.task_id).filter(Boolean));
  const overallUsage = usageReport?.overall || {};
  const estimatedCredits = finiteOrNull(overallUsage.estimatedCredits);
  const creditsEstimation = ["complete", "partial", "unestimable"].includes(overallUsage.creditsEstimation)
    ? overallUsage.creditsEstimation
    : estimatedCredits === null ? "unestimable" : "complete";
  const continuations = number(overallUsage.modelContinuations);
  const attributionCoverage = buildAttributionCoverage(usageReport?.windows?.["24h"]);
  const diagnostics = buildDiagnosticMetrics(visible, windowStart);
  const reviews = buildReviewMetrics(visible);
  return {
    schemaVersion: "taskcenter-governance-metrics-v2",
    completedTasks: completed.length,
    creditsPerCompletedTask: estimatedCredits === null || !completed.length ? null : estimatedCredits / completed.length,
    creditsEstimation,
    modelContinuationsPerTask: completed.length ? continuations / completed.length : null,
    inputTokens: {
      average: number(overallUsage.input?.average),
      p50: number(overallUsage.input?.p50),
      p95: number(overallUsage.input?.p95),
    },
    taskCenterCallsPerTask: touchedTaskIds.size ? windowEvents.filter((event) => event.task_id).length / touchedTaskIds.size : 0,
    reworkRate: completed.length ? completed.filter(hasRework).length / completed.length : 0,
    durationMs: distribution(completed.map(durationMs).filter(Number.isFinite)),
    attributionCoverage,
    diagnostics,
    reviews,
    groups,
    comparisons: buildMatchedComparisons(groups, usageReport?.windows || []),
  };
}

function buildReviewMetrics(tasks) {
  const implementationTasks = tasks.filter((task) => !isIndependentReviewTask(task));
  const independentReviewTasks = tasks.filter(isIndependentReviewTask);
  const taskSummaries = implementationTasks.flatMap((task) => summarizeTaskReview(task));
  const cycles = taskSummaries.flatMap((item) => item.cycles.map((cycle) => ({ ...cycle, taskId: item.taskId })));
  const effectiveAttestations = implementationTasks.flatMap((task) => (task.reviewAttestations || []).filter((item) => item.effective_review !== false));
  const findings = effectiveAttestations.flatMap((item) => item.findings || []);
  const reviewedTaskSummaries = taskSummaries.filter((item) => item.reviewRounds > 0);
  const cycleTasks = new Set(taskSummaries.map((item) => item.taskId));
  const activeSamples = cycles.filter((item) => item.activeMs !== null);
  const phase = (value) => cycles.filter((item) => item.phase === value).length;
  return {
    taskRoles: { implementation: implementationTasks.length, independent_review: independentReviewTasks.length },
    coverage: {
      eligibleTasks: implementationTasks.length,
      tasksWithCycles: cycleTasks.size,
      cycleCoverage: implementationTasks.length ? cycleTasks.size / implementationTasks.length : null,
      cycles: cycles.length,
      cyclesWithActiveTime: activeSamples.length,
      activeTimeCoverage: cycles.length ? activeSamples.length / cycles.length : null,
      note: "缺少阶段事件或 active time 时显示数据不足，不推断为 0。",
    },
    funnel: {
      pending_review: phase("pending_review"), reviewing: phase("reviewing"), fixing: phase("fixing"),
      rereview: cycles.filter((item) => item.reviewScope === "incremental").length,
      approved: cycles.filter((item) => item.outcome === "approved").length,
    },
    rounds: {
      perTask: distribution(reviewedTaskSummaries.map((item) => item.reviewRounds)),
      firstPassRate: reviewedTaskSummaries.length ? reviewedTaskSummaries.filter((item) => item.firstPass).length / reviewedTaskSummaries.length : null,
      changesRequested: taskSummaries.reduce((sum, item) => sum + item.changesRequestedRounds, 0),
      full: cycles.filter((item) => item.reviewScope === "full").length,
      incremental: cycles.filter((item) => item.reviewScope === "incremental").length,
    },
    timeMs: {
      wait: distribution(cycles.map((item) => item.waitMs).filter(Number.isFinite)),
      reviewElapsed: distribution(cycles.map((item) => item.reviewElapsedMs).filter(Number.isFinite)),
      fixElapsed: distribution(cycles.map((item) => item.fixElapsedMs).filter(Number.isFinite)),
      verificationElapsed: distribution(cycles.map((item) => item.verificationElapsedMs).filter(Number.isFinite)),
      wall: distribution(cycles.map((item) => item.wallMs).filter(Number.isFinite)),
      active: distribution(cycles.map((item) => item.activeMs).filter(Number.isFinite)),
      wallToTaskRatio: distribution(taskSummaries.map((item) => item.reviewWallToTaskRatio).filter(Number.isFinite)),
    },
    findings: {
      total: findings.length,
      byCategory: countBy(findings, "category"), bySeverity: countBy(findings, "severity"), byValidity: countBy(findings, "validity"),
      validRatio: ratioOf(findings, "validity", "valid"), duplicateRatio: ratioOf(findings, "validity", "duplicate"), falsePositiveRatio: ratioOf(findings, "validity", "false_positive"),
    },
    waitReasons: countBy(cycles.filter((item) => item.waitReason).map((item) => ({ reason: item.waitReason })), "reason"),
    reviewLoopWarnings: taskSummaries.flatMap((item) => item.warnings),
    longTailTasks: taskSummaries.filter((item) => item.warnings.length).map((item) => ({ taskId: item.taskId, warnings: item.warnings.map((warning) => warning.type), reviewRounds: item.reviewRounds, reviewWallMs: item.reviewWallMs })),
    taskSummaries,
    note: "团队与流程诊断数据，不用于 reviewer、模型或个人排名，也不参与任务门禁。",
  };
}

function summarizeTaskReview(task) {
  const cycles = (task.reviewCycles || []).map(summarizeCycle);
  const reviews = (task.reviewAttestations || []).filter((item) => item.effective_review !== false);
  if (!cycles.length && !reviews.length) return [];
  const changesRequestedRounds = reviews.filter((item) => item.verdict === "changes_requested").length;
  const reviewWallMs = sumKnown(cycles.map((item) => item.wallMs));
  const taskWallMs = completedDurationMs(task);
  const reviewWallToTaskRatio = reviewWallMs !== null && Number.isFinite(taskWallMs) && taskWallMs > 0 ? reviewWallMs / taskWallMs : null;
  const warnings = [];
  const add = (type, cycleId = "", detail = "") => warnings.push({ taskId: task.id, type, cycleId, detail });
  if (changesRequestedRounds > 2) add("changes_requested_over_two", "", `${changesRequestedRounds}`);
  if (reviewWallToTaskRatio !== null && reviewWallToTaskRatio > 0.5) add("review_stage_ratio_high", "", `${reviewWallToTaskRatio}`);
  for (const cycle of cycles) {
    if (Number.isFinite(cycle.waitMs) && cycle.waitMs > numberOrZero(cycle.reviewElapsedMs) + numberOrZero(cycle.fixElapsedMs)) add("wait_exceeds_review_and_fix", cycle.cycleId);
    if (cycle.wallClockDistorted) add("wall_clock_distorted", cycle.cycleId, cycle.distortionReason);
  }
  const fullBySubject = groupCount(cycles.filter((item) => item.reviewScope === "full"), (item) => item.subjectKey);
  for (const [subjectKey, count] of fullBySubject) if (subjectKey && count > 1) add("repeated_full_review_same_subject", "", subjectKey);
  const fingerprints = reviews.flatMap((item) => item.findings || []).map((item) => item.fingerprint).filter(Boolean);
  for (const [fingerprint, count] of groupCount(fingerprints, (item) => item)) if (count > 1) add("repeated_finding", "", fingerprint);
  for (const review of (task.reviewAttestations || []).filter((item) => item.effective_review === false && item.duplicate_of_attestation_id)) add("duplicate_approved", review.cycle_id || "", review.id);
  return [{
    taskId: task.id, reviewRounds: reviews.length, firstPass: reviews.length > 0 && reviews[0].verdict === "approved",
    changesRequestedRounds, fullRounds: cycles.filter((item) => item.reviewScope === "full").length,
    incrementalRounds: cycles.filter((item) => item.reviewScope === "incremental").length,
    reviewWallMs, taskWallMs: Number.isFinite(taskWallMs) ? taskWallMs : null, reviewWallToTaskRatio, cycles, warnings,
  }];
}

function summarizeCycle(cycle) {
  const span = (start, end) => timestampSpan(cycle[start], cycle[end]);
  const wallEnd = cycle.verification_finished_at || cycle.fix_finished_at || cycle.review_finished_at;
  const activeValues = [cycle.review_active_ms, cycle.fix_active_ms, cycle.verification_active_ms];
  const activeMs = activeValues.some(Number.isFinite) ? activeValues.filter(Number.isFinite).reduce((sum, value) => sum + value, 0) : null;
  const rawWall = cycle.implementation_ready_at && wallEnd ? Math.max(0, Date.parse(wallEnd) - Date.parse(cycle.implementation_ready_at)) : null;
  const overnight = Number.isFinite(rawWall) && rawWall > 24 * 60 * 60_000;
  return {
    cycleId: cycle.cycle_id, cycleNumber: cycle.cycle_number, reviewScope: cycle.review_scope, phase: cycle.phase || "data_insufficient", outcome: cycle.outcome || "pending",
    subjectKey: subjectKey(cycle.subject_ref), waitReason: cycle.wait_reason || "",
    waitMs: span("review_requested_at", "review_started_at"), reviewElapsedMs: span("review_started_at", "review_finished_at"),
    fixElapsedMs: span("fix_started_at", "fix_finished_at"), verificationElapsedMs: cycle.verification_finished_at ? Math.max(0, Date.parse(cycle.verification_finished_at) - Date.parse(cycle.fix_finished_at || cycle.review_finished_at || "")) : null,
    wallMs: Number.isFinite(rawWall) ? rawWall : null, activeMs,
    wallClockDistorted: overnight || !["approved", "rejected", "cancelled"].includes(cycle.outcome || "pending"),
    distortionReason: overnight ? "overnight_over_24h" : !["approved", "rejected", "cancelled"].includes(cycle.outcome || "pending") ? "cycle_in_progress" : "",
  };
}

function buildAttributionCoverage(window) {
  const rows = Array.isArray(window?.byTask) ? window.byTask : [];
  const totalEvents = number(window?.totals?.count);
  const totalInputTokens = number(window?.totals?.usage?.input);
  const unattributed = rows.find((item) => item.id === "unattributed") || {};
  const unattributedEvents = number(unattributed.count);
  const unattributedInputTokens = number(unattributed.usage?.input);
  const attributedEvents = rows.length ? Math.max(0, totalEvents - unattributedEvents) : 0;
  const attributedInputTokens = rows.length ? Math.max(0, totalInputTokens - unattributedInputTokens) : 0;
  return {
    eventRatio: totalEvents ? attributedEvents / totalEvents : 0,
    inputTokenRatio: totalInputTokens ? attributedInputTokens / totalInputTokens : 0,
    attributedEvents,
    totalEvents,
    note: "仅反映 Token 事件能否唯一归属 TaskCenter task，不作为个人或模型绩效指标。",
  };
}

function buildDiagnosticMetrics(tasks, windowStart) {
  const observations = tasks.flatMap((task) => (task.diagnosticObservations || []).map((item) => ({ ...item, taskId: task.id })))
    .filter((item) => (Date.parse(item.observed_at || "") || -Infinity) >= windowStart);
  const resolved = observations.filter((item) => item.outcome === "resolved");
  const rootCauseDurations = resolved.map((item) => Date.parse(item.root_cause_at || "") - Date.parse(item.started_at || "")).filter((value) => Number.isFinite(value) && value >= 0);
  return {
    cases: observations.length,
    resolvedCases: resolved.length,
    medianTimeToRootCauseMs: distribution(rootCauseDurations).p50,
    averageHypotheses: average(observations.map((item) => number(item.hypothesis_count))),
    averageFailedFixes: average(observations.map((item) => number(item.failed_fix_count))),
    averageRollbacks: average(observations.map((item) => number(item.rollback_count))),
    freshVerificationPassRate: resolved.length ? resolved.filter((item) => item.fresh_verification === "passed").length / resolved.length : 0,
    note: "观察性诊断复盘指标，仅用于寻找流程瓶颈和检验改进，不参与绩效、门禁或自动路由。",
  };
}

function groupMetrics(tasks, events, keyOf) {
  const groups = new Map();
  for (const task of tasks) {
    const key = keyOf(task);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  return [...groups.entries()].map(([key, values]) => {
    const completed = values.filter(isCompleted);
    const taskIds = new Set(values.map((task) => task.id));
    return {
      key,
      tasks: values.length,
      completed: completed.length,
      taskCenterCallsPerTask: values.length ? events.filter((event) => taskIds.has(event.task_id)).length / values.length : 0,
      reworkRate: completed.length ? completed.filter(hasRework).length / completed.length : 0,
      durationMs: distribution(completed.map(durationMs).filter(Number.isFinite)),
    };
  }).sort((left, right) => right.tasks - left.tasks || left.key.localeCompare(right.key));
}

function buildMatchedComparisons(groups, windows) {
  const windowList = Array.isArray(windows) ? windows : Object.values(windows || {});
  return {
    strategy: "matched_task_type_or_alternating_windows",
    note: "优先按 workflow_profile、task_class、model 匹配；窗口比较使用全部可用交替窗口，不只比较相邻两个五小时窗口。",
    cohorts: Object.fromEntries(Object.entries(groups).map(([dimension, values]) => [dimension, values.filter((item) => item.tasks >= 1)])),
    windows: windowList.map((window) => ({ id: window.id || window.window, durationMs: window.durationMs, generatedAt: window.generatedAt })).filter((item) => item.id),
  };
}

function isCompleted(task) { return task.status === "verified" || task.acceptanceStatus === "accepted" || (task.acceptanceRecords || []).at(-1)?.outcome === "accepted"; }
function isIndependentReviewTask(task) { return ["ocr", "ocr_review", "independent_review"].includes(task.routing?.taskClass || task.taskClass); }
function hasRework(task) {
  return (task.requirementResults || []).some((item) => item.status === "failed")
    || (task.reviewAttestations || []).some((item) => ["changes_requested", "rejected"].includes(item.verdict));
}
function durationMs(task) {
  return Number.isFinite(Number(task.activeDurationMs)) && Number(task.activeDurationMs) > 0 ? Number(task.activeDurationMs) : NaN;
}
function completedDurationMs(task) {
  if (!isCompleted(task)) return NaN;
  const end = Date.parse(task.actualAt || task.acceptanceRecords?.at(-1)?.observed_at || "");
  const start = Date.parse(task.firstStartedAt || task.startedAt || task.createdAt || "");
  return Number.isFinite(end) && Number.isFinite(start) ? Math.max(0, end - start) : NaN;
}
function timestampOf(task) { return Date.parse(task.actualAt || task.updatedAt || task.createdAt || "") || -Infinity; }
function eventTimestamp(event) { return Date.parse(event.recorded_at || event.recordedAt || event.created_at || event.createdAt || "") || -Infinity; }
function distribution(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return { average: sorted.length ? average(sorted) : null, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), sampleCount: sorted.length, status: sorted.length ? "available" : "data_insufficient" };
}
function average(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function percentile(values, quantile) {
  if (!values.length) return null;
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1))];
}
function number(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function finiteOrNull(value) { return value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null; }
function numberOrZero(value) { return Number.isFinite(value) ? value : 0; }
function timestampSpan(start, end) {
  const from = Date.parse(start || ""), to = Date.parse(end || "");
  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? to - from : null;
}
function sumKnown(values) { const known = values.filter(Number.isFinite); return known.length ? known.reduce((sum, value) => sum + value, 0) : null; }
function subjectKey(subject) { return subject ? `${subject.type}:${subject.value || ""}:${subject.repository || ""}:${subject.branch || ""}` : ""; }
function groupCount(values, keyOf) { const map = new Map(); for (const value of values) { const key = keyOf(value); map.set(key, (map.get(key) || 0) + 1); } return map; }
function countBy(values, field) { return Object.fromEntries([...groupCount(values, (item) => item[field] || "unknown").entries()].sort(([left], [right]) => left.localeCompare(right))); }
function ratioOf(values, field, expected) { return values.length ? values.filter((item) => item[field] === expected).length / values.length : null; }
