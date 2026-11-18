"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { parseTaskWorkspaceSearch, taskActions, taskAxes, taskListRequestKey, executionDisplayStatus, executionStopPresentation, managementCancelConfirmation, managementCancelNotice } from "@/lib/task-workspace.mjs";
import { describeActivityEvent, fetchInFlight, lastSuccessText, reduceDetailFailure, reduceDetailSuccess, reduceEventsFailure, reduceEventsSuccess } from "@/lib/task-detail.mjs";


type Reason = { code: string; label: string; detail?: string };
type TaskTokenUsage = { usage: { input: number; cachedInput: number; output: number; reasoning: number }; totalTokens: number; count: number; attribution: "estimated" | "unattributed" };
type Task = Record<string, unknown> & { id: string; title?: string; status?: string; updatedAt?: string; verificationStatus?: string; reviewStatus?: string; acceptanceStatus?: string; currentStep?: string; nextAction?: string; blocker?: string; goal?: string; workspace?: string; workspaceBranch?: string; executionEnvironment?: string; evidence?: string[]; changedFiles?: string[]; tests?: string[]; revision?: string; currentSubject?: { type?: string; value?: string }; project?: { id: string; label: string }; actionReasons?: Reason[]; tokenUsage?: TaskTokenUsage | null; runs?: Array<{ ended_at?: string; ended_reason?: string; session_id?: string }>; sessionDetachedAt?: string };
type State = ReturnType<typeof parseTaskWorkspaceSearch>;
type TaskAction = "start" | "cancel" | "archive" | "unarchive";
type TaskRowAction = { action: TaskAction; label: string };
const labels: Record<string, string> = { planned: "计划中", in_progress: "执行中", blocked: "已阻塞", done_claimed: "已声明完成", verified: "已验证", cancelled: "管理已取消", stop_unknown: "停止状态未知", stop_requested: "已请求停止，待确认", execution_stopped: "已确认停止", passed: "通过", pending: "待处理", failed: "失败", stale: "已过期", changes_requested: "需修改", ready: "就绪", accepted: "已验收", rejected: "已拒绝", not_required: "不要求", unknown: "未知", execution_unconfirmed: "执行待确认" };
const text = (value: unknown) => typeof value === "string" && value.trim() ? value : "未知";
// 执行终态与完成判定解耦：任务仍在账本但运行已收口且会话脱离时，展示“执行待确认”而非“执行中”。
const displayStatus = (task: Task) => executionDisplayStatus(task);
const formatDate = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "未知";
const tokenFormatter = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 });
const formatTokens = (value: number) => tokenFormatter.format(Math.max(0, Number(value || 0)));
const emptyTasks: Task[] = [];
type DetailFetch = { taskId: string; tick: number; error: string; lastSuccessAt: number; value: Task | null };
const initialDetailFetch: DetailFetch = { taskId: "", tick: -1, error: "", lastSuccessAt: 0, value: null };
type EventsFetch = { taskId: string; tick: number; error: string; lastSuccessAt: number; values: Record<string, unknown>[] };
const initialEventsFetch: EventsFetch = { taskId: "", tick: -1, error: "", lastSuccessAt: 0, values: [] };

function subscribeLocation(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}
const locationSearch = () => window.location.search;
const serverSearch = () => "";

