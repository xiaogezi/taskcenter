"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { groupSessions, mergeTaskSessions, sessionIdsForGroup, filterThreadsWithTasks } from "./session-groups.mjs";
import { resolveTaskSessionDisplay, taskMatchesSession } from "./task-session-display.mjs";
import { detectSparkRoutingAdvisory, hasTaskEventDetails, taskEventStatus, taskEventSummary } from "./task-event-display.mjs";
import { matchesTaskLifecycleFilter, taskClosureReasonLabels, taskLifecycleFilterCounts, taskLifecycleFilters } from "./task-lifecycle-filter.mjs";
import { taskTimeState } from "./task-time-state.mjs";

type SessionGroup = Thread & {
  id: string;
  groupKey: string;
  sessionIds: string[];
  sessionCount: number;
};

type Thread = {
  id?: string;
  title?: string;
  cwd?: string;
  messageCount?: number;
  requirementCount?: number;
  requirementsCount?: number;
  lastActivity?: string;
  updatedAt?: string;
  sessionIds?: string[];
  sessionCount?: number;
  groupKey?: string;
  sessionSource?: "codex" | "task-ledger";
};

type SessionSelection = { mode: "allowlist"; threadIds: string[] };
type ReflectionProposal = {
  id: string;
  kind: string;
  executionPolicy?: "agent_task" | "manual_only";
  title: string;
  summary: string;
  recommendation: string;
  risk: string;
  status: "proposed" | "accepted" | "rejected" | "resolved";
  evidence: Array<{ metric: string; count: number; taskIds: string[] }>;
  generatedAt: string;
  decidedAt?: string;
  resolvedAt?: string;
  executions?: ReflectionExecution[];
};
type ReflectionExecution = {
  id: string;
  requestId: string;
  taskId: string;
  dispatchId: string;
  mode: "new_session" | "existing_session";
  sessionId: string;
  status: string;
  taskStatus?: TaskStatus | "";
  dispatchStatus?: string;
  dispatchError?: string;
  createdAt: string;
};
type ReflectionState = {
  version: number;
  generatedAt: string;
  dataBoundary: { sessionMode: "allowlist"; allowedSessionCount: number; taskCount: number };
  proposals: ReflectionProposal[];
};
type TaskStatus = "planned" | "in_progress" | "blocked" | "done_claimed" | "verified" | "cancelled";
type TaskRecord = {
  id: string;
  contextTaskId?: string;
  sessionId: string;
  agent?: "codex" | "claude" | "workbuddy" | "unknown";
  provider?: string;
  model?: string;
  workspace?: string;
  title: string;
  goal: string;
  requirementId?: string;
  status: TaskStatus;
  priority?: string;
  currentStep?: string;
  nextAction?: string;
  blocker?: string;
  assumptions?: string[];
  risks?: string[];
  tradeoffs?: string[];
  openQuestions?: string[];
  retrospective?: string;
  changedFiles?: string[];
  tests?: string[];
  evidence?: string[];
  updatedAt?: string;
  startedAt?: string;
  firstStartedAt?: string;
  dueAt?: string;
  expectedAt?: string;
  estimatedEffortMs?: number;
  timingModelVersion?: string;
  activeDurationMs?: number;
  blockedDurationMs?: number;
  activeStartedAt?: string;
  blockedStartedAt?: string;
  estimateHistory?: Array<{ dueAt?: string; previousDueAt?: string; estimatedEffortMs?: number | null; previousEstimatedEffortMs?: number | null; reason?: string; recordedAt?: string }>;
  actualAt?: string;
  archivedAt?: string;
  reviewReason?: string;
  reviewedAt?: string;
  toolCalls?: Record<string, number>;
  routing?: {
    orchestratorModel?: string;
    selectedExecutorModel?: string;
    dispatchChannel?: string;
  };
  routingHistory?: {
    action?: string;
    orchestratorModel?: string;
    selectedExecutorModel?: string;
    preferredExecutorModel?: string;
    reason?: string;
    dispatchChannel?: string;
    outcome?: string;
    recordedAt?: string;
  }[];
  routingRecordedAt?: string;
  contractVersion?: "legacy" | "v2";
  currentRevision?: string;
  currentSubject?: { type: string; value?: string; repository?: string; branch?: string; observed_at: string } | null;
  verificationStatus?: "not_required" | "pending" | "passed" | "failed" | "stale";
  reviewStatus?: "not_required" | "pending" | "passed" | "changes_requested" | "rejected" | "stale";
  acceptanceStatus?: "pending" | "ready" | "accepted" | "rejected" | "stale";
  completionReadiness?: { ready: boolean; completionClaim?: { allowed: boolean; status: "ready" | "blocked"; blockingReasons: string[] }; reasons: string[]; missingRequirements: string[]; failedRequirements: string[]; staleEvidence: string[]; unresolvedFindings: string[]; currentSubject?: { type: string; value?: string } | null };
  cliRuns?: Array<{
    id: string;
    status: string;
    delegateSessionId?: string;
    executorModel?: string;
    scope?: string[];
    toolCalls?: Record<string, number>;
    completedAt?: string;
  }>;
};

type SessionStatus = {
  sessionId: string;
  agent: "codex" | "claude" | "workbuddy" | "unknown";
  provider: string;
  model: string;
  workspace?: string;
  registeredAt: string;
  lastSeenAt: string;
  status: "registered" | "unregistered";
  reason: string;
  taskCount: number;
  lastTaskAt: string;
};
type RoutingHealth = { model: string; state: "closed" | "open" | "half_open"; consecutive_failures: number; active_executors: number; concurrency_limit: number; retry_after_at?: string | null };
type HealthState = { ok: boolean; dashboard?: { generatedAt?: string; readable?: boolean }; watcher?: { healthy?: boolean; updatedAt?: string }; routing?: { models?: RoutingHealth[] } };

type Dashboard = {
  generatedAt?: string;
  source?: {
    mode?: string;
    threadCount?: number;
    messageCount?: number;
    sessionSelection?: SessionSelection;
    availableThreads?: Thread[];
  };
  threads?: Thread[];
};
type MetricDistribution = { average: number | null; p50: number | null; p95: number | null; sampleCount: number; status: "available" | "data_insufficient" };
type GovernanceMetrics = {
  completedTasks: number;
  creditsPerCompletedTask: number | null;
  creditsEstimation: "complete" | "partial" | "unestimable";
  modelContinuationsPerTask: number | null;
  inputTokens: { average: number; p50: number; p95: number };
  taskCenterCallsPerTask: number;
  reworkRate: number;
  durationMs: MetricDistribution;
  attributionCoverage?: { eventRatio: number; inputTokenRatio: number; attributedEvents: number; totalEvents: number; note: string };
  diagnostics?: { cases: number; resolvedCases: number; medianTimeToRootCauseMs: number; averageHypotheses: number; averageFailedFixes: number; averageRollbacks: number; freshVerificationPassRate: number; note: string };
  reviews?: {
    taskRoles: { implementation: number; independent_review: number };
    coverage: { eligibleTasks: number; tasksWithCycles: number; cycleCoverage: number | null; cycles: number; cyclesWithActiveTime: number; activeTimeCoverage: number | null; note: string };
    funnel: { pending_review: number; reviewing: number; fixing: number; rereview: number; approved: number };
    rounds: { perTask: MetricDistribution; firstPassRate: number | null; changesRequested: number; full: number; incremental: number };
    timeMs: { wait: MetricDistribution; reviewElapsed: MetricDistribution; fixElapsed: MetricDistribution; verificationElapsed: MetricDistribution; wall: MetricDistribution; active: MetricDistribution; wallToTaskRatio: MetricDistribution };
    findings: { total: number; byCategory: Record<string, number>; bySeverity: Record<string, number>; byValidity: Record<string, number>; validRatio: number | null; duplicateRatio: number | null; falsePositiveRatio: number | null };
    waitReasons: Record<string, number>;
    reviewLoopWarnings: Array<{ taskId: string; type: string; cycleId?: string; detail?: string }>;
    longTailTasks: Array<{ taskId: string; warnings: string[]; reviewRounds: number; reviewWallMs: number | null }>;
    note: string;
  };
  comparisons?: { strategy?: string; note?: string };
  snapshotStatus?: { stale: boolean; ageMs: number | null; lastRefreshError?: string; updatedAt?: string };
};

