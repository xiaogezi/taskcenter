"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseTaskWorkspaceSearch, taskAxes, taskListRequestKey } from "@/lib/task-workspace.mjs";

type Reason = { code: string; label: string; detail?: string };
type ExecutionModelPolicy = {
  mode?: string;
  preferred_model?: string;
  quota_limit_id?: string;
  fallback_on_exhaustion?: boolean;
  authorization_reason?: string;
};
type TaskTokenUsage = { usage: { input: number; cachedInput: number; output: number; reasoning: number }; totalTokens: number; count: number; attribution: "estimated" | "unattributed" };
type RoutingInfo = { action?: string; orchestratorModel?: string; preferredExecutorModel?: string; selectedExecutorModel?: string; reasoningEffort?: string; dispatchChannel?: string; reason?: string; outcome?: string; preferenceMode?: string; fallbackReason?: string; quotaLimitId?: string; quotaSnapshotObservedAt?: string; quotaUsedPercent?: number; quotaResetAt?: string; };
type Task = Record<string, unknown> & { id: string; title?: string; status?: string; updatedAt?: string; verificationStatus?: string; reviewStatus?: string; acceptanceStatus?: string; currentStep?: string; nextAction?: string; blocker?: string; goal?: string; evidence?: string[]; changedFiles?: string[]; tests?: string[]; revision?: string; currentSubject?: { type?: string; value?: string }; project?: { id: string; label: string }; actionReasons?: Reason[]; routing?: RoutingInfo; routingHistory?: RoutingInfo[]; executionModelPolicy?: ExecutionModelPolicy; tokenUsage?: TaskTokenUsage | null };
type State = ReturnType<typeof parseTaskWorkspaceSearch>;
const labels: Record<string, string> = { planned: "计划中", in_progress: "执行中", blocked: "已阻塞", done_claimed: "已声明完成", verified: "已验证", cancelled: "已取消", passed: "通过", pending: "待处理", failed: "失败", stale: "已过期", changes_requested: "需修改", ready: "就绪", accepted: "已验收", rejected: "已拒绝", not_required: "不要求", unknown: "未知" };
const text = (value: unknown) => typeof value === "string" && value.trim() ? value : "未知";
const formatDate = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "未知";
const tokenFormatter = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 });
const formatTokens = (value: number) => tokenFormatter.format(Math.max(0, Number(value || 0)));
const freshnessText = (value: unknown) => {
  if (typeof value !== "string") return "未记录";
  const at = Date.parse(value);
  if (Number.isNaN(at)) return "未记录";
  return `${Math.max(0, Math.floor((Date.now() - at) / 60000))} 分钟`;
};
const emptyTasks: Task[] = [];