export function TaskWorkspace() {
  const state = parseTaskWorkspaceSearch(useSyncExternalStore(subscribeLocation, locationSearch, serverSearch));
  const [payload, setPayload] = useState<{ tasks?: Task[]; total?: number; totalPages?: number; actionCounts?: Record<string, number>; projects?: Array<{ id: string; label: string }> }>({});
  const [loadedListKey, setLoadedListKey] = useState("");
  const [pollTick, setPollTick] = useState(0);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const actionInFlight = useRef(false);
  const [actingTaskId, setActingTaskId] = useState("");
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; resolve: (v: boolean) => void } | null>(null);
  const askConfirm = (message: string) => new Promise<boolean>((resolve) => setConfirmDialog({ message, resolve }));
  const closeConfirm = (v: boolean) => setConfirmDialog((cur) => { if (cur) cur.resolve(v); return null; });
  const [detailFetch, setDetailFetch] = useState<DetailFetch>(initialDetailFetch);
  const [eventsFetch, setEventsFetch] = useState<EventsFetch>(initialEventsFetch);
  const listInFlight = useRef(false);
  const listKey = taskListRequestKey(state);

  const update = useCallback((patch: Partial<State>) => {
    const next = { ...state, ...patch };
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(next)) if (value && !(key === "project" && value === "all") && !(key === "bucket" && value === "all") && !(key === "page" && value === 1) && !(key === "tab" && value === "overview")) params.set(key, String(value));
    window.history.pushState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [state]);

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
      .finally(() => { listInFlight.current = false; if (!controller.signal.aborted) { setLoadedListKey(listKey); setRefreshing(false); } });
    return () => controller.abort();
  }, [listKey, pollTick, state.bucket, state.page, state.project, state.query]);

  useEffect(() => {
    if (!state.task) return;
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted;
    const requestedTaskId = state.task;
    const requestTick = pollTick;
    const taskParam = encodeURIComponent(requestedTaskId);
    fetch(`/api/control/tasks/${taskParam}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error((body && typeof body.error === "string" && body.error) || "任务详情加载失败");
        if (body === null) throw new Error("任务详情响应不是有效 JSON");
        return body;
      })
      .then((body) => { if (isCurrent()) setDetailFetch((previous) => reduceDetailSuccess(previous, body, requestedTaskId, requestTick, Date.now())); })
      .catch((cause) => {
        if (!isCurrent() || cause?.name === "AbortError") return;
        setDetailFetch((previous) => reduceDetailFailure(previous, cause?.message || "任务详情加载失败", requestedTaskId, requestTick));
      });
    fetch(`/api/control/tasks/${taskParam}/events?limit=50`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error((body && typeof body.error === "string" && body.error) || "活动加载失败");
        if (body === null) throw new Error("活动响应不是有效 JSON");
        return body;
      })
      .then((body) => { if (isCurrent()) setEventsFetch((previous) => reduceEventsSuccess(previous, body, requestedTaskId, requestTick, Date.now())); })
      .catch((cause) => {
        if (!isCurrent() || cause?.name === "AbortError") return;
        setEventsFetch((previous) => reduceEventsFailure(previous, cause?.message || "活动加载失败", requestedTaskId, requestTick));
      });
    return () => controller.abort();
  }, [state.task, pollTick]);

  const detail = detailFetch.taskId === state.task ? detailFetch : null;
  const events = eventsFetch.taskId === state.task ? eventsFetch : null;
  const detailLoading = fetchInFlight(detailFetch, state.task, pollTick);
  const eventsLoading = fetchInFlight(eventsFetch, state.task, pollTick);

  const tasks = payload.tasks ?? emptyTasks;
  const loading = loadedListKey !== listKey;
  const projects = payload.projects || [];
  const counts = payload.actionCounts || {};

  const act = async (task: Task, action: TaskAction) => {
    if (actionInFlight.current) return;
    if (action === "start" && !(await askConfirm(`将任务“${text(task.title)}”设为执行中？这里只更新任务状态，不会自动启动或唤醒 Agent；请在关联会话继续处理。`))) return;
    if (action === "cancel" && !(await askConfirm(managementCancelConfirmation(text(task.title))))) return;
    if (action === "archive" && !(await askConfirm(`确认归档任务“${text(task.title)}”？任务将从列表隐藏，历史会保留；请保存详情链接以便取消归档。`))) return;
    actionInFlight.current = true;
    setActingTaskId(task.id);
    setNotice("");
    setActionError("");
    try {
      const response = await fetch(`/api/control/tasks/${encodeURIComponent(task.id)}/actions`, { method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Action": "delegate" }, body: JSON.stringify({ action }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "任务操作失败");
      setNotice(action === "start" ? "任务已设为执行中，请在关联会话继续处理。" : action === "cancel" ? managementCancelNotice : action === "archive" ? "任务已归档，当前详情中可取消归档。" : "已取消归档，任务重新显示在列表中。");
      if (action === "archive") update({ task: task.id, tab: "overview" });
      setPollTick((current) => current + 1);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "任务操作失败");
    } finally {
      actionInFlight.current = false;
      setActingTaskId("");
    }
  };

  return <>
    {confirmDialog && (
      <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={() => closeConfirm(false)}>
        <div style={{background:"#fff",borderRadius:12,padding:"24px 28px",maxWidth:440,boxShadow:"0 10px 40px rgba(0,0,0,0.2)",fontSize:14,lineHeight:1.6}} onClick={e => e.stopPropagation()}>
          <p style={{margin:"0 0 20px",color:"#222"}}>{confirmDialog.message}</p>
          <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
            <button onClick={() => closeConfirm(false)} style={{padding:"8px 18px",borderRadius:8,border:"1px solid #ddd",background:"#fff",cursor:"pointer"}}>取消</button>
            <button onClick={() => closeConfirm(true)} style={{padding:"8px 18px",borderRadius:8,border:"none",background:"#1976d2",color:"#fff",cursor:"pointer",fontWeight:500}}>确认</button>
          </div>
        </div>
      </div>
    )}
  <main className={state.task ? "task-workspace with-open-detail" : "task-workspace"}>
    <aside className="task-nav"><a className="task-logo" href="/tasks">TASK<span>CENTER</span></a><nav><a className="active" href="/tasks">任务工作区</a><a href="/ai">AI 行为</a><a href="/improvements">改进建议</a><a href="/settings">设置</a></nav></aside>
    <section className="task-main"><header className="task-header"><div><p>LOCAL CONTROL API</p><h1>任务工作区</h1><small>任务事实、证据与活动均来自本地 Control API。</small></div><button disabled={refreshing || loading} onClick={() => { setRefreshing(true); setPollTick(current => current + 1); }}>{refreshing ? "刷新中…" : "刷新"}</button></header>
      <section className="task-stats" aria-label="任务统计">{([['planned','新建'],['in_progress','执行中'],['execution_unconfirmed','执行待确认'],['completed','管理已收口'],['all','全部']] as const).map(([bucket, label]) => <button className={state.bucket === bucket ? "selected" : ""} key={bucket} onClick={() => update({ bucket, page: 1 })}><strong>{counts[bucket] ?? "未知"}</strong><span>{label}</span></button>)}</section>
      <section className="task-filters"><select value={state.project} onChange={(event) => update({ project: event.target.value, page: 1 })}><option value="all">全部项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.label}</option>)}</select><input value={state.query} onChange={(event) => update({ query: event.target.value, page: 1 })} placeholder="搜索标题、ID 或目标" /><span>共 {payload.total ?? "未知"} 条</span></section>
      {notice && <p role="status">{notice}</p>}{actionError && <p className="task-error" role="alert">{actionError}</p>}{error && <p className="task-error" role="status">{error}</p>}<div className="task-table-wrap"><table className="task-table"><thead><tr><th>状态</th><th>任务名称</th><th>项目</th><th>当前阶段</th><th>Token</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{loading && !tasks.length ? <tr><td colSpan={7}>正在加载真实任务摘要…</td></tr> : tasks.length ? tasks.map((task) => {
        const actions = taskActions(task) as TaskRowAction[];
        return <tr key={task.id} className={state.task === task.id ? "selected" : ""} onClick={() => update({ task: task.id, tab: "overview" })}>
          <td><span className={`status-chip status-${text(task.status)}`}>{task.status === "cancelled" ? labels.cancelled : labels[displayStatus(task)] || text(task.status)}</span>{executionStopPresentation(task) && <small>{executionStopPresentation(task)!.requestLabel} · {executionStopPresentation(task)!.executionLabel}</small>}{(task.actionReasons || []).length > 0 && <small className="attention">{task.actionReasons!.map(reason => reason.label).join("；")}</small>}</td>
          <td><button onClick={() => update({ task: task.id, tab: "overview" })}>{text(task.title)}</button><small>{task.id}</small></td><td>{text(task.project?.label)}{task.executionEnvironment === "worktree" && <small>{text(task.workspaceBranch)}</small>}</td><td>{text(task.currentStep)}</td>
          <td title={task.tokenUsage ? `精确值：${task.tokenUsage.totalTokens.toLocaleString("zh-CN")} Token` : undefined}>{task.tokenUsage ? <><strong>总计 {formatTokens(task.tokenUsage.totalTokens)}</strong><small>输入 {formatTokens(task.tokenUsage.usage.input)}（缓存 {formatTokens(task.tokenUsage.usage.cachedInput)}）</small><small>输出 {formatTokens(task.tokenUsage.usage.output)}（推理 {formatTokens(task.tokenUsage.usage.reasoning)}）</small></> : "暂无归属"}</td>
          <td>{formatDate(task.updatedAt)}</td>
          <td className="task-actions" onClick={(event) => event.stopPropagation()}>{actions.length ? actions.map((item) => <button className={`task-action ${["cancel", "archive"].includes(item.action) ? "task-action-danger" : ""}`} disabled={Boolean(actingTaskId)} key={item.action} onClick={() => void act(task, item.action)}>{actingTaskId === task.id ? "处理中…" : item.label}</button>) : "—"}</td>
        </tr>;
      }) : <tr><td colSpan={7}>没有匹配的真实任务。</td></tr>}</tbody></table></div>
      <footer className="task-pagination"><button disabled={state.page <= 1} onClick={() => update({ page: state.page - 1 })}>上一页</button><span>第 {state.page} / {payload.totalPages ?? "未知"} 页</span><button disabled={refreshing || !payload.totalPages || state.page >= Number(payload.totalPages)} onClick={() => update({ page: state.page + 1 })}>下一页</button></footer>
    </section>
    {state.task && <aside className="task-detail" aria-label="任务详情"><button className="detail-close" onClick={() => update({ task: "", tab: "overview" })}>关闭</button><h2>{text(detail?.value?.title || tasks.find((task) => task.id === state.task)?.title)}</h2><small>{state.task}</small>{detail?.value && <section aria-label="任务操作"><p>以下操作只更新任务记录，不会启动或停止 Agent。</p>{(taskActions(detail.value) as TaskRowAction[]).map(item => <button disabled={Boolean(actingTaskId)} key={item.action} onClick={() => void act(detail.value!, item.action)}>{actingTaskId === state.task ? "处理中…" : item.label}</button>)}{typeof detail.value.sessionId === "string" && <p><a href={`/settings?session=${encodeURIComponent(detail.value.sessionId)}#session-settings`}>关联会话与读取设置</a></p>}</section>}<div className="detail-tabs">{([['overview','概览'],['evidence','证据'],['activity','活动']] as const).map(([tab, label]) => <button className={state.tab === tab ? "selected" : ""} key={tab} onClick={() => update({ tab })}>{label}</button>)}</div>{state.tab !== "activity" && <FetchStatus fetch={detail} loading={detailLoading} label="详情" />}{state.tab === "overview" && <DetailOverview fetch={detail} />}{state.tab === "evidence" && <Evidence fetch={detail} />}{state.tab === "activity" && <Activity fetch={events} loading={eventsLoading} />}</aside>}
  </main>
</>;
}

function FetchStatus({ fetch, loading, label }: { fetch: { error: string; lastSuccessAt: number } | null; loading: boolean; label: string }) {
  return <div role="status">{loading && <p>{fetch?.lastSuccessAt ? `正在刷新${label}…` : `正在加载${label}…`}</p>}{fetch?.error && <p className="task-error">读取失败：{fetch.error}</p>}{fetch?.lastSuccessAt ? <small>{label} · {lastSuccessText(fetch.lastSuccessAt)}{fetch.error ? "（保留旧数据）" : ""}</small> : fetch?.error ? <small>尚无成功数据</small> : null}</div>;
}

function DetailOverview({ fetch }: { fetch: DetailFetch | null }) {
  const task = fetch?.value ?? null;
  if (!task) return null;
  const stop = executionStopPresentation(task);
  const tokenTotal = task.tokenUsage ? `${formatTokens(task.tokenUsage.totalTokens)} Token` : "暂无归属";
  const inputTokens = task.tokenUsage ? `${formatTokens(task.tokenUsage.usage.input)}（其中缓存 ${formatTokens(task.tokenUsage.usage.cachedInput)}）` : "暂无归属";
  const outputTokens = task.tokenUsage ? `${formatTokens(task.tokenUsage.usage.output)}（其中推理 ${formatTokens(task.tokenUsage.usage.reasoning)}）` : "暂无归属";
  return <div className="detail-content">{stop && <section aria-label="执行停止状态"><h3>执行停止状态</h3><p>{stop.requestLabel} · {stop.executionLabel}</p><p>{stop.detail}</p></section>}<h3>目标</h3><p>{text(task.goal)}</p><dl>{[["关联会话", text(task.sessionId)], ["客户端", text(task.agent)], ["当前步骤", task.currentStep], ["下一步", task.nextAction], ["阻塞", task.blocker], ["执行环境", task.executionEnvironment], ["Git 分支", task.workspaceBranch], ["Workspace", task.workspace], ["Token 总计", tokenTotal], ["输入 Token", inputTokens], ["输出 Token", outputTokens]].map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{text(value)}</dd></div>)}{taskAxes(task).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{labels[text(value)] || text(value)}</dd></div>)}</dl><h3>需处理原因</h3><ul>{task.actionReasons?.length ? task.actionReasons.map((reason) => <li key={reason.code}>{reason.label}{reason.detail ? `：${reason.detail}` : ""}</li>) : <li>当前无需要处理原因</li>}</ul></div>;
}
function Evidence({ fetch }: { fetch: DetailFetch | null }) {
  const task = fetch?.value ?? null;
  if (!task) return null;
  const evidenceLabels: Record<string, string> = { 证据: "尚未提交证据", 测试: "尚未提交测试", 改动文件: "未记录", 验证摘要: "暂无记录", 审查摘要: "暂无记录" };
  const rows: Array<[string, unknown]> = [["Revision", task.revision], ["Subject", task.currentSubject?.value || task.currentSubject?.type], ["证据", task.evidence], ["测试", task.tests], ["改动文件", task.changedFiles], ["验证摘要", (task as Record<string, unknown>).verificationClaims], ["审查摘要", (task as Record<string, unknown>).reviewAttestations]];
  return <div className="detail-content">{rows.map(([title, values]) => {
    const emptyLabel = evidenceLabels[title] || "未记录";
    return <section key={title}><h3>{title}</h3><ul>{Array.isArray(values) && values.length ? values.map((value, index) => <li key={index}>{typeof value === "string" ? value : JSON.stringify(value)}</li>) : !Array.isArray(values) && values ? <li>{String(values)}</li> : <li>{values === undefined || values === null ? "未记录" : emptyLabel}</li>}</ul></section>;
  })}</div>;
}
function Activity({ fetch, loading }: { fetch: EventsFetch | null; loading: boolean }) {
  const items = (fetch?.values || []).map(describeActivityEvent).filter((item): item is NonNullable<typeof item> => Boolean(item));
  return <div className="detail-content"><FetchStatus fetch={fetch} loading={loading} label="活动" />{items.length ? <ul>{items.map((item, index) => <li key={index}><strong>{labels[item.type] || item.type}</strong><br />{item.time ? formatDate(item.time) : "未知时间"}{item.lines.map((line) => <span key={line}><br />{line}</span>)}{item.note && <small><br />{item.note}</small>}</li>)}</ul> : fetch?.lastSuccessAt ? <p>暂无活动</p> : null}</div>;
}