// 控制服务 URL：优先使用环境变量，默认 IPv4 localhost
const controlServerUrl = typeof process !== "undefined" && process.env?.TASKCENTER_CONTROL_URL
  ? process.env.TASKCENTER_CONTROL_URL
  : "http://127.0.0.1:3001";

async function fetchTaskSummaries() {
  const pageSize = 200;
  const firstResponse = await fetch(`${controlServerUrl}/tasks?view=summary&page=1&page_size=${pageSize}`);
  if (!firstResponse.ok) throw new Error("任务摘要加载失败");
  const first = await firstResponse.json() as { tasks?: TaskRecord[]; totalPages?: number };
  const totalPages = Math.max(1, Number(first.totalPages || 1));
  const remaining = await Promise.all(Array.from({ length: totalPages - 1 }, async (_, index) => {
    const response = await fetch(`${controlServerUrl}/tasks?view=summary&page=${index + 2}&page_size=${pageSize}`);
    if (!response.ok) throw new Error("任务摘要分页加载失败");
    return response.json() as Promise<{ tasks?: TaskRecord[] }>;
  }));
  return { tasks: [...(first.tasks || []), ...remaining.flatMap((page) => page.tasks || [])] };
}

function asText(value: unknown, fallback = "暂无记录") {
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallback;
}

function normalizeDate(value?: string) {
  if (!value) return "未记录时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Shanghai",
  }).format(date);
}

async function copyToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement("textarea");
  input.value = text;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("浏览器拒绝访问剪贴板");
}

