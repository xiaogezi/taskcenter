"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dashboardJson from "../data/dashboard.json";
import { groupSessions, mergeTaskSessions, sessionIdsForGroup, filterThreadsWithTasks } from "./session-groups.mjs";
import { resolveTaskSessionDisplay, taskMatchesSession } from "./task-session-display.mjs";
import { taskTimeState } from "./task-time-state.mjs";

type SessionGroup = Thread & {
  id: string;
  groupKey: string;
  sessionIds: string[];
  sessionCount: number;
};

type Status = "verified" | "in_progress" | "partial" | "missing" | "needs_validation" | "untriaged";
type StatusFilter = Status | "active" | "all";
type InboxDecision = "continue" | "discard";
type DispatchMode = "new_session" | "existing_session";
type DispatchStatus = "dry_run" | "delivering" | "delivered" | "delivered_hidden" | "failed" | "queued" | "running" | "completed" | "cancelled";
type DispatchRecord = {
  id: string;
  requirementId: string;
  requirementTitle: string;
  threadId: string;
  threadTitle?: string;
  sourceThreadId?: string;
  contextThreadId?: string;
  delegationSourceThreadId?: string;
  mode?: DispatchMode | "session_message";
  status: DispatchStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
};
type RequirementOverride = {
  status?: Status;
  hidden?: boolean;
  source?: "manual";
  updatedAt?: string;
};
type ExcludedItem = {
  id: string;
  classification: string;
  text: string;
  threadId: string;
  threadTitle: string;
  timestamp?: string;
};

type Evidence = string | { label?: string; text?: string; type?: string };