export function TaskWorkspace() {
  const [state, setState] = useState<State>(() => parseTaskWorkspaceSearch(typeof window === "undefined" ? "" : window.location.search));
  const [payload, setPayload] = useState<{ tasks?: Task[]; total?: number; totalPages?: number; actionCounts?: Record<string, number>; projects?: Array<{ id: string; label: string }> }>({});
  const [loadedListKey, setLoadedListKey] = useState("");
  const [pollTick, setPollTick] = useState(0);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<{ taskId: string; value: Task | null }>({ taskId: "", value: null });
  const [events, setEvents] = useState<{ taskId: string; values: Record<string, unknown>[] }>({ taskId: "", values: [] });
  const listInFlight = useRef(false);
  const listKey = taskListRequestKey(state);

  const update = useCallback((patch: Partial<State>) => {
    const next = { ...state, ...patch };
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(next)) if (value && !(key === "project" && value === "all") && !(key === "bucket" && value === "all") && !(key === "page" && value === 1) && !(key === "tab" && value === "overview")) params.set(key, String(value));
    window.history.pushState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
    setState(next);
  }, [state]);

  useEffect(() => {
    const onPopState = () => setState(parseTaskWorkspaceSearch(window.location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible" && !listInFlight.current) setPollTick((current) => current + 1); }, 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    listInFlight.current = true;
    const params = new URLSearchParams({ view: "summary", page: String(state.page), page_size: "20" });
    if (state.project !== "all") params.set("project", state.project);
    if (state.bucket !== "all") params.set("bucket", state.bucket);
    if (state.query) params.set("query", state.query);
    fetch(`/api/control/tasks?${params}`, { signal: controller.signal })
      .then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error || "任务摘要加载失败"); return body; })
      .then((body) => { setPayload(body); setError(""); }).catch((cause) => { if (cause.name !== "AbortError") setError(cause.message || "任务摘要加载失败"); })
      .finally(() => { listInFlight.current = false; if (!controller.signal.aborted) setLoadedListKey(listKey); });
    return () => controller.abort();
  }, [listKey, pollTick, state.bucket, state.page, state.project, state.query]);

  useEffect(() => {
    if (!state.task) return;
    const controller = new AbortController();
    fetch(`/api/control/tasks/${encodeURIComponent(state.task)}`, { signal: controller.signal })
      .then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error || "任务详情加载失败"); return body.task as Task; })
      .then((value) => { if (!controller.signal.aborted) setDetail({ taskId: state.task, value }); }).catch(() => { if (!controller.signal.aborted) setDetail({ taskId: state.task, value: null }); });
    fetch(`/api/control/tasks/${encodeURIComponent(state.task)}/events?limit=50`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : { events: [] }).then((body) => { if (!controller.signal.aborted) setEvents({ taskId: state.task, values: body.events || [] }); }).catch(() => { if (!controller.signal.aborted) setEvents({ taskId: state.task, values: [] }); });
    return () => controller.abort();
  }, [state.task]);

  const tasks = payload.tasks ?? emptyTasks;
  const loading = loadedListKey !== listKey;
  const projects = payload.projects || [];
  const counts = payload.actionCounts || {};

  return <main className={state.task ? "task-workspace with-open-detail" : "task-workspace"}>
    <aside className="task-nav"><a className="task-logo" href="/tasks">TASK<span>CENTER</span></a><nav><a className="active" href="/tasks">任务工作区</a><a href="/sessions">会话</a><a href="/routing">模型调度</a><a href="/improvements">改进建议</a><a href="/settings">设置</a><a href="/legacy">旧版首页</a></nav></aside>
    <section className="task-main"><header className="task-header"><div><p>LOCAL CONTROL API</p><h1>任务工作区</h1><small>任务事实、证据与活动均来自本地 Control API。</small></div><a href="/legacy">查看旧版看板</a></header>
      <section className="task-stats" aria-label="任务统计">{([['attention','需处理'],['in_progress','执行中'],['awaiting_verification','待验证'],['awaiting_acceptance','待验收'],['blocked','阻塞'],['all','全部']] as const).map(([bucket, label]) => <button className={state.bucket === bucket ? "selected" : ""} key={bucket} onClick={() => update({ bucket, page: 1 })}><strong>{counts[bucket] ?? "未知"}</strong><span>{label}</span></button>)}</section>
      <section className="task-filters"><select value={state.project} onChange={(event) => update({ project: event.target.value, page: 1 })}><option value="all">全部项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.label}</option>)}</select><input value={state.query} onChange={(event) => update({ query: event.target.value, page: 1 })} placeholder="搜索标题、ID 或目标" /><span>共 {payload.total ?? "未知"} 条</span></section>
      {error && <p className="task-error" role="status">{error}</p>}<div className="task-table-wrap"><table className="task-table"><thead><tr><th>状态</th><th>任务名称</th><th>项目</th><th>当前阶段</th><th>执行模型</th><th>Token</th><th>更新时间</th></tr></thead><tbody>{loading && !tasks.length ? <tr><td colSpan={7}>正在加载真实任务摘要…</td></tr> : tasks.length ? tasks.map((task) => {
        const route = task.routing || task.routingHistory?.at(-1);
        const modelCell = [route?.preferredExecutorModel, route?.selectedExecutorModel].filter(Boolean).join(" → ");
        return <tr key={task.id} className={state.task === task.id ? "selected" : ""} onClick={() => update({ task: task.id, tab: "overview" })}>
          <td><span className={`status-chip status-${text(task.status)}`}>{labels[text(task.status)] || text(task.status)}</span>{(task.actionReasons || []).length > 0 && <small className="attention">需处理</small>}</td>
          <td><strong>{text(task.title)}</strong><small>{task.id}</small></td><td>{text(task.project?.label)}</td><td>{text(task.currentStep)}</td>
          <td>{modelCell || "未记录"}</td>
          <td title={task.tokenUsage ? `精确值：${task.tokenUsage.totalTokens.toLocaleString("zh-CN")} Token` : undefined}>{task.tokenUsage ? formatTokens(task.tokenUsage.totalTokens) : "暂无归属"}</td>
          <td>{formatDate(task.updatedAt)}</td>
        </tr>;
      }) : <tr><td colSpan={7}>没有匹配的真实任务。</td></tr>}</tbody></table></div>
      <footer className="task-pagination"><button disabled={state.page <= 1} onClick={() => update({ page: state.page - 1 })}>上一页</button><span>第 {state.page} / {payload.totalPages ?? "未知"} 页</span><button disabled={Boolean(payload.totalPages) && state.page >= Number(payload.totalPages)} onClick={() => update({ page: state.page + 1 })}>下一页</button></footer>
    </section>
    {state.task && <aside className="task-detail" aria-label="任务详情"><button className="detail-close" onClick={() => update({ task: "", tab: "overview" })}>关闭</button><h2>{text((detail.taskId === state.task ? detail.value?.title : undefined) || tasks.find((task) => task.id === state.task)?.title)}</h2><small>{state.task}</small><div className="detail-tabs">{([['overview','概览'],['routing','调度'],['evidence','证据'],['activity','活动']] as const).map(([tab, label]) => <button className={state.tab === tab ? "selected" : ""} key={tab} onClick={() => update({ tab })}>{label}</button>)}</div>{state.tab === "overview" && <DetailOverview task={detail.taskId === state.task ? detail.value : null} />}{state.tab === "routing" && <RoutingDetails task={detail.taskId === state.task ? detail.value : null} />}{state.tab === "evidence" && <Evidence task={detail.taskId === state.task ? detail.value : null} />}{state.tab === "activity" && <Activity events={events.taskId === state.task ? events.values : []} />}</aside>}
  </main>;
}