export default function Home() {
  const [selectedThread, setSelectedThread] = useState("全部任务");
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState("");
  const refreshInFlight = useRef(false);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [sessionPickerKind, setSessionPickerKind] = useState<"read" | "gate">("read");
  const [pickerThreadIds, setPickerThreadIds] = useState<string[]>([]);
  const [gateAllowlistIds, setGateAllowlistIds] = useState<string[]>([]);
  const [gateSessionSavingId, setGateSessionSavingId] = useState("");
  const [isSavingSessionSelection, setIsSavingSessionSelection] = useState(false);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [dashboard, setDashboard] = useState<Dashboard>({ source: {}, threads: [] });
  const [liveAvailableThreads, setLiveAvailableThreads] = useState<Thread[]>([]);
  const [sessionStatuses, setSessionStatuses] = useState<Record<string, SessionStatus>>({});
  const [health, setHealth] = useState<HealthState>({ ok: false });
  const [reflections, setReflections] = useState<ReflectionState>({ version: 1, generatedAt: "", dataBoundary: { sessionMode: "allowlist", allowedSessionCount: 0, taskCount: 0 }, proposals: [] });
  const [governanceMetrics, setGovernanceMetrics] = useState<GovernanceMetrics | null>(null);

  const refreshLiveData = async (manual = false) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    if (manual) {
      setIsRefreshing(true);
      setRefreshMessage("");
    }
    try {
      const [dashboardResponse, tasksPayload, sessionStatusResponse, threadsResponse, reflectionsResponse, gateAllowlistResponse, governanceResponse] = await Promise.all([
        fetch(`${controlServerUrl}/dashboard`),
        fetchTaskSummaries(),
        fetch(`${controlServerUrl}/session-status`),
        fetch(`${controlServerUrl}/session-selection`),
        fetch(`${controlServerUrl}/reflections`),
        fetch(`${controlServerUrl}/gate-session-allowlist`),
        fetch(`${controlServerUrl}/governance-metrics`),
      ]);
      const healthResponse = await fetch(`${controlServerUrl}/health`);
      if (!healthResponse.ok) throw new Error("本地控制服务健康检查失败");
      setHealth(await healthResponse.json() as HealthState);
      if (!dashboardResponse.ok || !sessionStatusResponse.ok || !threadsResponse.ok || !reflectionsResponse.ok || !gateAllowlistResponse.ok || !governanceResponse.ok) {
        throw new Error("本地控制服务返回异常");
      }
      const [dashboardPayload, sessionStatusPayload, threadsPayload, reflectionsPayload, gateAllowlistPayload, governancePayload] = await Promise.all([
        dashboardResponse.json() as Promise<Dashboard>,
        sessionStatusResponse.json() as Promise<{ sessions?: SessionStatus[] }>,
        threadsResponse.json() as Promise<{ availableThreads?: Thread[] }>,
        reflectionsResponse.json() as Promise<ReflectionState>,
        gateAllowlistResponse.json() as Promise<{ selection?: SessionSelection }>,
        governanceResponse.json() as Promise<GovernanceMetrics>,
      ]);
      setDashboard(dashboardPayload);
      setTasks(tasksPayload.tasks ?? []);
      setSessionStatuses(Object.fromEntries((sessionStatusPayload.sessions ?? []).map((session) => [session.sessionId, session])));
      setLiveAvailableThreads(threadsPayload.availableThreads ?? []);
      setReflections(reflectionsPayload);
      setGateAllowlistIds(gateAllowlistPayload.selection?.threadIds ?? []);
      setGovernanceMetrics(governancePayload);
      if (manual) setRefreshMessage(`已刷新 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`);
    } catch (error) {
      setHealth({ ok: false });
      if (manual) setRefreshMessage(error instanceof Error ? error.message : "刷新失败，请检查本地控制服务");
    } finally {
      refreshInFlight.current = false;
      if (manual) setIsRefreshing(false);
    }
  };

  useEffect(() => {
    const initial = window.setTimeout(() => void refreshLiveData(), 0);
    const timer = window.setInterval(() => void refreshLiveData(), 5_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, []);

  const dashboardThreads = dashboard.source?.availableThreads ?? dashboard.threads ?? [];
  const selectionThreads = liveAvailableThreads.length > 0 ? liveAvailableThreads : dashboardThreads;
  const allowlistIds = dashboard.source?.sessionSelection?.threadIds ?? [];
  const whitelistedThreads = selectionThreads.filter((thread) => allowlistIds.includes(asText(thread.id, "")));
  const pickerGroups = useMemo(() => groupSessions(selectionThreads), [selectionThreads]);
  const taskBackedThreads = mergeTaskSessions(whitelistedThreads, tasks, selectionThreads);
  const threadsWithTasks = filterThreadsWithTasks(taskBackedThreads, tasks);
  const selectionGroups = useMemo(() => groupSessions(threadsWithTasks), [threadsWithTasks]);
  const mergedThreads = selectionGroups;

  // 当前选中会话被过滤后回退到全部任务
  useEffect(() => {
    if (selectedThread !== "全部任务" && !mergedThreads.some((thread) => thread.id === selectedThread)) {
      const timer = window.setTimeout(() => setSelectedThread("全部任务"), 0);
      return () => window.clearTimeout(timer);
    }
  }, [mergedThreads, selectedThread]);

  const scanCodexSessions = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    setSyncMessage("");
    try {
      const response = await fetch(`${controlServerUrl}/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-TaskCenter-Action": "delegate",
        },
        body: "{}",
      });
      const payload = await response.json() as {
        threadCount?: number;
        messageCount?: number;
        message?: string;
        error?: string;
      };
      if (!response.ok && response.status !== 202) {
        throw new Error(payload.error || "扫描失败，请确认本地控制服务正在运行。");
      }
      setSyncMessage(payload.message || `已扫描 ${payload.threadCount ?? 0} 个会话，${payload.messageCount ?? 0} 条用户消息。`);
      void refreshLiveData();
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : "扫描失败，请稍后重试。");
    } finally {
      setIsSyncing(false);
    }
  };
  const selectedSessionIds = allowlistIds;
  const openSessionPicker = () => {
    setSessionPickerKind("read");
    setPickerThreadIds(selectedSessionIds.filter(Boolean));
    setShowSessionPicker(true);
  };
  const openGateSessionPicker = () => {
    setSessionPickerKind("gate");
    setPickerThreadIds(gateAllowlistIds.filter(Boolean));
    setShowSessionPicker(true);
  };
  const saveSessionSelection = async (threadIds: string[]) => {
    setIsSavingSessionSelection(true);
    setSyncMessage("");
    try {
      const response = await fetch(`${controlServerUrl}/session-selection`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-TaskCenter-Action": "delegate" },
        body: JSON.stringify({ mode: "allowlist", threadIds }),
      });
      const payload = await response.json() as { threadCount?: number; error?: string };
      if (!response.ok) throw new Error(payload.error || "会话范围保存失败。");
      setShowSessionPicker(false);
      setSyncMessage(`已保存会话范围，当前纳入 ${payload.threadCount ?? threadIds.length} 个会话。`);
      void refreshLiveData();
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : "会话范围保存失败。");
    } finally {
      setIsSavingSessionSelection(false);
    }
  };
  const toggleGateSession = async (sessionId: string, enabled: boolean) => {
    if (gateSessionSavingId) return;
    setGateSessionSavingId(sessionId);
    setSyncMessage("");
    try {
      const response = await fetch(`${controlServerUrl}/gate-session-allowlist/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-TaskCenter-Action": "delegate" },
        body: JSON.stringify({ session_id: sessionId, enabled }),
      });
      const payload = await response.json() as { selection?: SessionSelection; error?: string };
      if (!response.ok) throw new Error(payload.error || "Session 门禁豁免更新失败。");
      setGateAllowlistIds(payload.selection?.threadIds ?? []);
      setSyncMessage(enabled ? "当前 Session 已加入任务门禁豁免。" : "当前 Session 已退出任务门禁豁免。");
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : "Session 门禁豁免更新失败。");
    } finally {
      setGateSessionSavingId("");
    }
  };
  const removeSessionGroup = (sessionIds: string[]) => {
    void saveSessionSelection(selectedSessionIds.filter((id) => !sessionIds.includes(id)));
  };
  const selectThread = (threadId: string) => setSelectedThread(threadId);

  return (
    <main className="app-shell">
      <div className="grain" aria-hidden="true" />
      <header className="masthead">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <span>T</span>
            <span>C</span>
          </div>
          <div>
            <p className="eyebrow">LOCAL / CODEX MEMORY</p>
          <p className="brand-name">TASK<span>CENTER</span></p>
          </div>
        </div>
        <div className="masthead-note">
          <span className="live-dot" />
          <span>本地会话看板</span>
          <span className="separator">·</span>
          <span>自动同步看板</span>
        </div>
      </header>

      <section className="hero-section">
        <div className="hero-copy">
          <p className="eyebrow orange">任务记录台 / {new Date().getFullYear()}</p>
          <h1>把每次执行，<em>变成可追踪的任务记录。</em></h1>
          <p className="hero-description">
            以 Session 主动登记的任务账本为唯一工作记录，跟踪计划、进度、证据与验收状态。
          </p>
        </div>
        <div className="hero-stamp">
          <span>READ</span>
          <strong>ONLY</strong>
          <small>LOCAL JSONL</small>
        </div>
      </section>

      <div className="content-layout">
        <aside className="thread-rail">
          <div className="rail-heading">
            <div>
              <p className="eyebrow">SOURCES</p>
              <h2>Codex 任务</h2>
            </div>
            <div className="rail-actions">
              <button className="manage-sessions-button" onClick={openSessionPicker}>
                读取白名单
              </button>
              <button className="manage-sessions-button" onClick={openGateSessionPicker}>
                门禁豁免{gateAllowlistIds.length ? ` · ${gateAllowlistIds.length}` : ""}
              </button>
              <button className="scan-button" onClick={scanCodexSessions} disabled={isSyncing}>
                {isSyncing ? "扫描中…" : "手动扫描"}
              </button>
              <button className="refresh-button" onClick={() => void refreshLiveData(true)} disabled={isRefreshing}>
                {isRefreshing ? "刷新中…" : "刷新数据"}
              </button>
              <span className="count-pill" aria-label={`当前 ${mergedThreads.length} 个会话`}>
                <strong>{mergedThreads.length}</strong><small>会话</small>
              </span>
            </div>
          </div>
          {syncMessage && <p className="sync-message" role="status">{syncMessage}</p>}
          {refreshMessage && <p className="refresh-message" role="status" aria-live="polite">{refreshMessage}</p>}
          {showSessionPicker && (
            <section className="session-picker" aria-label="管理允许读取的会话白名单">
              <div className="session-picker-heading">
                <strong>{sessionPickerKind === "read" ? "Session 内容读取白名单" : "Session Hook 门禁豁免白名单"}</strong>
                <button onClick={() => setShowSessionPicker(false)}>关闭</button>
              </div>
              <p>{sessionPickerKind === "read"
                ? "只有勾选的 Session 才会读取 JSONL 正文。未勾选项仅使用本地索引中的 ID、标题和文件时间供你选择，不删除原始文件。"
                : "点击单个 Session 的加入或退出按钮会立即生效，不需要再次保存。加入后，非只读工具调用不再强制登记活跃任务；命令安全检查仍然生效。"}</p>
              <div className="session-picker-list">
                {sessionPickerKind === "read" ? pickerGroups.map((group) => {
                  const sessionIds = group.sessionIds;
                  const selectedCount = sessionIds.filter((id) => pickerThreadIds.includes(id)).length;
                  const checked = sessionIds.length > 0 && selectedCount === sessionIds.length;
                  return (
                    <label className="session-option" key={group.id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => setPickerThreadIds((current) => checked
                          ? current.filter((item) => !sessionIds.includes(item))
                          : [...current, ...sessionIds.filter((id) => !current.includes(id))])}
                      />
                      <span><strong>{asText(group.title, "未命名会话")}</strong><small>{group.sessionCount} 个会话 · 已选 {selectedCount}</small></span>
                    </label>
                  );
                }) : selectionThreads.map((thread) => {
                  const sessionId = asText(thread.id, "");
                  if (!sessionId) return null;
                  const exempt = gateAllowlistIds.includes(sessionId);
                  const saving = gateSessionSavingId === sessionId;
                  return (
                    <div className="session-option session-option-immediate" key={sessionId}>
                      <span>
                        <strong>{asText(thread.title, "未命名会话")}</strong>
                        <small>{sessionId.slice(0, 8)}… · {exempt ? "已豁免任务登记" : "需要活跃任务"}</small>
                      </span>
                      <button
                        className={exempt ? "gate-exit-button" : "gate-join-button"}
                        onClick={() => void toggleGateSession(sessionId, !exempt)}
                        disabled={Boolean(gateSessionSavingId)}
                        aria-label={`${exempt ? "退出" : "加入"} ${asText(thread.title, sessionId)} 的任务门禁豁免`}
                      >
                        {saving ? "处理中…" : exempt ? "退出豁免" : "加入豁免"}
                      </button>
                    </div>
                  );
                })}
              </div>
              {sessionPickerKind === "read" && (
                <div className="session-picker-actions">
                  <button onClick={() => setPickerThreadIds(selectionThreads.map((thread) => asText(thread.id, "")).filter(Boolean))}>全选</button>
                  <button onClick={() => setPickerThreadIds([])}>清空</button>
                  <button className="session-save-button" onClick={() => void saveSessionSelection(pickerThreadIds)} disabled={isSavingSessionSelection}>
                    {isSavingSessionSelection ? "保存中…" : `保存（${pickerThreadIds.length}）`}
                  </button>
                </div>
              )}
            </section>
          )}
          <button
            className={`thread-item ${selectedThread === "全部任务" ? "selected" : ""}`}
            onClick={() => selectThread("全部任务")}
          >
            <span className="thread-number">00</span>
            <span className="thread-content">
              <strong>全部任务</strong>
              <small>{tasks.length} 条任务记录</small>
            </span>
            <span className="thread-arrow">↗</span>
          </button>
          {mergedThreads.map((thread, index) => {
            const id = asText(thread.id, `thread-${index}`);
            const sessionIds = thread.sessionIds ?? [id];
            const registeredSession = sessionIds.map((sessionId) => sessionStatuses[sessionId]).find((session) => session?.status === "registered");
            const sessionStatus = registeredSession ?? sessionIds.map((sessionId) => sessionStatuses[sessionId]).find(Boolean);
            const threadCount = tasks.filter((task) => sessionIds.includes(task.sessionId)).length;
            return (
              <div className="thread-row" key={id}>
                <button
                  className={`thread-item ${selectedThread === id ? "selected" : ""}`}
                  onClick={() => selectThread(id)}
                >
                <span className="thread-number">{String(index + 1).padStart(2, "0")}</span>
                <span className="thread-content">
                  <strong>{asText(thread.title, "未命名任务")}</strong>
                  <small>
                    {threadCount} 条任务 · {normalizeDate(thread.updatedAt ?? thread.lastActivity)} · {" "}
                    <span className={`session-health session-health-${sessionStatus?.status ?? "unknown"}`}>
                      {sessionStatus?.status === "registered" ? `${sessionStatus.agent} 已登记` : "未登记"}
                    </span>
                  </small>
                </span>
                <span className="thread-arrow">↗</span>
                </button>
                <button
                  className="thread-remove-button"
                  onClick={() => removeSessionGroup(thread.sessionIds ?? [id])}
                  disabled={isSavingSessionSelection || thread.sessionSource === "task-ledger"}
                  title={thread.sessionSource === "task-ledger" ? "该 Session 来自任务登记，不属于 Codex 扫描范围" : "移除会话"}
                >
                  {thread.sessionSource === "task-ledger" ? "已登记" : "移除"}
                </button>
              </div>
            );
          })}
          {!mergedThreads.length && <div className="empty-rail">等待第一次 Codex 会话同步</div>}
          <div className="privacy-note">
            <span className="lock-icon">⌁</span>
            <p><strong>本地隐私边界</strong>只读取会话 JSONL，不读取认证文件，不上传远端。</p>
          </div>
        </aside>

        <section className="board-area">
          <GovernancePanel metrics={governanceMetrics} />
          <TaskLedger
            tasks={tasks}
            availableThreads={mergedThreads}
            sessionGroups={mergedThreads}
            selectedSessionId={selectedThread}
            sessionStatuses={sessionStatuses}
            serviceHealthy={health.ok && health.watcher?.healthy !== false}
            routingModels={health.routing?.models ?? []}
            onTaskUpdated={(updatedTask) => {
              setTasks((current) => current.map((task) => task.id === updatedTask.id ? updatedTask : task));
            }}
          />
          <ReflectionPanel
            reflections={reflections}
            availableThreads={selectionThreads}
            onChange={setReflections}
            onExecuted={() => void refreshLiveData()}
            onConfigureAllowlist={openSessionPicker}
          />
        </section>
      </div>

      <footer className="footer-bar">
        <span>TaskCenter · 独立项目管理工具</span>
        <span>最近同步：{normalizeDate(dashboard.generatedAt)}</span>
        <span>源：{dashboard.source?.mode ?? "read-only local JSONL"}</span>
      </footer>
    </main>
  );
}