type Requirement = {
  id?: string;
  title?: string;
  category?: string;
  priority?: string;
  status?: Status;
  kind?: "epic" | "requirement";
  project?: string;
  parentId?: string;
  sourceKind?: string;
  summary?: string;
  gap?: string;
  acceptanceCriteria?: string[];
  implementationStages?: string[];
  evidencePaths?: string[];
  evidence?: Evidence[] | Evidence;
  sources?: Array<{
    threadId?: string;
    threadTitle?: string;
    excerpt?: string;
    messageId?: string;
  }>;
  source?: { threadId?: string; threadTitle?: string; excerpt?: string };
  threadId?: string;
  claimedDone?: boolean;
  updatedAt?: string;
  normalizedSummary?: string;
  suggestedCategory?: string;
  suggestedStatus?: Exclude<Status, "untriaged">;
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

type SessionSelection = { mode: "all" | "selected"; threadIds: string[] };
type TaskStatus = "planned" | "in_progress" | "blocked" | "done_claimed" | "verified" | "cancelled";
type TaskRecord = {
  id: string;
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
  expectedAt?: string;
  actualAt?: string;
  archivedAt?: string;
  reviewReason?: string;
  reviewedAt?: string;
  toolCalls?: Record<string, number>;
};

type SessionStatus = {
  sessionId: string;
  agent: "codex" | "claude" | "workbuddy" | "unknown";
  provider: string;
  model: string;
  registeredAt: string;
  lastSeenAt: string;
  status: "registered" | "unregistered";
  reason: string;
  taskCount: number;
  lastTaskAt: string;
};

type Dashboard = {
  generatedAt?: string;
  source?: {
    mode?: string;
    threadCount?: number;
    messageCount?: number;
    classificationCounts?: Record<string, number>;
    excludedCounts?: Record<string, number>;
    excludedItems?: ExcludedItem[];
    sessionSelection?: SessionSelection;
    availableThreads?: Thread[];
  };
  summary?: {
    total?: number;
    curatedTotal?: number;
    inboxCount?: number;
    excludedCount?: number;
    completionRate?: number;
    statusCounts?: Partial<Record<Status, number>>;
  };
  threads?: Thread[];
  requirements?: Requirement[];
};

const dashboard = dashboardJson as Dashboard;
const requirements = dashboard.requirements ?? [];
const threads = dashboard.threads ?? [];
const availableThreads = dashboard.source?.availableThreads ?? threads;
const inbox = requirements.filter((item) => item.status === "untriaged");

const statusMeta: Record<Status, { label: string; short: string; tone: string }> = {
  verified: { label: "已验收", short: "验收", tone: "verified" },
  in_progress: { label: "进行中", short: "进行中", tone: "in-progress" },
  partial: { label: "部分完成", short: "部分", tone: "partial" },
  missing: { label: "未实现", short: "缺口", tone: "missing" },
  needs_validation: { label: "待验证", short: "验证", tone: "validation" },
  untriaged: { label: "待整理", short: "整理", tone: "untriaged" },
};

const priorityMeta: Record<string, string> = {
  P0: "P0 · 关键",
  P1: "P1 · 重要",
  P2: "P2 · 增强",
};
const inboxStorageKey = "reqradar:inbox-decisions:v1";
// 控制服务 URL：优先使用环境变量，默认 IPv4 localhost
const controlServerUrl = typeof process !== "undefined" && process.env?.REQRADAR_CONTROL_URL
  ? process.env.REQRADAR_CONTROL_URL
  : "http://127.0.0.1:3001";

function asText(value: unknown, fallback = "暂无记录") {
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallback;
}

function asList(value: Evidence[] | Evidence | undefined): Evidence[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function evidenceText(value: Evidence) {
  if (typeof value === "string") return value;
  return asText(value.label ?? value.text, "已记录证据");
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

function sourceItems(requirement: Requirement) {
  if (requirement.sources?.length) return requirement.sources;
  if (requirement.source) return [requirement.source];
  if (requirement.threadId) return [{ threadId: requirement.threadId }];
  return [];
}

function sourceThreads(requirement: Requirement) {
  const unique = new Map<string, { threadId: string; threadTitle: string }>();
  for (const source of sourceItems(requirement)) {
    if (!source.threadId || unique.has(source.threadId)) continue;
    unique.set(source.threadId, {
      threadId: source.threadId,
      threadTitle: asText(source.threadTitle, source.threadId),
    });
  }
  return [...unique.values()];
}

function parentTitle(requirement: Requirement) {
  if (!requirement.parentId) return "";
  return requirements.find((item) => item.id === requirement.parentId)?.title ?? requirement.parentId;
}

function StatusBadge({ status }: { status?: Status }) {
  const current = statusMeta[status ?? "untriaged"];
  return <span className={`status-badge status-${current.tone}`}>{current.label}</span>;
}

function requirementKey(requirement: Requirement, index = 0) {
  return requirement.id ?? `${asText(requirement.title, "inbox")}-${index}`;
}

function overrideKey(requirement: Requirement) {
  return String(requirement.id || "").replace(/^promoted-/, "");
}

function manualTaskText(requirement: Requirement) {
  const evidence = requirement.evidencePaths?.length
    ? requirement.evidencePaths.slice(0, 6)
    : asList(requirement.evidence).slice(0, 6).map(evidenceText);
  const acceptance = requirement.acceptanceCriteria?.slice(0, 5) ?? [];
  const stages = requirement.implementationStages?.slice(0, 5) ?? [];
  return [
    "【ReqRadar 继续需求】",
    requirement.id ? `ReqRadar ID：${requirement.id.replace(/^promoted-/, "")}` : "",
    `需求：${asText(requirement.title, "未命名需求")}`,
    `当前状态：${statusMeta[requirement.status ?? "untriaged"].label}`,
    requirement.project ? `项目：${requirement.project}` : "",
    requirement.parentId ? `父项：${parentTitle(requirement)}` : "",
    `已完成概况：${asText(requirement.summary)}`,
    `剩余缺口：${asText(requirement.gap, "尚未记录剩余缺口。")}`,
    stages.length ? `实施阶段：${stages.join("；")}` : "",
    acceptance.length ? `验收标准：${acceptance.join("；")}` : "",
    evidence.length ? `现有证据：${evidence.join("；")}` : "",
    "",
    "请先核对原会话和当前工作区，从下一安全节点继续完成；不要重复、回滚或重启已完成工作。",
    "完成后运行必要测试，明确区分实现声明和已验证结果。未经明确授权，不执行 git add、commit 或 push。",
  ].filter(Boolean).join("\n");
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
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [categoryFilter, setCategoryFilter] = useState("全部分类");
  const [priorityFilter, setPriorityFilter] = useState("全部优先级");
  const [selectedThread, setSelectedThread] = useState("全部任务");
  const [view, setView] = useState<"cards" | "rows">("rows");
  const [inboxDecisions, setInboxDecisions] = useState<Record<string, InboxDecision>>({});
  const [showProcessedInbox, setShowProcessedInbox] = useState(false);
  const [showClassificationAudit, setShowClassificationAudit] = useState(false);
  const [dispatchTarget, setDispatchTarget] = useState<Requirement | null>(null);
  const [dispatchThreadId, setDispatchThreadId] = useState("");
  const [dispatchMode, setDispatchMode] = useState<DispatchMode>("new_session");
  const [dispatches, setDispatches] = useState<DispatchRecord[]>([]);
  const [requirementOverrides, setRequirementOverrides] = useState<Record<string, RequirementOverride>>({});
  const [showRemoved, setShowRemoved] = useState(false);
  const [dispatchError, setDispatchError] = useState("");
  const [isDispatching, setIsDispatching] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState("");
  const refreshInFlight = useRef(false);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [pickerThreadIds, setPickerThreadIds] = useState<string[]>([]);
  const [isSavingSessionSelection, setIsSavingSessionSelection] = useState(false);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [liveAvailableThreads, setLiveAvailableThreads] = useState<Thread[]>([]);
  const [sessionStatuses, setSessionStatuses] = useState<Record<string, SessionStatus>>({});

  useEffect(() => {
    const restore = window.setTimeout(() => {
      try {
        const stored = JSON.parse(localStorage.getItem(inboxStorageKey) ?? "{}");
        if (stored && typeof stored === "object" && !Array.isArray(stored)) {
          setInboxDecisions(stored);
        }
      } catch {
        localStorage.removeItem(inboxStorageKey);
      }
    }, 0);
    return () => window.clearTimeout(restore);
  }, []);

  const refreshLiveData = async (manual = false) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    if (manual) {
      setIsRefreshing(true);
      setRefreshMessage("");
    }
    try {
      const [dispatchesResponse, tasksResponse, sessionStatusResponse, overridesResponse, threadsResponse] = await Promise.all([
        fetch(`${controlServerUrl}/dispatches`),
        fetch(`${controlServerUrl}/tasks`),
        fetch(`${controlServerUrl}/session-status`),
        fetch(`${controlServerUrl}/requirement-overrides`),
        fetch(`${controlServerUrl}/session-selection`),
      ]);
      if (!dispatchesResponse.ok || !tasksResponse.ok || !sessionStatusResponse.ok || !overridesResponse.ok || !threadsResponse.ok) {
        throw new Error("本地控制服务返回异常");
      }
      const [dispatchesPayload, tasksPayload, sessionStatusPayload, overridesPayload, threadsPayload] = await Promise.all([
        dispatchesResponse.json() as Promise<{ dispatches?: DispatchRecord[] }>,
        tasksResponse.json() as Promise<{ tasks?: TaskRecord[] }>,
        sessionStatusResponse.json() as Promise<{ sessions?: SessionStatus[] }>,
        overridesResponse.json() as Promise<{ overrides?: Record<string, RequirementOverride> }>,
        threadsResponse.json() as Promise<{ availableThreads?: Thread[] }>,
      ]);
      setDispatches(dispatchesPayload.dispatches ?? []);
      setTasks(tasksPayload.tasks ?? []);
      setSessionStatuses(Object.fromEntries((sessionStatusPayload.sessions ?? []).map((session) => [session.sessionId, session])));
      setRequirementOverrides(overridesPayload.overrides ?? {});
      setLiveAvailableThreads(threadsPayload.availableThreads ?? []);
      if (manual) setRefreshMessage(`已刷新 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`);
    } catch (error) {
      if (manual) setRefreshMessage(error instanceof Error ? error.message : "刷新失败，请检查本地控制服务");
    } finally {
      refreshInFlight.current = false;
      if (manual) setIsRefreshing(false);
    }
  };

  useEffect(() => {
    void refreshLiveData();
    const timer = window.setInterval(() => void refreshLiveData(), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  const updateInboxDecision = (id: string, decision?: InboxDecision) => {
    setInboxDecisions((current) => {
      const next = { ...current };
      if (decision) next[id] = decision;
      else delete next[id];
      localStorage.setItem(inboxStorageKey, JSON.stringify(next));
      return next;
    });
  };

  const promotedRequirements = useMemo(
    () => inbox.flatMap((item, index) => {
      const id = requirementKey(item, index);
      if (inboxDecisions[id] !== "continue") return [];
      return [{
        ...item,
        id: `promoted-${id}`,
        category: item.suggestedCategory ?? "待推进",
        priority: item.priority === "待定" ? "P1" : item.priority,
        status: item.suggestedStatus ?? "missing",
        summary: item.normalizedSummary ?? item.summary,
        gap: "已从待整理 inbox 选择继续推进，尚未交给 Codex 执行。",
      }];
    }),
    [inboxDecisions],
  );
  const allBoardRequirements = useMemo(
    () => [
      ...requirements.filter((item) => item.status !== "untriaged"),
      ...promotedRequirements,
    ].map((item) => {
      const override = requirementOverrides[overrideKey(item)];
      return override?.status ? { ...item, status: override.status } : item;
    }),
    [promotedRequirements, requirementOverrides],
  );
  const removedRequirements = useMemo(
    () => allBoardRequirements.filter((item) => requirementOverrides[overrideKey(item)]?.hidden),
    [allBoardRequirements, requirementOverrides],
  );
  const boardRequirements = useMemo(
    () => allBoardRequirements.filter((item) => !requirementOverrides[overrideKey(item)]?.hidden),
    [allBoardRequirements, requirementOverrides],
  );
  const selectionThreads = liveAvailableThreads.length > 0 ? liveAvailableThreads : availableThreads;
  const taskBackedThreads = mergeTaskSessions(selectionThreads, tasks, sessionStatuses);
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

  const selectedSessionIdsForGroup = useMemo(
    () => sessionIdsForGroup(selectedThread, mergedThreads),
    [mergedThreads, selectedThread],
  );

  const categories = useMemo(
    () => ["全部分类", ...Array.from(new Set(boardRequirements.map((item) => asText(item.category, "未分类"))))],
    [boardRequirements],
  );
  const priorities = useMemo(
    () => ["全部优先级", ...Array.from(new Set(boardRequirements.map((item) => asText(item.priority, "未设置"))))],
    [boardRequirements],
  );

  const filteredRequirements = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return boardRequirements.filter((item) => {
      const text = [item.title, item.summary, item.gap, item.category, item.priority]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const sources = sourceItems(item);
      const belongsToThread =
        selectedThread === "全部任务" || sources.some((source) => selectedSessionIdsForGroup.includes(source.threadId ?? "")) || selectedSessionIdsForGroup.includes(item.threadId ?? "");
      const hasStatus =
        statusFilter === "all" ||
        (statusFilter === "active" && ["in_progress", "partial", "missing", "needs_validation"].includes(item.status ?? "untriaged")) ||
        item.status === statusFilter;
      return (
        belongsToThread &&
        hasStatus &&
        (categoryFilter === "全部分类" || asText(item.category, "未分类") === categoryFilter) &&
        (priorityFilter === "全部优先级" || asText(item.priority, "未设置") === priorityFilter) &&
        (!normalizedQuery || text.includes(normalizedQuery))
      );
    });
  }, [boardRequirements, categoryFilter, priorityFilter, query, selectedSessionIdsForGroup, selectedThread, statusFilter]);

  const openDispatch = (requirement: Requirement) => {
    const targets = sourceThreads(requirement);
    if (!targets.length) return;
    setDispatchTarget(requirement);
    setDispatchThreadId(targets[0].threadId);
    setDispatchMode("existing_session");
    setDispatchError("");
  };
  const closeDispatch = () => {
    if (isDispatching) return;
    setDispatchTarget(null);
    setDispatchError("");
  };
  const submitDispatch = async () => {
    if (!dispatchTarget?.id || !dispatchThreadId) return;
    setIsDispatching(true);
    setDispatchError("");
    try {
      const response = await fetch(`${controlServerUrl}/dispatch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ReqRadar-Action": "delegate",
        },
        body: JSON.stringify({
          requirementId: dispatchTarget.id,
          threadId: dispatchThreadId,
          mode: dispatchMode,
        }),
      });
      const payload = await response.json() as { dispatch?: DispatchRecord; error?: string };
      if (!response.ok || !payload.dispatch) {
        throw new Error(payload.error || "发送失败，请确认本地控制服务正在运行。");
      }
      setDispatches((current) => [payload.dispatch!, ...current.filter((item) => item.id !== payload.dispatch!.id)]);
      setDispatchTarget(null);
    } catch (error) {
      setDispatchError(error instanceof Error ? error.message : "发送失败，请稍后重试。");
    } finally {
      setIsDispatching(false);
    }
  };
  const cancelDispatch = async (dispatch: DispatchRecord) => {
    const response = await fetch(`${controlServerUrl}/dispatches/${dispatch.id}/cancel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ReqRadar-Action": "delegate",
      },
      body: "{}",
    });
    const payload = await response.json() as { dispatch?: DispatchRecord; error?: string };
    if (!response.ok || !payload.dispatch) {
      throw new Error(payload.error || "取消队列失败。");
    }
    setDispatches((current) => current.map((item) => item.id === payload.dispatch!.id ? payload.dispatch! : item));
  };
  const updateRequirement = async (requirement: Requirement, action: "complete" | "remove" | "restore") => {
    const id = overrideKey(requirement);
    if (!id) throw new Error("需求缺少稳定 ID，无法保存人工操作。");
    const response = await fetch(`${controlServerUrl}/requirements/${encodeURIComponent(id)}/decision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ReqRadar-Action": "delegate",
      },
      body: JSON.stringify({ action }),
    });
    const payload = await response.json() as {
      override?: RequirementOverride;
      requirementId?: string;
      error?: string;
    };
    if (!response.ok || !payload.override || !payload.requirementId) {
      throw new Error(payload.error || "保存人工操作失败。");
    }
    setRequirementOverrides((current) => ({
      ...current,
      [payload.requirementId!]: payload.override!,
    }));
  };
  const scanCodexSessions = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    setSyncMessage("");
    try {
      const response = await fetch(`${controlServerUrl}/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ReqRadar-Action": "delegate",
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
      setSyncMessage(payload.message || `已扫描 ${payload.threadCount ?? 0} 个会话，${payload.messageCount ?? 0} 条需求消息。`);
      void refreshLiveData();
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : "扫描失败，请稍后重试。");
    } finally {
      setIsSyncing(false);
    }
  };
  const selectedSessionIds = dashboard.source?.sessionSelection?.mode === "selected"
    ? dashboard.source.sessionSelection.threadIds
    : selectionThreads.map((thread) => asText(thread.id, ""));
  const openSessionPicker = () => {
    setPickerThreadIds(selectedSessionIds.filter(Boolean));
    setShowSessionPicker(true);
  };
  const saveSessionSelection = async (threadIds: string[]) => {
    setIsSavingSessionSelection(true);
    setSyncMessage("");
    try {
      const mode = threadIds.length === selectionThreads.length ? "all" : "selected";
      const response = await fetch(`${controlServerUrl}/session-selection`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-ReqRadar-Action": "delegate" },
        body: JSON.stringify({ mode, threadIds }),
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
  const removeSessionGroup = (sessionIds: string[]) => {
    void saveSessionSelection(selectedSessionIds.filter((id) => !sessionIds.includes(id)));
  };
  const selectThread = (threadId: string) => {
    setSelectedThread(threadId);
    setQuery("");
    setStatusFilter("all");
    setCategoryFilter("全部分类");
    setPriorityFilter("全部优先级");
  };
  const selectedThreadTitle = selectedThread === "全部任务"
    ? "全部任务"
    : asText(mergedThreads.find((thread) => thread.id === selectedThread)?.title, selectedThread);

  return (
    <main className="app-shell">
      <div className="grain" aria-hidden="true" />
      <header className="masthead">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <span>R</span>
            <span>R</span>
          </div>
          <div>
            <p className="eyebrow">LOCAL / CODEX MEMORY</p>
            <p className="brand-name">REQ<span>/</span>RADAR</p>
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
          <p className="eyebrow orange">需求审计台 / {new Date().getFullYear()}</p>
          <h1>把聊天里的承诺，<em>变成可验收的需求。</em></h1>
          <p className="hero-description">
            按 Codex 任务拆开每一次讨论，区分已经落地、只做了一半，以及仍然没有真正实现的部分。
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
                添加会话
              </button>
              <button className="scan-button" onClick={scanCodexSessions} disabled={isSyncing}>
                {isSyncing ? "扫描中…" : "手动扫描"}
              </button>
              <button className="refresh-button" onClick={() => void refreshLiveData(true)} disabled={isRefreshing}>
                {isRefreshing ? "刷新中…" : "刷新数据"}
              </button>
              <span className="count-pill">{mergedThreads.length}</span>
            </div>
          </div>
          {syncMessage && <p className="sync-message" role="status">{syncMessage}</p>}
          {refreshMessage && <p className="refresh-message" role="status" aria-live="polite">{refreshMessage}</p>}
          {showSessionPicker && (
            <section className="session-picker" aria-label="选择需要记录的会话">
              <div className="session-picker-heading">
                <strong>选择要记录的会话</strong>
                <button onClick={() => setShowSessionPicker(false)}>关闭</button>
              </div>
              <p>未勾选的会话不会参与需求识别，但原始会话文件不会被删除。</p>
              <div className="session-picker-list">
                {selectionGroups.map((group) => {
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
                      <span><strong>{asText(group.title, "未命名会话")}</strong><small>{group.requirementCount ?? 0} 条消息 · {group.sessionCount} 个会话 · 已选 {selectedCount}</small></span>
                    </label>
                  );
                })}
              </div>
              <div className="session-picker-actions">
                <button onClick={() => setPickerThreadIds(selectionThreads.map((thread) => asText(thread.id, "")).filter(Boolean))}>全选</button>
                <button onClick={() => setPickerThreadIds([])}>清空</button>
                <button className="session-save-button" onClick={() => void saveSessionSelection(pickerThreadIds)} disabled={isSavingSessionSelection}>
                  {isSavingSessionSelection ? "保存中…" : `保存（${pickerThreadIds.length}）`}
                </button>
              </div>
            </section>
          )}
          <button
            className={`thread-item ${selectedThread === "全部任务" ? "selected" : ""}`}
            onClick={() => selectThread("全部任务")}
          >
            <span className="thread-number">00</span>
            <span className="thread-content">
              <strong>全部任务</strong>
              <small>{requirements.length} 条需求记录</small>
            </span>
            <span className="thread-arrow">↗</span>
          </button>
          {mergedThreads.map((thread, index) => {
            const id = asText(thread.id, `thread-${index}`);
            const sessionIds = thread.sessionIds ?? [id];
            const registeredSession = sessionIds.map((sessionId) => sessionStatuses[sessionId]).find((session) => session?.status === "registered");
            const sessionStatus = registeredSession ?? sessionIds.map((sessionId) => sessionStatuses[sessionId]).find(Boolean);
            const threadCount = thread.requirementCount ?? thread.requirementsCount ?? requirements.filter((item) =>
              sessionIds.includes(item.threadId ?? "") || sourceItems(item).some((source) => sessionIds.includes(source.threadId ?? "")),
            ).length;
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
                    {threadCount} 条消息 · {normalizeDate(thread.updatedAt ?? thread.lastActivity)} · {" "}
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
          <TaskLedger
            tasks={tasks}
            availableThreads={mergedThreads}
            sessionGroups={mergedThreads}
            selectedSessionId={selectedThread}
            sessionStatuses={sessionStatuses}
            onTaskUpdated={(updatedTask) => {
              setTasks((current) => current.map((task) => task.id === updatedTask.id ? updatedTask : task));
            }}
          />

          <details className="requirement-section">
            <summary className="requirement-section-toggle">
              <span>📋</span>
              需求卡片（{filteredRequirements.length} 条）
            </summary>

            <div className="board-header" style={{ marginTop: 20 }}>
              <div>
                <p className="eyebrow">REQUIREMENTS BOARD</p>
                <h2>实现状态 · {selectedThreadTitle} <span>{filteredRequirements.length} / {boardRequirements.length}</span></h2>
              </div>
              <div className="view-switcher" role="group" aria-label="视图切换">
                <button className={view === "cards" ? "active" : ""} onClick={() => setView("cards")} aria-label="卡片视图">四格</button>
                <button className={view === "rows" ? "active" : ""} onClick={() => setView("rows")} aria-label="列表视图">横列</button>
              </div>
            </div>

            <div className="filters">
              <label className="search-box">
                <span aria-hidden="true">⌕</span>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索需求、缺口或证据" />
              </label>
              <FilterSelect label="状态" value={statusFilter} onChange={(value) => setStatusFilter(value as StatusFilter)} options={["active", "all", "verified", "in_progress", "partial", "missing", "needs_validation", "untriaged"]} displayOptions={["优先看缺口", "全部状态", "已验收", "进行中", "部分完成", "未实现", "待验证", "待整理"]} />
              <FilterSelect label="分类" value={categoryFilter} onChange={setCategoryFilter} options={categories} displayOptions={categories} />
              <FilterSelect label="优先级" value={priorityFilter} onChange={setPriorityFilter} options={priorities} displayOptions={priorities.map((item) => priorityMeta[item] ?? item)} />
            </div>

            <div className={`requirement-grid ${view === "rows" ? "rows-view" : ""}`}>
              {filteredRequirements.map((requirement, index) => (
                <RequirementCard
                  key={requirement.id ?? `${requirement.title}-${index}`}
                  requirement={requirement}
                  index={index}
                  compact={view === "rows"}
                  dispatch={dispatches.find((item) => item.requirementId === requirement.id)}
                  associatedTasks={tasks.filter((task) => task.requirementId === requirement.id)}
                  onContinue={openDispatch}
                  onCancelDispatch={cancelDispatch}
                  onUpdateRequirement={updateRequirement}
                />
              ))}
            </div>
            {!filteredRequirements.length && <EmptyBoard hasData={requirements.length > 0} />}
          </details>

                    <RemovedRequirements
            items={removedRequirements}
            show={showRemoved}
            onToggle={() => setShowRemoved((current) => !current)}
            onRestore={(requirement) => updateRequirement(requirement, "restore")}
          />
        </section>
      </div>

      <footer className="footer-bar">
        <span>REQ/RADAR · 独立项目管理工具</span>
        <span>最近同步：{normalizeDate(dashboard.generatedAt)}</span>
        <span>源：{dashboard.source?.mode ?? "read-only local JSONL"}</span>
      </footer>
      {dispatchTarget && (
        <DispatchDialog
          requirement={dispatchTarget}
          threadId={dispatchThreadId}
          mode={dispatchMode}
          onThreadChange={setDispatchThreadId}
          onModeChange={setDispatchMode}
          onCancel={closeDispatch}
          onConfirm={submitDispatch}
          error={dispatchError}
          submitting={isDispatching}
        />
      )}
    </main>
  );
}

function FilterSelect({ label, value, onChange, options, displayOptions }: { label: string; value: string; onChange: (value: string) => void; options: string[]; displayOptions: string[] }) {
  return (
    <label className="filter-select">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option, index) => <option value={option} key={option}>{displayOptions[index] ?? option}</option>)}
      </select>
    </label>
  );
}

const taskStatusMeta: Record<TaskStatus, { label: string; tone: string }> = {
  planned: { label: "已登记", tone: "planned" },
  in_progress: { label: "进行中", tone: "in-progress" },
  blocked: { label: "已阻塞", tone: "blocked" },
  done_claimed: { label: "已完成", tone: "done-claimed" },
  verified: { label: "已验收", tone: "verified" },
  cancelled: { label: "已取消", tone: "cancelled" },
};

const TASKS_PER_PAGE = 40;

function TaskLedger({ tasks, availableThreads: threadsForTask, sessionGroups, selectedSessionId, sessionStatuses, onTaskUpdated }: { tasks: TaskRecord[]; availableThreads: Thread[]; sessionGroups: SessionGroup[]; selectedSessionId: string; sessionStatuses: Record<string, SessionStatus>; onTaskUpdated: (task: TaskRecord) => void }) {
  // 筛选逻辑：全部任务显示全局，具体 Session 优先精确 session_id，不可用时按显式项目标识回退
  const selectedSessionIds = sessionIdsForGroup(selectedSessionId, sessionGroups);
  const filteredTasks = selectedSessionId === "全部任务"
    ? tasks
    : tasks.filter((task) => taskMatchesSession(task, {
      selectedSessionIds,
      availableSessionIds: threadsForTask.flatMap((thread) => [thread.id, ...(thread.sessionIds ?? [])]).filter(Boolean),
      selectedThread: sessionGroups.find((thread) => thread.id === selectedSessionId),
    }));
  const [page, setPage] = useState(1);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | TaskStatus>("all");
  const [agentFilter, setAgentFilter] = useState("all");
  const [timeFilter, setTimeFilter] = useState<"all" | "stale" | "overdue">("all");
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");
  const [showArchived, setShowArchived] = useState(false);
  const reviewCount = filteredTasks.filter((task) => (showArchived || !task.archivedAt) && task.status === "done_claimed").length;
  const agents: string[] = [...new Set(filteredTasks.map((task) => task.agent || "unknown"))];
  const searchedTasks = filteredTasks.filter((task) => showArchived || !task.archivedAt).filter((task) => statusFilter === "all" || task.status === statusFilter).filter((task) => agentFilter === "all" || (task.agent || "unknown") === agentFilter).filter((task) => timeFilter === "all" || taskTimeState(task)[timeFilter]).filter((task) => !query || `${task.title} ${task.id} ${task.sessionId}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => (Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || "")) * (sortOrder === "newest" ? 1 : -1));
  const shownTasks = reviewOnly ? searchedTasks.filter((task) => task.status === "done_claimed") : searchedTasks;
  const pageCount = Math.max(1, Math.ceil(shownTasks.length / TASKS_PER_PAGE));
  const visibleTasks = shownTasks.slice((page - 1) * TASKS_PER_PAGE, page * TASKS_PER_PAGE);

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  useEffect(() => {
    setPage(1);
  }, [selectedSessionId, query, statusFilter, agentFilter, timeFilter, sortOrder, showArchived, reviewOnly]);

  return (
    <section className="task-ledger" aria-label="会话主动任务">
      <div className="ledger-heading">
        <p className="eyebrow orange">SESSION TASK GATE</p>
        <h2>会话主动任务<span>{filteredTasks.length}</span></h2>
        <button type="button" className="task-filter-button" onClick={() => setReviewOnly((value) => !value)}>{reviewOnly ? "全部任务" : `待验收 ${reviewCount}`}</button>
        <input aria-label="搜索任务" placeholder="标题 / ID / Session" value={query} onChange={(event) => setQuery(event.target.value)} />
        <select aria-label="任务状态" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "all" | TaskStatus)}><option value="all">全部状态</option>{Object.keys(taskStatusMeta).map((status) => <option key={status} value={status}>{taskStatusMeta[status as TaskStatus].label}</option>)}</select>
        <select aria-label="任务 Agent" value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)}><option value="all">全部 Agent</option>{agents.map((agent) => <option key={agent}>{agent}</option>)}</select>
        <select aria-label="时间筛选" value={timeFilter} onChange={(event) => setTimeFilter(event.target.value as "all" | "stale" | "overdue")}><option value="all">全部时间</option><option value="stale">陈旧</option><option value="overdue">逾期</option></select>
        <select aria-label="更新时间排序" value={sortOrder} onChange={(event) => setSortOrder(event.target.value as "newest" | "oldest")}><option value="newest">更新时间：最新</option><option value="oldest">更新时间：最早</option></select>
        <label><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> 显示归档</label>
      </div>
      {shownTasks.length === 0 ? (
        <p className="ledger-empty">
          {reviewOnly
            ? "当前没有待验收任务。"
            : selectedSessionId === "全部任务"
            ? "还没有已登记的会话主动任务。会话开始写代码前应先调用 reqradar_session_register 与 reqradar_task_create，取得 accepted=true 和 task_id 后再实施。"
            : "当前会话没有关联任务。"}
        </p>
      ) : (
        <>
          <div className="task-table-wrapper">
            <table className="task-table">
            <thead>
              <tr>
                <th>标题</th>
                <th>需求 ID</th>
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
              <button type="button" onClick={() => setPage((current) => current - 1)} disabled={page === 1}>上一页</button>
              <span>第 {page} / {pageCount} 页 · 每页 {TASKS_PER_PAGE} 条</span>
              <button type="button" onClick={() => setPage((current) => current + 1)} disabled={page === pageCount}>下一页</button>
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
  const [idCopyState, setIdCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const meta = taskStatusMeta[task.status] ?? taskStatusMeta.planned;
  const detailItems = [
    { label: "审核理由", items: task.reviewReason ? [`${task.reviewReason}${task.reviewedAt ? ` · ${normalizeDate(task.reviewedAt)}` : ""}`] : [] },
    { label: "假设", items: task.assumptions ?? [] },
    { label: "风险", items: task.risks ?? [] },
    { label: "取舍", items: task.tradeoffs ?? [] },
    { label: "待确认", items: task.openQuestions ?? [] },
    { label: "复盘", items: task.retrospective ? [task.retrospective] : [] },
  ];
  const nonEmptyDetails = detailItems.filter((item) => item.items.length > 0);
  const stepText = task.currentStep ?? task.nextAction;
  const goalOrStep = task.goal || stepText ? `${asText(task.goal)}${stepText ? ` · ${asText(stepText)}` : ""}` : "—";
  const isDemo = task.id.startsWith("ui-demo-");
  const timeState = taskTimeState(task);

  const sessionInfo = useMemo(
    () => resolveTaskSessionDisplay(task, threadsForTask.find((thread) => thread.id === task.sessionId || thread.sessionIds?.includes(task.sessionId))),
    [task, threadsForTask],
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
        headers: { "Content-Type": "application/json", "X-ReqRadar-Action": "delegate" },
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

  const handleSchedule = async (value: string) => {
    if (!value || Number.isNaN(Date.parse(value))) return;
    setActionState("loading");
    try {
      const response = await fetch(`${controlServerUrl}/tasks/${encodeURIComponent(task.id)}/actions`, { method: "POST", headers: { "Content-Type": "application/json", "X-ReqRadar-Action": "delegate" }, body: JSON.stringify({ action: "schedule", expectedAt: new Date(value).toISOString() }) });
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
      <td className="task-cell task-title-cell" title={asText(task.title, "未命名任务")}>
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
      <td className="task-cell"><code>{task.requirementId || "—"}</code></td>
      <td className="task-cell"><span className={`task-status status-${meta.tone}`}>{meta.label}</span>{timeState.stale && <small> · 陈旧</small>}{timeState.overdue && <small> · 已逾期</small>}</td>
      <td className="task-cell task-goal-cell" title={goalOrStep}>{goalOrStep}</td>
      <td className="task-cell task-blocker-cell" title={task.blocker || "—"}>{task.blocker ? asText(task.blocker) : "—"}</td>
      <td className="task-cell task-count-cell">
        {nonEmptyDetails.length > 0 ? (
          <button
            type="button"
            className="task-detail-preview"
            aria-expanded={detailsOpen}
            aria-controls={`task-details-${task.id}`}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            {nonEmptyDetails.map((item) => <span key={item.label}><b>{item.label}</b> {asText(item.items[0])}{item.items.length > 1 ? ` +${item.items.length - 1}` : ""}</span>)}
            <small>{detailsOpen ? "收起详情" : "查看详情"}</small>
          </button>
        ) : "—"}
      </td>
      <td className="task-cell task-session-cell" title={sessionInfo ? `${sessionInfo.title} · ${sessionInfo.detail}` : task.sessionId}>
        {sessionInfo ? (
          <>
            <strong>{sessionInfo.title}</strong>
            <small>{task.agent ?? "unknown"} · {sessionInfo.detail} · {sessionStatuses[task.sessionId]?.status === "registered" ? "已登记" : "未登记"}</small>
          </>
        ) : (
          <span className="no-session">{task.sessionId.slice(0, 8)}… 未关联会话</span>
        )}
      </td>
      <td className="task-cell task-metrics-cell">
        <div>开始：{normalizeDate(task.startedAt)}</div>
        <div>预计：{normalizeDate(task.expectedAt)}</div>
        <div>实际：{normalizeDate(task.actualAt)}</div>
        <div>耗时：{formatElapsed(timeState.elapsedMs)}</div>
        {task.archivedAt && <div>归档：{normalizeDate(task.archivedAt)}</div>}
        <div className="task-tools">工具：{Object.entries(task.toolCalls ?? {}).length ? Object.entries(task.toolCalls ?? {}).map(([name, count]) => `${name} ×${count}`).join("、") : "—"}</div>
      </td>
      <td className="task-cell task-actions-cell">
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
          <><button className="task-action-button action-done" onClick={() => handleAction("verify")} disabled={actionState === "loading"}>验收通过</button><button className="task-action-button action-block" onClick={() => handleAction("reject")} disabled={actionState === "loading"}>打回</button></>
        )}
        {task.status === "verified" && <span className="task-action-note">已验收</span>}
        {["planned", "in_progress", "blocked"].includes(task.status) && <button className="task-action-button action-block" onClick={() => handleAction("cancel")} disabled={actionState === "loading"}>取消</button>}
        {["planned", "in_progress", "blocked"].includes(task.status) && !scheduleEditing && <button className="task-action-button" onClick={() => { setScheduleEditing(true); setScheduleValue(toLocalDateTimeValue(task.expectedAt)); }}>设置预计时间</button>}
        {scheduleEditing && <span><input type="datetime-local" value={scheduleValue} onChange={(event) => setScheduleValue(event.target.value)} /><button className="task-action-button" onClick={() => { if (!scheduleValue || Number.isNaN(Date.parse(scheduleValue))) return; void handleSchedule(scheduleValue); }}>保存</button><button className="task-action-button" onClick={() => setScheduleEditing(false)}>取消</button></span>}
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
      {detailsOpen && nonEmptyDetails.length > 0 && (
        <tr id={`task-details-${task.id}`} className="task-detail-row">
          <td colSpan={9}>
            <div className="task-detail-content">
              {nonEmptyDetails.map((item) => <section key={item.label}><strong>{item.label}</strong><ul>{item.items.map((value, index) => <li key={`${item.label}-${index}`}>{value}</li>)}</ul></section>)}
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

function elapsedText(start?: string, end?: string) {
  const duration = Date.parse(end || "") - Date.parse(start || "");
  if (!Number.isFinite(duration) || duration < 0) return "—";
  const seconds = Math.floor(duration / 1000);
  return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}

function RequirementCard({
  requirement,
  index,
  compact,
  dispatch,
  associatedTasks,
  onContinue,
  onCancelDispatch,
  onUpdateRequirement,
}: {
  requirement: Requirement;
  index: number;
  compact: boolean;
  dispatch?: DispatchRecord;
  associatedTasks: TaskRecord[];
  onContinue: (requirement: Requirement) => void;
  onCancelDispatch: (dispatch: DispatchRecord) => Promise<void>;
  onUpdateRequirement: (requirement: Requirement, action: "complete" | "remove") => Promise<void>;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [cancelError, setCancelError] = useState("");
  const [manualAction, setManualAction] = useState<"" | "complete" | "remove">("");
  const [manualError, setManualError] = useState("");
  const status = requirement.status ?? "untriaged";
  const sources = sourceItems(requirement);
  const evidence = asList(requirement.evidence);
  const isActionable = ["partial", "in_progress"].includes(status);
  const canContinue = isActionable && Boolean(requirement.id) && !requirement.id?.startsWith("promoted-") && sourceThreads(requirement).length > 0;
  const evidencePaths = requirement.evidencePaths?.length ? requirement.evidencePaths : evidence.map(evidenceText);
  if (compact) {
    return (
      <article className={`requirement-card requirement-list-item status-card-${status}`} style={{ "--card-index": index } as React.CSSProperties}>
        <div className="list-main">
          <div className="card-topline">
            <span className="card-index">{String(index + 1).padStart(2, "0")}</span>
            <StatusBadge status={status} />
            <span className="priority-label">{priorityMeta[asText(requirement.priority, "未设置")] ?? asText(requirement.priority, "未设置")}</span>
          </div>
          <h3>{asText(requirement.title, "未命名需求")}</h3>
          <div className="requirement-meta" aria-label="需求归属">
            <span>{requirement.kind === "epic" ? "Epic" : "专业需求"}</span>
            {requirement.project && <span>项目：{requirement.project}</span>}
            {requirement.parentId && <span>父项：{parentTitle(requirement)}</span>}
          </div>
          <p className="card-summary">{asText(requirement.summary)}</p>
          {associatedTasks.length > 0 && <p className="list-gap">关联任务：{associatedTasks.map((task) => `${task.title}（${taskStatusMeta[task.status]?.label ?? task.status}）`).join("、")}</p>}
          <p className="list-gap">{asText(requirement.gap, status === "verified" ? "已有验收记录，继续保持回归验证。" : "还没有形成可验收记录。")}</p>
          <div className="list-meta-row">
            <div className="source-line">
              <span className="source-symbol">◎</span>
              <span>{sources.length ? asText(sources[0]?.threadTitle, asText(sources[0]?.threadId, "本地会话")) : "本地需求清单"}</span>
              {sources.length > 1 && <small>+{sources.length - 1}</small>}
            </div>
            {evidencePaths.length > 0 && <span className="list-evidence-count">证据 {evidencePaths.length}</span>}
            {requirement.claimedDone && <span className="claimed-mark" title="Codex 的完成表述不等于验收">Codex 声称完成</span>}
          </div>
        </div>

        <div className="list-side">
          {status !== "verified" && (
            <div className="manual-card-actions">
              <button
                className="manual-complete-button"
                disabled={Boolean(manualAction)}
                onClick={async () => {
                  setManualAction("complete");
                  setManualError("");
                  try {
                    await onUpdateRequirement(requirement, "complete");
                  } catch (error) {
                    setManualError(error instanceof Error ? error.message : "保存人工操作失败。");
                  } finally {
                    setManualAction("");
                  }
                }}
              >
                {manualAction === "complete" ? "保存中…" : "手动完成"}
              </button>
              <button
                className="manual-remove-button"
                disabled={Boolean(manualAction)}
                onClick={async () => {
                  setManualAction("remove");
                  setManualError("");
                  try {
                    await onUpdateRequirement(requirement, "remove");
                  } catch (error) {
                    setManualError(error instanceof Error ? error.message : "保存人工操作失败。");
                  } finally {
                    setManualAction("");
                  }
                }}
              >
                {manualAction === "remove" ? "移除中…" : "移除"}
              </button>
            </div>
          )}
          {status === "verified" && (
            <div className="manual-card-actions list-verified-actions">
              <button
                className="manual-remove-button"
                disabled={Boolean(manualAction)}
                onClick={async () => {
                  setManualAction("remove");
                  setManualError("");
                  try {
                    await onUpdateRequirement(requirement, "remove");
                  } catch (error) {
                    setManualError(error instanceof Error ? error.message : "保存人工操作失败。");
                  } finally {
                    setManualAction("");
                  }
                }}
              >
                {manualAction === "remove" ? "移除中…" : "移除"}
              </button>
            </div>
          )}
          {manualError && <small className="manual-action-error">{manualError}</small>}
          {isActionable && (
            <div className="list-actions">
              {canContinue
                ? <DispatchState dispatch={dispatch} />
                : <span className="dispatch-state idle">候选需求：可复制后手动续办</span>}
              <div className="card-action-buttons">
                {dispatch?.status === "queued" && (
                  <button
                    className="cancel-queue-button"
                    onClick={async () => {
                      setCancelError("");
                      try {
                        await onCancelDispatch(dispatch);
                      } catch (error) {
                        setCancelError(error instanceof Error ? error.message : "取消队列失败。");
                      }
                    }}
                  >
                    取消自动队列
                  </button>
                )}
                <button
                  className="copy-task-button"
                  onClick={async () => {
                    try {
                      await copyToClipboard(manualTaskText(requirement));
                      setCopyState("copied");
                    } catch {
                      setCopyState("failed");
                    }
                  }}
                >
                  {copyState === "copied" ? "已复制任务信息" : copyState === "failed" ? "复制失败，请重试" : "复制任务信息"}
                </button>
                {canContinue && (
                  <button
                    className="dispatch-button"
                    disabled={["queued", "delivering", "running"].includes(dispatch?.status ?? "")}
                    onClick={() => onContinue(requirement)}
                  >
                    {dispatch?.status === "queued" ? "等待原任务" : ["delivering", "running"].includes(dispatch?.status ?? "") ? "正在处理" : "转发到 Session"}
                  </button>
                )}
              </div>
              {cancelError && <small className="card-action-error">{cancelError}</small>}
            </div>
          )}
        </div>
      </article>
    );
  }
  return (
    <article className={`requirement-card status-card-${status}`} style={{ "--card-index": index } as React.CSSProperties}>
      <div className="card-topline">
        <span className="card-index">{String(index + 1).padStart(2, "0")}</span>
        <StatusBadge status={status} />
        <span className="priority-label">{priorityMeta[asText(requirement.priority, "未设置")] ?? asText(requirement.priority, "未设置")}</span>
      </div>
      <h3>{asText(requirement.title, "未命名需求")}</h3>
      {associatedTasks.length > 0 && <p className="card-summary">关联任务：{associatedTasks.map((task) => `${task.title}（${taskStatusMeta[task.status]?.label ?? task.status}）`).join("、")}</p>}
      <div className="requirement-meta" aria-label="需求归属">
        <span>{requirement.kind === "epic" ? "Epic" : "专业需求"}</span>
        {requirement.project && <span>项目：{requirement.project}</span>}
        {requirement.parentId && <span>父项：{parentTitle(requirement)}</span>}
      </div>
      <p className="card-summary">{asText(requirement.summary)}</p>
      <div className="card-detail-block gap-block">
        <span className="detail-label">当前缺口</span>
        <p>{asText(requirement.gap, status === "verified" ? "已有验收记录，继续保持回归验证。" : "还没有形成可验收记录。")}</p>
      </div>
      {requirement.implementationStages?.length ? (
        <div className="governance-block">
          <span className="detail-label">实施阶段</span>
          <ol className="governance-list">{requirement.implementationStages.map((stage) => <li key={stage}>{stage}</li>)}</ol>
        </div>
      ) : null}
      {requirement.acceptanceCriteria?.length ? (
        <div className="governance-block">
          <span className="detail-label">验收标准</span>
          <ul className="governance-list">{requirement.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
        </div>
      ) : null}
      {evidencePaths.length > 0 && (
        <div className="evidence-block">
          <span className="detail-label">验收证据路径</span>
          <div className="evidence-list">{evidencePaths.slice(0, compact ? 2 : 6).map((item) => <span key={item}>↳ {item}</span>)}</div>
        </div>
      )}
      <div className="card-footer">
        <div className="source-line">
          <span className="source-symbol">◎</span>
          <span>{sources.length ? asText(sources[0]?.threadTitle, asText(sources[0]?.threadId, "本地会话")) : "本地需求清单"}</span>
          {sources.length > 1 && <small>+{sources.length - 1}</small>}
        </div>
      {requirement.claimedDone && <span className="claimed-mark" title="Codex 的完成表述不等于验收">Codex 声称完成</span>}
      </div>
      <div className="manual-card-actions">
        {status !== "verified" && (
          <button
            className="manual-complete-button"
            disabled={Boolean(manualAction)}
            onClick={async () => {
              setManualAction("complete");
              setManualError("");
              try {
                await onUpdateRequirement(requirement, "complete");
              } catch (error) {
                setManualError(error instanceof Error ? error.message : "保存人工操作失败。");
              } finally {
                setManualAction("");
              }
            }}
          >
            {manualAction === "complete" ? "保存中…" : "手动完成"}
          </button>
        )}
        <button
          className="manual-remove-button"
          disabled={Boolean(manualAction)}
          onClick={async () => {
            setManualAction("remove");
            setManualError("");
            try {
              await onUpdateRequirement(requirement, "remove");
            } catch (error) {
              setManualError(error instanceof Error ? error.message : "保存人工操作失败。");
            } finally {
              setManualAction("");
            }
          }}
        >
          {manualAction === "remove" ? "移除中…" : "移除"}
        </button>
      </div>
      {manualError && <small className="manual-action-error">{manualError}</small>}
      {isActionable && (
        <div className="card-action-row">
          {canContinue
            ? <DispatchState dispatch={dispatch} />
            : <span className="dispatch-state idle">候选需求：可复制到任意 Session 手动续办</span>}
          <div className="card-action-buttons">
            {dispatch?.status === "queued" && (
              <button
                className="cancel-queue-button"
                onClick={async () => {
                  setCancelError("");
                  try {
                    await onCancelDispatch(dispatch);
                  } catch (error) {
                    setCancelError(error instanceof Error ? error.message : "取消队列失败。");
                  }
                }}
              >
                取消自动队列
              </button>
            )}
            <button
              className="copy-task-button"
              onClick={async () => {
                try {
                  await copyToClipboard(manualTaskText(requirement));
                  setCopyState("copied");
                } catch {
                  setCopyState("failed");
                }
              }}
            >
              {copyState === "copied" ? "已复制任务信息" : copyState === "failed" ? "复制失败，请重试" : "复制任务信息"}
            </button>
            {canContinue && (
              <button
                className="dispatch-button"
                disabled={["queued", "delivering", "running"].includes(dispatch?.status ?? "")}
                onClick={() => onContinue(requirement)}
              >
                {dispatch?.status === "queued" ? "等待原任务" : ["delivering", "running"].includes(dispatch?.status ?? "") ? "正在处理" : "转发到 Session"}
              </button>
            )}
          </div>
          {cancelError && <small className="card-action-error">{cancelError}</small>}
          {!canContinue && (
            <small className="card-action-note">
              其他 Session 的完成声明不会自动变成“已验收”，仍需同步证据或人工验收。
            </small>
          )}
        </div>
      )}
      {!compact && sources[0]?.excerpt && (
        <blockquote className="source-excerpt">“{sources[0].excerpt}”</blockquote>
      )}
      {requirement.claimedDone && <p className="claim-note">完成表述仅作线索，仍需代码或测试证据验收。</p>}
    </article>
  );
}

function DispatchState({ dispatch }: { dispatch?: DispatchRecord }) {
  if (!dispatch) return <span className="dispatch-state idle">尚未投递</span>;
  const meta: Record<DispatchStatus, string> = {
    dry_run: "测试发送成功",
    delivering: "正在投递消息",
    delivered: "已投递到 Session",
    delivered_hidden: "已进入任务，但来源卡片不可见",
    failed: "上次投递失败",
    queued: "目标任务忙碌，已进入安全队列",
    running: "消息已出现，Codex 正在处理",
    completed: "原 Session 本次处理已结束",
    cancelled: "已取消自动队列，可手动发送",
  };
  if (dispatch.status === "failed") {
    return (
      <span className="dispatch-state dispatch-failed">
        <strong>{meta.failed}</strong>
        {dispatch.error && <small>{dispatch.error}</small>}
      </span>
    );
  }
  if (dispatch.status === "delivered_hidden") {
    return (
      <span className="dispatch-state dispatch-hidden">
        <strong>{meta.delivered_hidden}</strong>
        {dispatch.error && <small>{dispatch.error}</small>}
      </span>
    );
  }
  if (dispatch.status === "delivered") {
    return (
      <span
        className="dispatch-state dispatch-delivered"
        title={`Session ${dispatch.threadId} · ${normalizeDate(dispatch.updatedAt)}`}
      >
        <strong>已投递至 {dispatch.threadTitle || "目标 Session"}</strong>
        <small>{normalizeDate(dispatch.updatedAt)} · {dispatch.threadId.slice(0, 8)}…</small>
      </span>
    );
  }
  return (
    <span className={`dispatch-state dispatch-${dispatch.status}`} title={dispatch.error || normalizeDate(dispatch.updatedAt)}>
      {meta[dispatch.status]}
    </span>
  );
}

function DispatchDialog({
  requirement,
  threadId,
  mode,
  onThreadChange,
  onModeChange,
  onCancel,
  onConfirm,
  error,
  submitting,
}: {
  requirement: Requirement;
  threadId: string;
  mode: DispatchMode;
  onThreadChange: (value: string) => void;
  onModeChange: (value: DispatchMode) => void;
  onCancel: () => void;
  onConfirm: () => void;
  error: string;
  submitting: boolean;
}) {
  const targets = sourceThreads(requirement);
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <section className="dispatch-dialog" role="dialog" aria-modal="true" aria-labelledby="dispatch-title">
        <p className="eyebrow orange">CODEX TASK ROUTING</p>
        <h2 id="dispatch-title">选择 Codex 处理方式</h2>
        <p className="dialog-requirement">{asText(requirement.title, "未命名需求")}</p>
        <div className="dialog-gap">
          <span>要转发的剩余需求</span>
          <p>{asText(requirement.gap, "尚未记录剩余缺口。")}</p>
        </div>
        <fieldset className="dispatch-mode-picker">
          <legend>处理方式</legend>
          <label className={mode === "new_session" ? "selected" : ""}>
            <input
              type="radio"
              name="dispatch-mode"
              value="new_session"
              checked={mode === "new_session"}
              onChange={() => onModeChange("new_session")}
            />
            <span>
              <strong>新建 Session</strong>
              <small>注入需求摘要、缺口、证据和工作目录，独立处理，避免与当前对话并发混淆。</small>
            </span>
          </label>
          <label className={mode === "existing_session" ? "selected" : ""}>
            <input
              type="radio"
              name="dispatch-mode"
              value="existing_session"
              checked={mode === "existing_session"}
              onChange={() => onModeChange("existing_session")}
            />
            <span>
              <strong>原 Session 继续</strong>
              <small>使用 Codex CLI 追加到原任务；目标正在运行时先排队，结束后自动投递。</small>
            </span>
          </label>
        </fieldset>
        <label className="dialog-select">
          <span>{mode === "new_session" ? "上下文来源 Session" : "目标 Codex Session"}</span>
          <select value={threadId} onChange={(event) => onThreadChange(event.target.value)}>
            {targets.map((target) => <option key={target.threadId} value={target.threadId}>{target.threadTitle}</option>)}
          </select>
        </label>
        <div className="dispatch-warning">
          <strong>{mode === "new_session" ? "将创建独立 Codex 任务" : "将安全追加到原 Session"}</strong>
          <p>{mode === "new_session"
            ? "新任务只注入这条需求所需的压缩上下文，不加载整段原对话；创建成功后会记录新 Session ID。"
            : "系统会检查原任务是否仍有未完成 turn；忙碌时持久化排队，空闲后调用 Codex CLI，并在本地 JSONL 确认消息真实出现。"}</p>
        </div>
        {error && <p className="dispatch-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="dialog-cancel" onClick={onCancel} disabled={submitting}>先不发送</button>
          <button className="dialog-confirm" onClick={onConfirm} disabled={submitting || !threadId}>
            {submitting ? "正在处理…" : mode === "new_session" ? "确认新建 Session" : "确认原 Session 继续"}
          </button>
        </div>
      </section>
    </div>
  );
}

function EmptyBoard({ hasData }: { hasData: boolean }) {
  return (
    <div className="empty-board">
      <div className="empty-symbol">∅</div>
      <div>
        <h3>{hasData ? "没有符合筛选条件的需求" : "看板正在等待会话数据"}</h3>
        <p>{hasData ? "试试清空搜索或切换状态筛选。" : "先运行同步器，ReqRadar 会从本地 Codex JSONL 生成需求卡片。"}</p>
      </div>
    </div>
  );
}

function RemovedRequirements({
  items,
  show,
  onToggle,
  onRestore,
}: {
  items: Requirement[];
  show: boolean;
  onToggle: () => void;
  onRestore: (requirement: Requirement) => Promise<void>;
}) {
  if (!items.length) return null;
  return (
    <section className="removed-section">
      <button className="history-toggle" onClick={onToggle}>
        {show ? "收起已移除需求" : `查看已移除需求 ${items.length}`}
      </button>
      {show && (
        <div className="removed-list">
          {items.map((item) => (
            <div className="removed-item" key={item.id}>
              <span>{asText(item.title, "未命名需求")}</span>
              <button onClick={() => void onRestore(item)}>恢复</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Inbox({
  decisions,
  excludedCount,
  excludedItems,
  items,
  onDecision,
  onToggleProcessed,
  onToggleClassificationAudit,
  showClassificationAudit,
  showProcessed,
}: {
  decisions: Record<string, InboxDecision>;
  excludedCount: number;
  excludedItems: ExcludedItem[];
  items: Requirement[];
  onDecision: (id: string, decision?: InboxDecision) => void;
  onToggleProcessed: () => void;
  onToggleClassificationAudit: () => void;
  showClassificationAudit: boolean;
  showProcessed: boolean;
}) {
  const pending = items.filter((item, index) => !decisions[requirementKey(item, index)]);
  const processed = items.filter((item, index) => decisions[requirementKey(item, index)]);
  return (
    <section className="inbox-section">
      <div className="inbox-heading">
        <div>
          <p className="eyebrow">UNTRIAGED NOTES</p>
          <h2>待整理 inbox <span>{pending.length}</span></h2>
        </div>
        <div className="inbox-heading-actions">
          <p>继续会加入主看板，丢弃可在已处理记录中撤销。</p>
          {!!excludedCount && (
            <p className="classification-note">已自动排除 {excludedCount} 条一次性动作、提问或协作指令。</p>
          )}
          {!!excludedItems.length && (
            <button className="history-toggle" onClick={onToggleClassificationAudit}>
              {showClassificationAudit ? "收起分类审计" : `查看分类审计 ${excludedItems.length}`}
            </button>
          )}
          {!!processed.length && (
            <button className="history-toggle" onClick={onToggleProcessed}>
              {showProcessed ? "收起已处理" : `查看已处理 ${processed.length}`}
            </button>
          )}
        </div>
      </div>
      {pending.length ? (
        <div className="inbox-list">{pending.map((item, index) => {
          const source = sourceItems(item)[0];
          const id = requirementKey(item, items.indexOf(item));
          return (
            <div className="inbox-item" key={id}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div className="inbox-copy">
                {item.title !== item.summary && <strong>{asText(item.title)}</strong>}
                <p>{asText(item.summary, asText(item.title))}</p>
              </div>
              <small>{asText(source?.threadTitle, asText(source?.threadId, "本地会话"))}</small>
              <div className="inbox-actions">
                <button className="continue-button" onClick={() => onDecision(id, "continue")}>继续推进</button>
                <button className="discard-button" onClick={() => onDecision(id, "discard")}>丢弃</button>
              </div>
            </div>
          );
        })}</div>
      ) : (
        <div className="inbox-empty"><span>✓</span>待整理 inbox 已清空。</div>
      )}
      {showProcessed && !!processed.length && (
        <div className="processed-inbox">
          <p className="processed-title">已处理记录</p>
          {processed.map((item) => {
            const id = requirementKey(item, items.indexOf(item));
            const decision = decisions[id];
            return (
              <div className="processed-item" key={id}>
                <span className={`decision-mark decision-${decision}`}>
                  {decision === "continue" ? "继续推进" : "已丢弃"}
                </span>
                <p>{asText(item.summary, asText(item.title))}</p>
                <button onClick={() => onDecision(id)}>撤销</button>
              </div>
            );
          })}
        </div>
      )}
      {showClassificationAudit && !!excludedItems.length && (
        <div className="classification-audit">
          <p className="processed-title">分类审计：这些消息未进入需求池</p>
          {excludedItems.map((item) => (
            <div className="audit-item" key={item.id}>
              <span>{classificationLabel(item.classification)}</span>
              <p>{item.text}</p>
              <small>{item.threadTitle}</small>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function classificationLabel(classification: string) {
  return {
    operation: "一次性动作",
    question: "状态提问",
    collaboration: "协作指令",
    other: "非需求消息",
  }[classification] ?? classification;
}