function DetailOverview({ task }: { task: Task | null }) { const route = task?.routing || task?.routingHistory?.at(-1); const tokenSummary = task?.tokenUsage ? `${formatTokens(task.tokenUsage.totalTokens)} Token · 输入 ${formatTokens(task.tokenUsage.usage.input)} · 缓存 ${formatTokens(task.tokenUsage.usage.cachedInput)} · 输出 ${formatTokens(task.tokenUsage.usage.output)} · 推理 ${formatTokens(task.tokenUsage.usage.reasoning)}` : "暂无归属"; return <div className="detail-content"><h3>目标</h3><p>{text(task?.goal)}</p><dl>{[["当前步骤", task?.currentStep], ["下一步", task?.nextAction], ["阻塞", task?.blocker], ["执行模型", route?.selectedExecutorModel], ["Token（估算）", tokenSummary], ["选择理由", route?.reason]].map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{text(value)}</dd></div>)}{taskAxes(task || {}).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{labels[text(value)] || text(value)}</dd></div>)}</dl><h3>需处理原因</h3><ul>{task?.actionReasons?.length ? task.actionReasons.map((reason) => <li key={reason.code}>{reason.label}{reason.detail ? `：${reason.detail}` : ""}</li>) : <li>{task ? "当前无需要处理原因" : "未知"}</li>}</ul></div>; }
function RoutingDetails({ task }: { task: Task | null }) {
  const route = task?.routing || task?.routingHistory?.at(-1);
  const executionPolicy = task?.executionModelPolicy || {};
  return <div className="detail-content"><h3>调度信息</h3>
    <dl>{[
      ["首选模型", route?.preferredExecutorModel || route?.selectedExecutorModel || "未知"],
      ["实际模型", route?.selectedExecutorModel || "未触发路由"],
      ["推理 effort", route?.reasoningEffort || "未记录"],
      ["调度偏好", route?.preferenceMode || executionPolicy.mode || "auto"],
      ["触发通道", route?.dispatchChannel || "未记录"],
      ["回退原因", route?.fallbackReason || "无"],
      ["额度偏好模式", executionPolicy.mode || "未记录"],
      ["优先模型", executionPolicy.preferred_model || "未记录"],
      ["额度池", executionPolicy.quota_limit_id || route?.quotaLimitId || "未启用配额优先"],
      ["额度耗尽回退", typeof executionPolicy.fallback_on_exhaustion === "boolean" ? (executionPolicy.fallback_on_exhaustion ? "是" : "否") : "未记录"],
      ["快照新鲜度", freshnessText(route?.quotaSnapshotObservedAt)],
      ["额度观测时间", route?.quotaSnapshotObservedAt || "未记录"],
      ["额度重置时间", route?.quotaResetAt || "未记录"],
    ].map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{text(value)}</dd></div>)}</dl>
    <p className="attention">路由策略来源：同源 Control API 控制面，前端仅展示，不复刻规则。</p>
  </div>;
}
function Evidence({ task }: { task: Task | null }) { const rows = [["Revision", task?.revision], ["Subject", task?.currentSubject?.value || task?.currentSubject?.type], ["证据", task?.evidence], ["测试", task?.tests], ["改动文件", task?.changedFiles], ["验证摘要", task?.verificationClaims], ["审查摘要", task?.reviewAttestations]] as const; return <div className="detail-content">{rows.map(([title, values]) => <section key={title}><h3>{title}</h3><ul>{Array.isArray(values) && values.length ? values.map((value, index) => <li key={index}>{typeof value === "string" ? value : JSON.stringify(value)}</li>) : !Array.isArray(values) && values ? <li>{String(values)}</li> : <li>未知</li>}</ul></section>)}</div>; }
function Activity({ events }: { events: Record<string, unknown>[] }) { return <div className="detail-content"><ul>{events.length ? events.map((event, index) => <li key={index}><strong>{text(event.type)}</strong><br />{formatDate(event.occurred_at || event.recorded_at)}</li>) : <li>未知</li>}</ul></div>; }