function GovernancePanel({ metrics }: { metrics: GovernanceMetrics | null }) {
  if (!metrics) return null;
  const number = (value: number | null, digits = 1) => value === null ? "不可估算" : value.toLocaleString("zh-CN", { maximumFractionDigits: digits });
  const duration = (value: number | null | undefined) => value === null || value === undefined ? "数据不足" : `${Math.round(value / 60_000)} 分钟`;
  const ratio = (value: number | null | undefined) => value === null || value === undefined ? "数据不足" : `${(value * 100).toFixed(1)}%`;
  const reviews = metrics.reviews;
  return (
    <section className="governance-panel" aria-labelledby="governance-title">
      <header className="governance-heading">
        <p className="eyebrow orange">GOVERNANCE PILOT</p>
        <h2 id="governance-title">用量与交付效率</h2>
      </header>
      {metrics.snapshotStatus?.stale && <p className="session-health-bar unhealthy" role="status">指标快照暂时陈旧，任务与门禁服务仍正常；最近错误：{metrics.snapshotStatus.lastRefreshError || "后台指标尚未完成刷新"}</p>}
      <div className="metrics-grid governance-metrics-grid">
        <article className="metric-card accent-orange"><p>CREDITS / 完成任务</p><strong className="metric-value">{number(metrics.creditsPerCompletedTask, 3)}</strong><span>{metrics.creditsEstimation === "complete" ? "按已配置官方费率估算" : metrics.creditsEstimation === "partial" ? "部分模型缺少官方费率" : "缺少官方费率不套用其他模型"}</span></article>
        <article className="metric-card accent-cyan"><p>模型续调 / 任务</p><strong className="metric-value">{number(metrics.modelContinuationsPerTask)}</strong><span>完成任务 {metrics.completedTasks} 条</span></article>
        <article className="metric-card accent-lime"><p>INPUT TOKENS</p><strong className="metric-value">{number(metrics.inputTokens.p50, 0)}</strong><span>均值 {number(metrics.inputTokens.average, 0)} · P95 {number(metrics.inputTokens.p95, 0)}</span></article>
        <article className="metric-card"><p>TASKCENTER 往返 / 任务</p><strong className="metric-value">{number(metrics.taskCenterCallsPerTask)}</strong><span>返工率 {(metrics.reworkRate * 100).toFixed(1)}% · P50 耗时 {duration(metrics.durationMs.p50)}</span></article>
        <article className="metric-card"><p>TOKEN 任务归属率</p><strong className="metric-value">{metrics.attributionCoverage ? `${(metrics.attributionCoverage.inputTokenRatio * 100).toFixed(1)}%` : "暂无"}</strong><span>{metrics.attributionCoverage ? `事件归属 ${(metrics.attributionCoverage.eventRatio * 100).toFixed(1)}% · 仅作数据质量检查` : "等待新版指标快照"}</span></article>
        <article className="metric-card"><p>调试案例观察</p><strong className="metric-value">{metrics.diagnostics ? number(metrics.diagnostics.cases, 0) : "暂无"}</strong><span>{metrics.diagnostics ? `已解决 ${number(metrics.diagnostics.resolvedCases, 0)} · 根因 P50 ${duration(metrics.diagnostics.medianTimeToRootCauseMs)}` : "等待显式诊断观察"}</span></article>
      </div>
      <details className="governance-block governance-review-details">
        <summary><strong>Review 流程诊断</strong><span>{reviews ? `通过 ${reviews.funnel.approved} · 轮次 P50 ${number(reviews.rounds.perTask.p50)} · 长尾 ${reviews.longTailTasks.length}` : "数据不足"}</span></summary>
        {reviews && <div className="governance-review-content">
        <div className="metrics-grid governance-metrics-grid">
          <article className="metric-card accent-cyan"><p>REVIEW 漏斗</p><strong className="metric-value">{reviews.funnel.approved}</strong><span>待审 {reviews.funnel.pending_review} · 审查中 {reviews.funnel.reviewing} · 修改中 {reviews.funnel.fixing} · 复审 {reviews.funnel.rereview}</span></article>
          <article className="metric-card"><p>轮次分布</p><strong className="metric-value">{number(reviews.rounds.perTask.p50)}</strong><span>P95 {number(reviews.rounds.perTask.p95)} · 首次通过 {ratio(reviews.rounds.firstPassRate)}</span></article>
          <article className="metric-card"><p>REVIEW 时间构成 P50</p><strong className="metric-value">{duration(reviews.timeMs.wall.p50)}</strong><span>等待 {duration(reviews.timeMs.wait.p50)} · 审查 {duration(reviews.timeMs.reviewElapsed.p50)} · 修复 {duration(reviews.timeMs.fixElapsed.p50)} · 验证 {duration(reviews.timeMs.verificationElapsed.p50)}</span></article>
          <article className="metric-card"><p>实际触达时间 P50</p><strong className="metric-value">{duration(reviews.timeMs.active.p50)}</strong><span>墙钟/任务占比 P50 {ratio(reviews.timeMs.wallToTaskRatio.p50)} · active 覆盖 {ratio(reviews.coverage.activeTimeCoverage)}</span></article>
          <article className="metric-card"><p>全量 / 增量</p><strong className="metric-value">{reviews.rounds.full} / {reviews.rounds.incremental}</strong><span>changes requested {reviews.rounds.changesRequested} 轮</span></article>
          <article className="metric-card"><p>FINDING 质量</p><strong className="metric-value">{reviews.findings.total}</strong><span>有效 {ratio(reviews.findings.validRatio)} · 重复 {ratio(reviews.findings.duplicateRatio)} · 误报 {ratio(reviews.findings.falsePositiveRatio)}</span></article>
        </div>
        <div className="governance-list">
          <span>指标覆盖：{reviews.coverage.tasksWithCycles}/{reviews.coverage.eligibleTasks} 个实现任务 · Review Cycle {reviews.coverage.cycles} · 独立 OCR 任务 {reviews.taskRoles.independent_review}</span>
          <span>等待原因：{Object.entries(reviews.waitReasons).length ? Object.entries(reviews.waitReasons).map(([reason, count]) => `${reason} ${count}`).join(" · ") : "数据不足"}</span>
          <span>Finding 分类：{Object.entries(reviews.findings.byCategory).length ? Object.entries(reviews.findings.byCategory).map(([category, count]) => `${category} ${count}`).join(" · ") : "数据不足"}</span>
          <span>长尾任务：{reviews.longTailTasks.length ? reviews.longTailTasks.map((task) => `${task.taskId}（${task.warnings.join("、")}）`).join("；") : "暂无"}</span>
        </div>
        <p className="governance-note">{reviews.note} 墙钟时间与调用方明确上报的 active time 分开展示；缺失阶段事件时显示“数据不足”。</p>
        </div>}
        <p className="governance-note">比较口径：按 workflow profile、任务类别和模型匹配，并支持多个交替窗口；归属率和调试指标只用于发现数据与流程瓶颈，不参与绩效或门禁。</p>
      </details>
    </section>
  );
}

const taskStatusMeta: Record<TaskStatus, { label: string; tone: string }> = {
  planned: { label: "已登记", tone: "planned" },
  in_progress: { label: "进行中", tone: "in-progress" },
  blocked: { label: "已阻塞", tone: "blocked" },
  done_claimed: { label: "已声明完成", tone: "done-claimed" },
  verified: { label: "已验收", tone: "verified" },
  cancelled: { label: "已取消", tone: "cancelled" },
};

const TASKS_PER_PAGE = 40;

function ReflectionPanel({ reflections, availableThreads, onChange, onExecuted, onConfigureAllowlist }: { reflections: ReflectionState; availableThreads: Thread[]; onChange: (state: ReflectionState) => void; onExecuted: () => void; onConfigureAllowlist: () => void }) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState("");
  const [executionProposalId, setExecutionProposalId] = useState("");
  const [executionMode, setExecutionMode] = useState<"new_session" | "existing_session">("new_session");
  const [executionThreadId, setExecutionThreadId] = useState("");
  const completedProposalCount = reflections.proposals.filter((proposal) => proposal.status === "accepted" && ["done_claimed", "verified"].includes(proposal.executions?.at(-1)?.taskStatus || "")).length;

  const request = async (url: string, body = {}) => {
    setState("loading");
    setMessage("");
    try {
      const response = await fetch(`${controlServerUrl}${url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-TaskCenter-Action": "delegate" },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as ReflectionState & { error?: string };
      if (!response.ok) throw new Error(payload.error || "反思操作失败");
      onChange(payload);
      setState("idle");
      return true;
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "反思操作失败");
      return false;
    }
  };

  const execute = async (proposalId: string) => {
    if (executionMode === "existing_session" && !executionThreadId) {
      setState("error");
      setMessage("请选择一个已有 Session。");
      return;
    }
    const succeeded = await request(`/reflections/${encodeURIComponent(proposalId)}/execute`, {
      requestId: crypto.randomUUID(),
      mode: executionMode,
      ...(executionMode === "existing_session" ? { threadId: executionThreadId } : {}),
    });
    if (!succeeded) return;
    setExecutionProposalId("");
    onExecuted();
  };

  return (
    <section className="reflection-section" aria-label="数据反思与改进提案">
      <div className="reflection-heading">
        <div><p className="eyebrow orange">LOCAL REFLECTION LOOP</p><h2>数据反思与改进提案<span>{reflections.proposals.length}</span></h2></div>
        <div className="reflection-controls">
          <small>仅读取 {reflections.dataBoundary.allowedSessionCount} 个白名单 Session 的聚合结果与 {reflections.dataBoundary.taskCount} 条任务记录</small>
          <button type="button" onClick={() => void request("/reflections/run")} disabled={state === "loading"}>{state === "loading" ? "分析中…" : completedProposalCount > 0 ? `复查已完成提案（${completedProposalCount}）` : "运行反思"}</button>
        </div>
      </div>
      <p className="reflection-boundary">人工配置提示只引导本机操作，不创建任务；Agent 改进提案采纳后才会选择 Session、建立正式任务并派发。</p>
      {message && <p className="reflection-error" role="alert">{message}</p>}
      {reflections.proposals.length === 0 ? <p className="reflection-empty">尚未生成改进提案。点击“运行反思”分析当前本地治理数据。</p> : (
        <div className="reflection-list">
          {reflections.proposals.map((proposal) => {
            const latestExecution = proposal.executions?.at(-1);
            const executionSession = availableThreads.find((thread) => thread.id === latestExecution?.sessionId);
            const taskFinished = ["done_claimed", "verified"].includes(latestExecution?.taskStatus || "");
            const executionLabel = latestExecution?.taskStatus === "done_claimed"
              ? "Agent 已声明完成，可再次反思复查"
              : latestExecution?.taskStatus === "verified"
              ? "历史任务已人工验收，可再次运行反思"
              : latestExecution?.taskStatus === "blocked"
              ? "执行受阻，请查看任务详情"
              : latestExecution
              ? `任务 ${latestExecution.taskStatus || "准备中"} · 派发 ${latestExecution.dispatchStatus || latestExecution.status}`
              : "";
            return (
            <article key={proposal.id} className={`reflection-card reflection-${proposal.status}`}>
              <div className="reflection-card-title"><strong>{proposal.title}</strong><span>{proposal.executionPolicy === "manual_only" ? "待配置" : proposal.status === "accepted" ? "已采纳" : proposal.status === "rejected" ? "已忽略" : proposal.status === "resolved" ? "复查已解决" : "待审核"}</span></div>
              <p>{proposal.summary}</p>
              <dl><div><dt>建议</dt><dd>{proposal.recommendation}</dd></div><div><dt>风险</dt><dd>{proposal.risk}</dd></div></dl>
              <small>证据：{proposal.evidence.map((item) => `${item.metric}=${item.count}${item.taskIds.length ? ` · ${item.taskIds.join("、")}` : ""}`).join("；")}</small>
              {proposal.executionPolicy === "manual_only" && <div className="reflection-execution-state"><strong>这是本机配置提示，不是 Agent 任务</strong><small>保存至少一个 Session 后提示会自动消失。</small><button type="button" onClick={onConfigureAllowlist}>打开会话白名单</button></div>}
              {latestExecution && <div className="reflection-execution-state"><strong>{executionLabel}</strong><small>正式任务：{latestExecution.taskId}</small><small>执行 Session：{asText(executionSession?.title, latestExecution.sessionId || "正在创建")}</small>{latestExecution.dispatchError && (taskFinished ? <small>历史派发记录（不影响当前完成声明）：{latestExecution.dispatchError}</small> : <small className="reflection-execution-error">{latestExecution.dispatchError}</small>)}</div>}
              {proposal.status === "accepted" && !latestExecution && executionProposalId === proposal.id && (
                <fieldset className="reflection-executor-picker">
                  <legend>选择执行方式</legend>
                  <label><input type="radio" name={`execution-${proposal.id}`} checked={executionMode === "new_session"} onChange={() => setExecutionMode("new_session")} /> 新建独立 Session</label>
                  <label><input type="radio" name={`execution-${proposal.id}`} checked={executionMode === "existing_session"} onChange={() => setExecutionMode("existing_session")} /> 使用已有 Session</label>
                  {executionMode === "existing_session" && <select aria-label="选择改进任务执行 Session" value={executionThreadId} onChange={(event) => setExecutionThreadId(event.target.value)}><option value="">请选择 Session</option>{availableThreads.filter((thread) => thread.id).map((thread) => <option key={thread.id} value={thread.id}>{asText(thread.title, "未命名会话")} · {thread.id?.slice(0, 8)}</option>)}</select>}
                  <div><button type="button" onClick={() => void execute(proposal.id)} disabled={state === "loading"}>{state === "loading" ? "创建中…" : "创建正式任务并执行"}</button><button type="button" onClick={() => setExecutionProposalId("")}>取消</button></div>
                </fieldset>
              )}
              <div className="reflection-actions">
                {proposal.status === "proposed" && proposal.executionPolicy === "agent_task" && <button type="button" onClick={() => void request(`/reflections/${encodeURIComponent(proposal.id)}/actions`, { decision: "accepted" })} disabled={state === "loading"}>采纳为改进项</button>}
                {proposal.status === "accepted" && proposal.executionPolicy === "agent_task" && !latestExecution && executionProposalId !== proposal.id && <button type="button" onClick={() => setExecutionProposalId(proposal.id)} disabled={state === "loading"}>选择 Session 并执行</button>}
                {proposal.status === "proposed" && proposal.executionPolicy === "agent_task" && <button type="button" onClick={() => void request(`/reflections/${encodeURIComponent(proposal.id)}/actions`, { decision: "rejected" })} disabled={state === "loading"}>忽略</button>}
                {proposal.executionPolicy === "agent_task" && ["accepted", "rejected"].includes(proposal.status) && !latestExecution && <button type="button" onClick={() => void request(`/reflections/${encodeURIComponent(proposal.id)}/actions`, { decision: "proposed" })} disabled={state === "loading"}>重新审核</button>}
              </div>
            </article>
          );})}
        </div>
      )}
    </section>
  );
}

function TaskLedger({ tasks, availableThreads: threadsForTask, sessionGroups, selectedSessionId, sessionStatuses, serviceHealthy, routingModels, onTaskUpdated }: { tasks: TaskRecord[]; availableThreads: Thread[]; sessionGroups: SessionGroup[]; selectedSessionId: string; sessionStatuses: Record<string, SessionStatus>; serviceHealthy: boolean; routingModels: RoutingHealth[]; onTaskUpdated: (task: TaskRecord) => void }) {
  // 筛选逻辑：全部任务显示全局，具体 Session 优先精确 session_id，不可用时按显式项目标识回退
  const selectedSessionIds = sessionIdsForGroup(selectedSessionId, sessionGroups);
  const filteredTasks = selectedSessionId === "全部任务"
    ? tasks
    : tasks.filter((task) => taskMatchesSession(task, {
      selectedSessionIds,
      availableSessionIds: threadsForTask.flatMap((thread) => [thread.id, ...(thread.sessionIds ?? [])]).filter((id): id is string => Boolean(id)),
      selectedThread: sessionGroups.find((thread) => thread.id === selectedSessionId),
    }));
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | TaskStatus>("all");
  const [lifecycleFilter, setLifecycleFilter] = useState("all");
  const [agentFilter, setAgentFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");
  const [showArchived, setShowArchived] = useState(false);
  const agents: string[] = [...new Set(filteredTasks.map((task) => task.agent || "unknown"))];
  const lifecycleCounts = { ...taskLifecycleFilterCounts(filteredTasks), all: filteredTasks.filter((task) => showArchived || !task.archivedAt).length };
  const shownTasks = filteredTasks.filter((task) => showArchived || !task.archivedAt).filter((task) => lifecycleFilter === "all" || matchesTaskLifecycleFilter(task, lifecycleFilter)).filter((task) => statusFilter === "all" || task.status === statusFilter).filter((task) => agentFilter === "all" || (task.agent || "unknown") === agentFilter).filter((task) => !query || `${task.title} ${task.id} ${task.sessionId}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => (Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || "")) * (sortOrder === "newest" ? 1 : -1));
  const pageCount = Math.max(1, Math.ceil(shownTasks.length / TASKS_PER_PAGE));
  const effectivePage = Math.min(page, pageCount);
  const visibleTasks = shownTasks.slice((effectivePage - 1) * TASKS_PER_PAGE, effectivePage * TASKS_PER_PAGE);

  return (
    <section className="task-ledger" aria-label="会话主动任务">
      <div className={`session-health-bar ${serviceHealthy ? "healthy" : "unhealthy"}`} role="status">{serviceHealthy ? "● 控制服务正常 · 同步 watcher 正常" : "! 控制服务或同步 watcher 异常，正在重试"} · 最近数据生成时间以 dashboard 为准</div>
      {routingModels.length > 0 && <div className="session-health-bar healthy" aria-label="模型路由健康">模型路由：{routingModels.map((item) => `${item.model.replace("gpt-5.3-codex-", "").replace("gpt-5.6-", "")} ${item.state} ${item.active_executors}/${item.concurrency_limit}`).join(" · ")}</div>}
      <div className="ledger-heading">
        <p className="eyebrow orange">SESSION TASK GATE</p>
        <h2>会话主动任务<span>{filteredTasks.length}</span></h2>
        <input aria-label="搜索任务" placeholder="标题 / ID / Session" value={query} onChange={(event) => setQuery(event.target.value)} />
        <select aria-label="任务终态" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as "all" | TaskStatus); setLifecycleFilter("all"); setPage(1); }}><option value="all">不限终态</option>{(["done_claimed", "verified", "cancelled"] as TaskStatus[]).map((status) => <option key={status} value={status}>{taskStatusMeta[status].label}</option>)}</select>
        <select aria-label="任务 Agent" value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)}><option value="all">全部 Agent</option>{agents.map((agent) => <option key={agent}>{agent}</option>)}</select>
        <select aria-label="更新时间排序" value={sortOrder} onChange={(event) => setSortOrder(event.target.value as "newest" | "oldest")}><option value="newest">更新时间：最新</option><option value="oldest">更新时间：最早</option></select>
        <label><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> 显示归档</label>
      </div>
      <nav className="task-lifecycle-filters" aria-label="未完成任务阶段筛选">
        {taskLifecycleFilters.map((filter) => <button type="button" key={filter.id} className={lifecycleFilter === filter.id ? "active" : ""} aria-pressed={lifecycleFilter === filter.id} onClick={() => { setLifecycleFilter(filter.id); setStatusFilter("all"); setPage(1); }}>{filter.label}<span>{lifecycleCounts[filter.id] || 0}</span></button>)}
      </nav>
      <p className="task-closure-note">TaskCenter 不按时间或测试数量猜测完成；Agent 必须显式声明完成，且当前 Subject 的验收、验证与 Review 证据满足契约后才会闭环。</p>
      {shownTasks.length === 0 ? (
        <p className="ledger-empty">
          {selectedSessionId === "全部任务"
            ? "还没有已登记的会话主动任务。会话开始写代码前应先调用 taskcenter_session_register 与 taskcenter_task_create，取得 accepted=true 和 task_id 后再实施。"
            : "当前会话没有关联任务。"}
        </p>
      ) : (
        <>
          <div className="task-table-wrapper">
            <table className="task-table">
            <thead>
              <tr>
                <th>标题</th>
                <th>关联 ID</th>
                <th>状态</th>
                <th>目标 / 步骤</th>
                <th>阻塞</th>
                <th className="task-count-header">假设 / 风险 / 取舍 / 待确认 / 复盘</th>
                <th>Session</th>
                <th>时间 / 工具</th>
                <th>人工操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleTasks.map((task) => <TaskRow key={task.id} task={task} availableThreads={threadsForTask} sessionStatuses={sessionStatuses} onTaskUpdated={onTaskUpdated} />)}
            </tbody>
          </table>
          </div>
          {pageCount > 1 && (
            <nav className="task-pagination" aria-label="任务分页">
              <button type="button" onClick={() => setPage(effectivePage - 1)} disabled={effectivePage === 1}>上一页</button>
              <span>第 {effectivePage} / {pageCount} 页 · 每页 {TASKS_PER_PAGE} 条</span>
              <button type="button" onClick={() => setPage(effectivePage + 1)} disabled={effectivePage === pageCount}>下一页</button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}

function TaskRow({ task, availableThreads: threadsForTask, sessionStatuses, onTaskUpdated }: { task: TaskRecord; availableThreads: Thread[]; sessionStatuses: Record<string, SessionStatus>; onTaskUpdated: (task: TaskRecord) => void }) {
  const [actionState, setActionState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [actionError, setActionError] = useState("");
  const [scheduleEditing, setScheduleEditing] = useState(false);
  const [scheduleValue, setScheduleValue] = useState("");
  const [estimatedEffortHours, setEstimatedEffortHours] = useState("");
  const [estimateReason, setEstimateReason] = useState("");
  const [idCopyState, setIdCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [events, setEvents] = useState<Array<Record<string, string>> | null>(null);
  const [eventsError, setEventsError] = useState("");
  const contextSyncRequestId = useRef("");
  useEffect(() => { if (!detailsOpen || events) return; void fetch(`${controlServerUrl}/tasks/${encodeURIComponent(task.id)}/events`).then(async (response) => { const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "事件加载失败"); setEvents(payload.events ?? []); }).catch((error) => setEventsError(error instanceof Error ? error.message : "事件加载失败")); }, [detailsOpen, events, task.id]);
  const meta = taskStatusMeta[task.status] ?? taskStatusMeta.planned;
  const detailItems = [
    { label: "完成就绪", items: task.contractVersion === "v2" && task.completionReadiness && !task.completionReadiness.ready ? task.completionReadiness.reasons : [] },
    { label: "审核理由", items: task.reviewReason ? [`${task.reviewReason}${task.reviewedAt ? ` · ${normalizeDate(task.reviewedAt)}` : ""}`] : [] },
    { label: "假设", items: task.assumptions ?? [] },
    { label: "风险", items: task.risks ?? [] },
    { label: "取舍", items: task.tradeoffs ?? [] },
    { label: "待确认", items: task.openQuestions ?? [] },
    { label: "复盘", items: task.retrospective ? [task.retrospective] : [] },
    { label: "估时调整", items: (task.estimateHistory ?? []).slice(-3).reverse().map((item) => `${item.previousDueAt ? normalizeDate(item.previousDueAt) : "未设置"} → ${item.dueAt ? normalizeDate(item.dueAt) : "不变"} · ${item.estimatedEffortMs ? formatElapsed(item.estimatedEffortMs) : "工时不变"} · ${item.reason || "未说明"}`) },
    { label: "CLI 执行", items: (task.cliRuns ?? []).slice().reverse().map((run) => `${run.executorModel || "unknown"} · ${run.status} · Session ${run.delegateSessionId ? run.delegateSessionId.slice(0, 12) : "待领取"} · scope ${(run.scope ?? []).join(", ") || "未声明"}${run.completedAt ? ` · ${normalizeDate(run.completedAt)}` : ""}`) },
  ];
  const routingAdvisory = detectSparkRoutingAdvisory(task);
  const nonEmptyDetails = detailItems.filter((item) => item.items.length > 0);
  const hasEventDetails = hasTaskEventDetails(task, nonEmptyDetails.length > 0 || Boolean(routingAdvisory?.triggered));
  const stepText = task.currentStep ?? task.nextAction;
  const goalOrStep = task.goal || stepText ? `${asText(task.goal)}${stepText ? ` · ${asText(stepText)}` : ""}` : "—";
  const isDemo = task.id.startsWith("ui-demo-");
  const timeState = taskTimeState(task);
  const closureReasons = taskClosureReasonLabels(task);

  const sessionStatus = sessionStatuses[task.sessionId];
  const sessionInfo = useMemo(
    () => resolveTaskSessionDisplay(task, threadsForTask.find((thread) => thread.id === task.sessionId || thread.sessionIds?.includes(task.sessionId)), sessionStatus),
    [task, threadsForTask, sessionStatus],
  );

  const handleAction = async (action: "start" | "block" | "done" | "cancel" | "remove" | "verify" | "reject" | "archive" | "unarchive" | "schedule") => {
    if (actionState === "loading") return;
    const reason = action === "reject" ? window.prompt("请输入打回理由", "人工打回，需补充证据") : "";
    if (action === "reject" && reason === null) return;
    if (action === "schedule") return;
    setActionState("loading");
    setActionError("");
    try {
      const response = await fetch(`${controlServerUrl}/tasks/${encodeURIComponent(task.id)}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-TaskCenter-Action": "delegate" },
        body: JSON.stringify({ action, ...(action === "reject" ? { reason } : {}) }),
      });
      const payload = await response.json() as { error?: string; task?: TaskRecord | null };
      if (!response.ok) throw new Error(payload.error || "操作失败");
      if (!payload.task) throw new Error("操作成功但服务端未返回任务状态");
      onTaskUpdated(payload.task);
      setActionState("done");
    } catch (error) {
      setActionState("error");
      setActionError(error instanceof Error ? error.message : "操作失败");
    }
  };

  const handleSchedule = async () => {
    const effort = Number(estimatedEffortHours);
    if (!scheduleValue && !(Number.isFinite(effort) && effort > 0)) return;
    if (scheduleValue && Number.isNaN(Date.parse(scheduleValue))) return;
    setActionState("loading");
    try {
      const response = await fetch(`${controlServerUrl}/tasks/${encodeURIComponent(task.id)}/actions`, { method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Action": "delegate" }, body: JSON.stringify({ action: "schedule", ...(scheduleValue ? { expectedAt: new Date(scheduleValue).toISOString() } : {}), ...(Number.isFinite(effort) && effort > 0 ? { estimatedEffortMinutes: Math.round(effort * 60) } : {}), reason: estimateReason || "人工调整估时" }) });
      const payload = await response.json() as { error?: string; task?: TaskRecord | null };
      if (!response.ok || !payload.task) throw new Error(payload.error || "操作失败");
      onTaskUpdated(payload.task);
      setScheduleEditing(false);
      setActionState("done");
    } catch (error) {
      setActionState("error");
      setActionError(error instanceof Error ? error.message : "操作失败");
    }
  };

  const handleContextSync = async () => {
    if (actionState === "loading") return;
    const subject = task.currentSubject ? `${task.currentSubject.type}:${task.currentSubject.value || "none"}` : "none";
    const findings = task.completionReadiness?.unresolvedFindings?.length || 0;
    const confirmed = window.confirm([
      "确认完成并同步 ProjectContext？",
      `Subject: ${subject}`,
      `验证: ${task.verificationStatus || "unknown"}`,
      `Review: ${task.reviewStatus || "unknown"}`,
      `未决 finding: ${findings}`,
    ].join("\n"));
    if (!confirmed) return;
    setActionState("loading");
    setActionError("");
    try {
      if (!contextSyncRequestId.current) contextSyncRequestId.current = crypto.randomUUID();
      const response = await fetch(`${controlServerUrl}/tasks/${encodeURIComponent(task.id)}/sync-project-context`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-TaskCenter-Action": "delegate" },
        body: JSON.stringify({ confirm: true, requestId: contextSyncRequestId.current }),
      });
      const payload = await response.json() as { error?: string; task?: TaskRecord };
      if (!response.ok) throw new Error(payload.error || "ProjectContext 同步失败");
      if (payload.task) onTaskUpdated(payload.task);
      contextSyncRequestId.current = "";
      setActionState("done");
    } catch (error) {
      setActionState("error");
      setActionError(error instanceof Error ? error.message : "ProjectContext 同步失败");
    }
  };

  const copyTaskId = async () => {
    try {
      await copyToClipboard(task.id);
      setIdCopyState("copied");
      window.setTimeout(() => setIdCopyState("idle"), 1200);
    } catch {
      setIdCopyState("error");
    }
  };

  return (
    <>
      <tr className={`task-row status-task-${meta.tone}`}>
      <td data-label="标题" className="task-cell task-title-cell" title={asText(task.title, "未命名任务")}>
        <strong>{asText(task.title, "未命名任务")}</strong>
        <span className="task-id-line">
          <code title="任务独立 ID">{task.id}</code>
          <button
            type="button"
            className="task-id-copy-button"
            onClick={() => void copyTaskId()}
            disabled={idCopyState === "copied"}
            aria-label={`复制任务 ID ${task.id}`}
          >
            {idCopyState === "copied" ? "已复制" : "复制 ID"}
          </button>
        </span>
        {idCopyState === "error" && <small className="task-id-copy-error">复制失败，请手动选择 ID</small>}
      </td>
      <td data-label="关联 ID" className="task-cell"><code>{task.requirementId || "—"}</code></td>
      <td data-label="状态" className="task-cell">
        <span className={`task-status status-${meta.tone}`}>{meta.label}</span>{timeState.stale && <small> · 陈旧</small>}{timeState.overdue && <small> · 交付逾期</small>}{timeState.effortOverrun && <small> · 工时超预估</small>}
        {task.contractVersion === "v2" && <small className="task-assurance-status">验证 {task.verificationStatus} · 审查 {task.reviewStatus} · 验收 {task.acceptanceStatus}</small>}
        {closureReasons.length > 0 && <small className="task-closure-reasons" title={closureReasons.join("、")}>{closureReasons.slice(0, 2).join(" · ")}{closureReasons.length > 2 ? ` +${closureReasons.length - 2}` : ""}</small>}
      </td>
      <td data-label="目标 / 步骤" className="task-cell task-goal-cell" title={goalOrStep}>{goalOrStep}</td>
      <td data-label="阻塞" className="task-cell task-blocker-cell" title={task.blocker || "—"}>{task.blocker ? asText(task.blocker) : "—"}</td>
      <td data-label="假设 / 风险 / 取舍 / 待确认 / 复盘" className="task-cell task-count-cell">
        {hasEventDetails ? (
          <button
            type="button"
            className="task-detail-preview"
            aria-expanded={detailsOpen}
            aria-controls={`task-details-${task.id}`}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            {nonEmptyDetails.map((item) => <span key={item.label}><b>{item.label}</b> {asText(item.items[0])}{item.items.length > 1 ? ` +${item.items.length - 1}` : ""}</span>)}
            {task.routing && <span><b>模型路由</b> {asText(task.routing.orchestratorModel)} → {asText(task.routing.selectedExecutorModel)} · {asText(task.routing.dispatchChannel)}</span>}
            <small>{detailsOpen ? "收起详情" : "查看详情"}</small>
          </button>
        ) : "—"}
      </td>
      <td data-label="Session" className="task-cell task-session-cell" title={sessionInfo ? `${sessionInfo.title} · ${sessionInfo.detail}` : task.sessionId}>
        {sessionInfo ? (
          <>
            <strong>{sessionInfo.title}</strong>
            <small>{sessionStatus?.agent ?? task.agent ?? "unknown"} · {sessionInfo.detail} · {sessionStatus?.status === "registered" ? "已登记" : "未登记"}</small>
          </>
        ) : (
          <span className="no-session">{task.sessionId.slice(0, 8)}… 未关联会话</span>
        )}
      </td>
      <td data-label="时间 / 工具" className="task-cell task-metrics-cell">
        <div>创建：{normalizeDate(task.createdAt)}</div>
        <div>首次执行：{normalizeDate(task.firstStartedAt)}</div>
        <div>交付截止：{normalizeDate(task.dueAt)}</div>
        {!task.dueAt && task.expectedAt && <div>历史预计完成：{normalizeDate(task.expectedAt)}</div>}
        <div>预计工时：{timeState.estimatedEffortMs === null ? "—" : formatElapsed(timeState.estimatedEffortMs)}</div>
        <div>实际：{normalizeDate(task.actualAt)}</div>
        <div>墙钟周期：{formatElapsed(timeState.wallElapsedMs)}</div>
        <div>有效执行：{timeState.activeElapsedMs === null ? "未采集" : formatElapsed(timeState.activeElapsedMs)}</div>
        <div>阻塞等待：{timeState.blockedElapsedMs === null ? "未采集" : formatElapsed(timeState.blockedElapsedMs)}</div>
        {timeState.scheduleOverdueMs > 0 && <div>交付延期：{formatElapsed(timeState.scheduleOverdueMs)}</div>}
        {timeState.effortVarianceMs !== null && <div>工时偏差：{timeState.effortVarianceMs >= 0 ? "+" : "-"}{formatElapsed(Math.abs(timeState.effortVarianceMs))}</div>}
        {task.archivedAt && <div>归档：{normalizeDate(task.archivedAt)}</div>}
        <div className="task-tools">工具：{Object.entries(task.toolCalls ?? {}).length ? Object.entries(task.toolCalls ?? {}).map(([name, count]) => `${name} ×${count}`).join("、") : "—"}</div>
      </td>
      <td data-label="人工操作" className="task-cell task-actions-cell">
        {task.status === "planned" && (
          <button className="task-action-button action-start" onClick={() => handleAction("start")} disabled={actionState === "loading"}>
            开始
          </button>
        )}
        {["planned", "in_progress"].includes(task.status) && (
          <button className="task-action-button action-block" onClick={() => handleAction("block")} disabled={actionState === "loading"}>
            阻塞
          </button>
        )}
        {["planned", "in_progress", "blocked"].includes(task.status) && (
          <button className="task-action-button action-done" onClick={() => handleAction("done")} disabled={actionState === "loading"}>
            完成
          </button>
        )}
        {task.status === "done_claimed" && (
          <button className="task-action-button action-block" onClick={() => handleAction("reject")} disabled={actionState === "loading"}>打回</button>
        )}
        {task.status === "done_claimed" && task.contextTaskId && task.completionReadiness?.completionClaim?.allowed === true && (
          <button className="task-action-button action-done" onClick={() => void handleContextSync()} disabled={actionState === "loading"}>
            {actionState === "loading" ? "同步中…" : "完成并同步 ProjectContext"}
          </button>
        )}
        {task.status === "verified" && <span className="task-action-note">已验收</span>}
        {["planned", "in_progress", "blocked"].includes(task.status) && <button className="task-action-button action-block" onClick={() => handleAction("cancel")} disabled={actionState === "loading"}>取消</button>}
        {["planned", "in_progress", "blocked"].includes(task.status) && !scheduleEditing && <button className="task-action-button" onClick={() => { setScheduleEditing(true); setScheduleValue(toLocalDateTimeValue(task.dueAt)); setEstimatedEffortHours(task.estimatedEffortMs ? String(task.estimatedEffortMs / 3_600_000) : ""); setEstimateReason(""); }}>设置估时</button>}
        {scheduleEditing && <span><input aria-label="交付截止时间" type="datetime-local" value={scheduleValue} onChange={(event) => setScheduleValue(event.target.value)} /><input aria-label="预计有效工时" type="number" min="0.25" step="0.25" placeholder="有效工时（小时）" value={estimatedEffortHours} onChange={(event) => setEstimatedEffortHours(event.target.value)} /><input aria-label="估时调整原因" placeholder="调整原因" value={estimateReason} onChange={(event) => setEstimateReason(event.target.value)} /><button className="task-action-button" onClick={() => void handleSchedule()}>保存</button><button className="task-action-button" onClick={() => setScheduleEditing(false)}>取消</button></span>}
        {!(["planned", "in_progress", "blocked"].includes(task.status)) && !task.archivedAt && <button className="task-action-button" onClick={() => handleAction("archive")} disabled={actionState === "loading"}>归档</button>}
        {task.archivedAt && <button className="task-action-button" onClick={() => handleAction("unarchive")} disabled={actionState === "loading"}>恢复</button>}
        {isDemo && (
          <button className="task-action-button action-remove" onClick={() => handleAction("remove")} disabled={actionState === "loading"}>
            移除演示
          </button>
        )}
        {actionError && <span className="task-action-error">{actionError}</span>}
      </td>
      </tr>
      {detailsOpen && hasEventDetails && (
        <tr id={`task-details-${task.id}`} className="task-detail-row">
          <td colSpan={9}>
            <div className="task-detail-content">
              <div className="task-detail-toolbar">
                <strong>任务详情</strong>
                <button
                  type="button"
                  className="task-detail-close"
                  onClick={() => setDetailsOpen(false)}
                  aria-label={`收起 ${asText(task.title, "任务")} 的详情`}
                >
                  收起详情
                </button>
              </div>
              {nonEmptyDetails.map((item) => <section key={item.label}><strong>{item.label}</strong><ul>{item.items.map((value, index) => <li key={`${item.label}-${index}`}>{value}</li>)}</ul></section>)}
              {routingAdvisory?.triggered && (
                <section className="task-routing-advisory">
                  <div className="dispatch-warning">
                    <strong>{routingAdvisory.title}</strong>
                    <p>{routingAdvisory.message}</p>
                    <p>{routingAdvisory.suggestion}</p>
                  </div>
                </section>
              )}
              <section><strong>事件时间线</strong>{eventsError ? <p>{eventsError}</p> : events === null ? <p>加载中…</p> : events.length === 0 ? <p>暂无事件</p> : <ul>{events.map((event, index) => <li key={`${event.event_id || index}`}>{asText(event.type)} · {taskEventStatus(event)} · {normalizeDate(event.created_at)} · {taskEventSummary(event)}</li>)}</ul>}</section>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function toLocalDateTimeValue(value?: string) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatElapsed(duration: number) {
  if (!Number.isFinite(duration) || duration < 0) return "—";
  const seconds = Math.floor(duration / 1000);
  return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}
