"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cliRunStatusLabel } from "@/lib/task-detail.mjs";
import { isExpiredRateWindow, rateLimitPools, recentRoutingRows, usageToday } from "@/lib/routing-console.mjs";

type Section = "sessions" | "routing" | "improvements" | "settings";
type Thread = { id: string; title?: string };
type TokenUsage = { usage: { input: number; cachedInput: number; output: number; reasoning: number }; totalTokens: number; count: number };
type Session = { agent?: string; harness?: { label?: string; usage_scope?: string; operations?: Record<string, { supported: boolean; availability: string; reason: string }> }; sessionId: string; title?: string; status?: string; taskCount?: number; tokenUsage?: TokenUsage | null };
type SessionData = { status: { sessions?: Session[] }; read: { selection?: { threadIds?: string[] }; availableThreads?: Thread[] }; gate: { selection?: { threadIds?: string[] } } };
type ModelHealth = { model: string; state?: string; active_executors?: number; concurrency_limit?: number; consecutive_failures?: number; quota_limit_id?: string; quota_retry_after_at?: string | null; retry_after_at?: string | null; last_error_code?: string | null; last_success_at?: string | null; opened_at?: string | null };
type ModelRole = { model: string; reasoning_effort?: string; fallback_models?: string[]; task_class_reasoning_efforts?: Record<string, string> };
type QuotaPool = { id?: string; provider?: string; source?: string; models?: string[]; notes?: string };
type RoutingData = { models?: ModelHealth[]; roles?: { executor?: ModelRole; reviewer?: ModelRole; manual_only_models?: string[]; model_catalog?: Record<string, { description?: string; automatic_until?: string }>; quota_pools?: QuotaPool[] } };
type RateWindow = { used_percent?: number | null; window_minutes?: number | null; resets_at?: number | null };
type RatePool = { limit_id?: string; limit_name?: string | null; primary?: RateWindow | null; secondary?: RateWindow | null; observed_at?: string | null; provider?: string | null; source?: string; models?: string[]; notes?: string };
type UsageData = { generatedAt?: string; rate_limits?: { primary?: RateWindow; by_limit_id?: Record<string, RatePool> }; windows?: { "24h"?: { totals?: unknown; byModel?: unknown; modelContinuations?: number } }; snapshotStatus?: { stale?: boolean; lastSuccessAt?: string; lastRefreshError?: string } };
type CliObservation = { id: string; taskId: string; workspace: string; executorModel: string; status: string; runStatus?: string; createdAt?: string; claimedAt?: string; lastObservedAt?: string; completedAt?: string; expiresAt?: string };
type CliRunMetrics = { claimed?: number; excluded?: number; statusCounts?: Record<string, number>; recentRuns?: CliObservation[]; runs: number; active: number; succeeded: number; failed: number; cancelled: number; byModel: Record<string, { runs: number; active?: number; succeeded: number; failed: number; cancelled: number; durationSum?: number; durationCount?: number; durationMax?: number; lastFinishedAt?: number }>; tokens: { input: number; output: number; total: number; reported: number }; lastFinishedAt?: number | null; activeRuns?: Array<{ model: string; startedAt: number | null; taskId: string }>; duration?: { count: number; avgMs: number | null; maxMs: number | null; totalMs: number | null } };
type GovernanceData = { cliRuns?: CliRunMetrics; completedTasks?: number; reworkRate?: number | null; snapshotStatus?: { stale?: boolean } };
type RoutingTask = { id: string; title?: string; updatedAt?: string; routingHistory?: Array<{ routeId?: string; selectedExecutorModel?: string; reason?: string; outcome?: string; recordedAt?: string }>; routingResult?: { routeId?: string; outcome?: string }; routingResultHistory?: Array<{ routeId?: string; outcome?: string }> };
type RoutingRow = { taskId: string; taskTitle: string; routeId: string; model: string; reason: string; outcome: string; recordedAt: string };
type Proposal = { id: string; title?: string; summary?: string; reason?: string; status?: string; executionPolicy?: string };
type ReflectionData = { proposals?: Proposal[] };
type HealthData = { ok?: boolean; control?: { uptimeSeconds?: number }; dashboard?: { readable?: boolean }; ledger?: { readable?: boolean }; watcher?: { healthy?: boolean } };
type PilotTask = { task_id: string; reported: boolean; qualification_evidence: string[]; prepare_turn: string; repeated_reads: number | "unknown"; recovery_cost_tokens: number | "unknown"; input_tokens: number | "unknown"; cached_input_tokens: number | "unknown"; rework_count: number | "unknown"; verification: string; review: string; authority_violations: number | "unknown" };
type PilotProject = { project_id: string; workspace: string; sessions: Array<{ session_id: string; title?: string }>; context_management: { state: string; experimental_mode: boolean | "unknown"; observed_at: string; applies_to: string }; latest_intent?: { action: string; status: string; message?: string } | null; trial: { completed: number; target: number; tasks: PilotTask[] } };
type PilotData = { generated_at?: string; projects?: PilotProject[] };
const operationLabels: Record<string, string> = { createSession: "新建会话", resumeSession: "恢复会话", inspectSession: "检查会话" };
const actionHeaders = { "content-type": "application/json", "x-taskcenter-action": "delegate" };
const entries: Array<[Section, string, string]> = [["sessions", "/sessions", "会话"], ["routing", "/routing", "模型调度"], ["improvements", "/improvements", "改进建议"], ["settings", "/settings", "设置"]];
const tokenFormatter = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 });
const formatTokens = (value: number) => tokenFormatter.format(Math.max(0, Number(value || 0)));

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/control${path}`, { cache: "no-store", ...init });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data as T;
}


function usePending() {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const run = useCallback(async (operation: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try { await operation(); }
    finally { inFlight.current = false; setPending(false); }
  }, []);
  return [pending, run] as const;
}

function useUrlState(name: string, fallback: string) {
  const [value, setValue] = useState(() => typeof window === "undefined" ? fallback : new URLSearchParams(window.location.search).get(name) || fallback);
  const update = (next: string) => { const params = new URLSearchParams(window.location.search); if (next === fallback) params.delete(name); else params.set(name, next); window.history.pushState({}, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`); setValue(next); };
  return [value, update] as const;
}

function Layout({ section, children }: { section: Section; children: ReactNode }) {
  return <main className="task-workspace"><aside className="task-nav"><a className="task-logo" href="/tasks">TASK<span>CENTER</span></a><nav><a href="/tasks">任务工作区</a>{entries.map(([key, href, label]) => <a key={key} className={key === section ? "active" : ""} href={href}>{label}</a>)}</nav></aside><section className="task-main">{children}</section></main>;
}

function Header({ code, title, description, refresh, refreshing = false }: { code: string; title: string; description: string; refresh: () => void; refreshing?: boolean }) {
  return <header className="task-header"><div><p>{code}</p><h1>{title}</h1><small>{description}</small></div><button disabled={refreshing} onClick={refresh}>{refreshing ? "刷新中…" : "刷新"}</button></header>;
}

export function ConsolePage({ section }: { section: Section }) {
  return <Layout section={section}>{section === "sessions" ? <Sessions /> : section === "routing" ? <Routing /> : section === "improvements" ? <Improvements /> : <Settings />}</Layout>;
}

function Sessions() {
  const [busy, run] = usePending();
  const [refreshing, refresh] = usePending();
  const [selectedSession] = useUrlState("session", "");
  const [filter, setFilter] = useUrlState("filter", "registered"); const [state, setState] = useState<SessionData>(); const [ids, setIds] = useState<string[]>([]); const [notice, setNotice] = useState("");
  const load = useCallback(() => refresh(async () => { try { const [status, read, gate] = await Promise.all([api<SessionData["status"]>("/session-status"), api<SessionData["read"]>("/session-selection"), api<SessionData["gate"]>("/gate-session-allowlist")]); setState({ status, read, gate }); setIds(read.selection?.threadIds || []); } catch (error) { setNotice(error instanceof Error ? error.message : "读取失败"); } }), [refresh]);
  const refreshStatus = useCallback(async () => { try { const status = await api<SessionData["status"]>("/session-status"); setState(current => current ? { ...current, status } : current); } catch (error) { setNotice(error instanceof Error ? error.message : "读取失败"); } }, []);
  useEffect(() => { const timer = window.setTimeout(load, 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => { const timer = window.setInterval(refreshStatus, 5000); return () => window.clearInterval(timer); }, [refreshStatus]);
  const save = () => run(async () => { try { await api("/session-selection", { method: "POST", headers: actionHeaders, body: JSON.stringify({ mode: "allowlist", threadIds: ids }) }); setNotice("读取白名单已保存"); await load(); } catch (error) { setNotice(error instanceof Error ? error.message : "保存失败"); } });
  const toggleGate = (session_id: string, enabled: boolean) => run(async () => { try { if (enabled && !window.confirm("加入门禁豁免后，该会话可在没有活跃任务的情况下工作。确认加入？")) return; await api("/gate-session-allowlist/session", { method: "POST", headers: actionHeaders, body: JSON.stringify({ session_id, enabled }) }); const gate = await api<SessionData["gate"]>("/gate-session-allowlist"); setState(current => current ? { ...current, gate } : current); setNotice(enabled ? "已加入门禁豁免" : "已退出门禁豁免"); } catch (error) { setNotice(error instanceof Error ? error.message : "更新失败"); } });
  const gateIds = state?.gate?.selection?.threadIds || []; const sessions = (state?.status?.sessions || []).filter((item) => selectedSession ? item.sessionId === selectedSession : filter === "all" || item.status === "registered");
  return <><Header code="SESSION CONTROL" title="会话与读取边界" description="只展示真实登记状态；读取和门禁白名单均由现有 Control API 保存。" refresh={() => { if (JSON.stringify(ids) === JSON.stringify(state?.read.selection?.threadIds || []) || window.confirm("刷新会丢弃未保存的读取白名单更改，是否继续？")) void load(); }} refreshing={refreshing || busy} /><p className="console-toolbar"><label>范围 <select value={filter} onChange={event => setFilter(event.target.value)}><option value="registered">已登记</option><option value="all">全部可见</option></select></label><span role="status">{busy ? "正在提交…" : notice}</span></p><div className="console-list">{sessions.map((item) => <article className="console-card" key={item.sessionId}><h2>{item.title || "未命名会话"}</h2><p className="console-path">{item.sessionId}</p><p>客户端：{item.harness?.label || item.agent || "未知"} · 用量口径：{item.harness?.usage_scope === "context_snapshot" ? "上下文快照（不可累计）" : item.harness?.usage_scope === "token_usage" ? "Token 用量" : "未适配"}</p><p>适配操作：{Object.entries(item.harness?.operations || {}).filter(([, capability]) => capability.supported).map(([name]) => (operationLabels[name] || name)).join("、") || "暂无主动控制能力"}；运行环境与权限以实际调用为准。</p><p>关联任务：{item.taskCount ?? 0} · 状态：{item.status || "unknown"} · 门禁豁免：{gateIds.includes(item.sessionId) ? "已启用" : "未启用"}</p><p title={item.tokenUsage ? `精确值：${item.tokenUsage.totalTokens.toLocaleString("zh-CN")} Token` : undefined}>Token 总计：{item.tokenUsage ? formatTokens(item.tokenUsage.totalTokens) : "暂无统计"}</p>{item.tokenUsage && <><p>输入：{formatTokens(item.tokenUsage.usage.input)} · 其中缓存 {formatTokens(item.tokenUsage.usage.cachedInput)}</p><p>输出：{formatTokens(item.tokenUsage.usage.output)} · 其中推理 {formatTokens(item.tokenUsage.usage.reasoning)}</p></>}<button disabled={busy || refreshing} onClick={() => toggleGate(item.sessionId, !gateIds.includes(item.sessionId))}>{gateIds.includes(item.sessionId) ? "退出门禁豁免" : "加入门禁豁免"}</button></article>)}</div><section className="console-card"><h2>允许读取的 Codex 会话</h2>{(state?.read?.availableThreads || []).map((thread) => <label className="console-check" key={thread.id}><input type="checkbox" disabled={busy || refreshing} checked={ids.includes(thread.id)} onChange={() => setIds(current => current.includes(thread.id) ? current.filter(id => id !== thread.id) : [...current, thread.id])} />{thread.title || thread.id}</label>)}<button disabled={busy || refreshing || !state || JSON.stringify(ids) === JSON.stringify(state.read.selection?.threadIds || [])} onClick={save}>保存读取白名单</button></section></>;
}

function Routing() {
  const [busy, run] = usePending();
  const [savedPolicy, setSavedPolicy] = useState({ preset: "saving", threshold: 0 });
  const [state, setState] = useState<RoutingData>(); const [usage, setUsage] = useState<UsageData>(); const [governance, setGovernance] = useState<GovernanceData>(); const [tasks, setTasks] = useState<RoutingTask[]>([]); const [preset, setPreset] = useState("saving"); const [threshold, setThreshold] = useState(0); const [notice, setNotice] = useState(""); const [refreshing, setRefreshing] = useState(false); const [loaded, setLoaded] = useState(false); const [now, setNow] = useState(() => Date.now());
  const load = useCallback(async () => { setRefreshing(true); setNotice(""); try { const [health, policy, nextUsage, taskData, governanceData] = await Promise.all([api<RoutingData>("/routing/health"), api<{ policy?: { preset?: string; threshold_percent?: number } }>("/routing/optional-astra-policy"), api<UsageData>("/usage-report"), api<{ tasks?: RoutingTask[] }>("/tasks?view=summary&page_size=100"), api<GovernanceData>("/governance-metrics")]); setState(health); setUsage(nextUsage); setTasks(taskData.tasks || []); setGovernance(governanceData); setPreset(policy.policy?.preset || "saving"); setThreshold(policy.policy?.threshold_percent || 0); setSavedPolicy({ preset: policy.policy?.preset || "saving", threshold: policy.policy?.threshold_percent || 0 }); setLoaded(true); setNow(Date.now()); const at = new Date().toLocaleTimeString("zh-CN", { hour12: false }); setNotice(nextUsage.snapshotStatus?.lastRefreshError ? `读取成功，但指标刷新异常：${nextUsage.snapshotStatus.lastRefreshError} · ${at}` : `刷新成功：${at}`); } catch (error) { setNotice(`刷新失败：${error instanceof Error ? error.message : "读取失败"}`); } finally { setRefreshing(false); } }, []);
  useEffect(() => { const timer = window.setTimeout(load, 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refreshRuns = async () => {
      try {
        const next = await api<GovernanceData>("/governance-metrics");
        if (!stopped) { setGovernance(next); setNow(Date.now()); }
      } catch {
        if (!stopped) { setGovernance(current => current ? { ...current, snapshotStatus: { ...current.snapshotStatus, stale: true } } : current); setNow(Date.now()); }
      } finally { if (!stopped) timer = setTimeout(refreshRuns, 5000); }
    };
    timer = setTimeout(refreshRuns, 5000);
    return () => { stopped = true; clearTimeout(timer); };
  }, []);
  const save = () => run(async () => { try { await api("/routing/optional-astra-policy", { method: "POST", headers: actionHeaders, body: JSON.stringify({ preset, threshold_percent: Number(threshold) }) }); setNotice("策略已更新"); await load(); } catch (error) { setNotice(error instanceof Error ? error.message : "更新失败"); } });
  const roles = state?.roles || {};
  const pools = rateLimitPools(usage, (state?.roles as { quota_pools?: QuotaPool[] })?.quota_pools || []) as RatePool[]; const routes = recentRoutingRows(tasks) as RoutingRow[]; const today = usageToday(usage);
  const time = (value?: string | number | null) => value ? new Date(typeof value === "number" ? value * 1000 : value).toLocaleString("zh-CN", { hour12: false }) : "未知";
  const windowLabel = (minutes?: number | null) => minutes === 300 ? "5 小时" : minutes === 10080 ? "7 天" : minutes ? `${minutes} 分钟` : "未知窗口";
  const circuitLabel = (state?: string) => state === "closed" ? "正常" : state === "open" ? "熔断中" : state === "half_open" ? "探测中" : (state || "未知");
  const modelPoolMap = (() => { const map: Record<string, string[]> = {}; for (const pool of (roles.quota_pools || [])) { for (const m of pool.models || []) { (map[m] ||= []).push(pool.id || "未命名池"); } } return map; })();
  const quota = (item: RateWindow | null | undefined) => item ? isExpiredRateWindow(item) ? `${windowLabel(item.window_minutes)}：历史快照（重置时间已过，当前额度未知） · 当时已用 ${item.used_percent ?? "未知"}% · 原重置 ${time(item.resets_at)}` : `${windowLabel(item.window_minutes)}：已用 ${item.used_percent !== null && item.used_percent !== undefined && Number.isFinite(Number(item.used_percent)) ? `${item.used_percent}%` : "未知"} · 重置 ${time(item.resets_at)}` : "未知";
  return <><Header code="ROUTING POLICY" title="模型调度" description="角色策略、瞬时租约、真实额度窗口和最近调度均来自本机控制面。" refresh={() => { if ((preset === savedPolicy.preset && threshold === savedPolicy.threshold) || window.confirm("刷新会丢弃未保存的策略更改，是否继续？")) void load(); }} refreshing={refreshing || busy} /><p role="status">{busy ? "正在保存策略…" : notice || (!loaded && refreshing ? "正在读取模型调度数据…" : "尚未刷新")}</p><section><h2>可选执行器目录</h2><p><small>Jev 按阶段选择具体型号；目录不代表已运行或账户额度可用。独立任务可并发，名额受共享额度池约束。</small></p><div className="console-list">{Object.entries(roles.model_catalog || {}).map(([model, entry]) => <article className="console-card" key={model}><strong>{model}</strong><p>{entry.description || "暂无能力说明"}</p><p>{[roles.executor?.model, ...(roles.executor?.fallback_models || [])].includes(model) && (!entry.automatic_until || Date.parse(entry.automatic_until) > now) ? "自动选型候选" : "不参与自动选型"}{entry.automatic_until ? " · 自动选型截止 " + time(entry.automatic_until) : ""}</p></article>)}</div></section><section><h2>CLI 执行器消耗</h2><p><small>来自 delegation 回执证据中的 usage；无回执用量的运行不计入 Token，标注报告比例。</small></p>{governance?.cliRuns ? (() => {
  const cr = governance.cliRuns;
  const pct = (n: number, d: number) => d > 0 ? (n / d) : 0;
  const pctText = (n: number, d: number) => d > 0 ? `${(n / d * 100).toFixed(0)}%` : "—";
  const reportRatio = cr.runs > 0 ? (cr.tokens.reported / cr.runs * 100).toFixed(1) : "0";
  const fmtDur = (ms: number | null | undefined) => { if (!ms || !Number.isFinite(ms)) return "—"; const m = Math.round(ms / 60000); if (m < 60) return `${m}m`; const h = Math.floor(m / 60); return `${h}h${m % 60}m`; };
  const fmtShortTs = (ms: number | null | undefined) => { if (!ms) return "—"; const d = new Date(ms); const now = new Date(); const sameYear = d.getFullYear() === now.getFullYear(); const md = `${d.getMonth()+1}/${d.getDate()}`; return sameYear ? md : `${d.getFullYear()}/${md}`; };
  const observations = cr.recentRuns || [];
  const running = observations.filter((run) => run.status === "active");
  const rows = Object.entries(cr.byModel).sort((a, b) => (b[1].lastFinishedAt || 0) - (a[1].lastFinishedAt || 0));
  const maxRuns = rows[0]?.[1].runs || 1;
  const bucket = (p: number) => p >= 0.5 ? "#2e7d32" : p >= 0.3 ? "#f9a825" : "#c62828";
  const activeDot = (last: number | undefined) => {
    if (!last) return "#bdbdbd";
    const ageH = (now - last) / 3600000;
    if (ageH < 24) return "#2e7d32";
    if (ageH < 24 * 7) return "#f9a825";
    return "#bdbdbd";
  };
  const isToday = (last: number | undefined) => { if (!last) return false; return (now - last) < 86400000; };
  const statCard = (big: string, label: string, sub?: string) => (
    <div style={{flex:1,background:"#fafafa",borderRadius:8,padding:"14px 16px",minWidth:0}}>
      <div style={{fontSize:28,fontWeight:700,lineHeight:1.1}}>{big}</div>
      <div style={{fontSize:12,color:"#666",marginTop:4}}>{label}</div>
      {sub && <div style={{fontSize:11,color:"#999",marginTop:2}}>{sub}</div>}
    </div>
  );
  return <div className="console-list"><article className="console-card">
    <p>已领取且未收尾：{running.length} 条。每 5 秒刷新。状态依据执行器回报与心跳；无记录不代表本机没有 CLI 进程。{governance?.snapshotStatus?.stale ? " 数据快照已过期，请刷新。" : ""}</p>
    <p>状态分布：{Object.entries(cr.statusCounts || {}).map(([status, count]) => `${cliRunStatusLabel({ status }, now).label} ${count}`).join(" · ")}</p>
    <table style={{width:"100%",fontSize:13,marginBottom:16}}><caption>最近 CLI 派发（最多 50 条，未收尾优先）</caption><thead><tr><th>模型 / 任务</th><th>回报状态</th><th>最后心跳</th><th>工作区</th></tr></thead><tbody>
      {observations.map((run) => <tr key={run.id}><td>{run.executorModel}<br/><small>{run.taskId}</small></td><td>{cliRunStatusLabel(run, now).label}{run.status === "issued" && run.expiresAt && Date.parse(run.expiresAt) < now ? "（授权已到期）" : ""}</td><td>{run.lastObservedAt ? new Date(run.lastObservedAt).toLocaleString("zh-CN", {hour12:false}) : "无心跳证据"}</td><td style={{overflowWrap:"anywhere"}}>{run.workspace}</td></tr>)}
    </tbody></table>
    <div style={{display:"flex",gap:12,marginBottom:16}}>
      {statCard(String(cr.runs), "CLI 授权记录", `已领取 ${cr.claimed ?? 0} · 排除 native/未知通道 ${cr.excluded ?? 0}`)}
      {statCard(`${reportRatio}%`, "回执上报率", `仅 ${cr.tokens.reported}/${cr.runs} 次有 usage`)}
      {statCard(fmtDur(cr.duration?.totalMs), "领取至结案时长", `平均 ${fmtDur(cr.duration?.avgMs)} · 最长 ${fmtDur(cr.duration?.maxMs)}`)}
    </div>
    <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
      <thead><tr style={{textAlign:"left",color:"#888",borderBottom:"1px solid #eee"}}>
        <th style={{padding:"6px 8px",width:80}}>状态</th>
        <th style={{padding:"6px 8px",width:90}}>活跃度</th>
        <th style={{padding:"6px 8px"}}>模型</th>
        <th style={{padding:"6px 8px",width:"25%"}}>授权占比</th>
        <th style={{padding:"6px 8px",width:50}}>次数</th>
        <th style={{padding:"6px 8px",width:70}}>成功 / 授权</th>
        <th style={{padding:"6px 8px",width:60}}>平均</th>
        <th style={{padding:"6px 8px",width:120}}>最后执行</th>
      </tr></thead>
      <tbody>
        {rows.map(([model, row]) => {
          const r = pct(row.succeeded ?? 0, row.runs);
          const today = isToday(row.lastFinishedAt);
          const activeNow = (row.active ?? 0) > 0;
          const ageH = row.lastFinishedAt ? (now - row.lastFinishedAt) / 3600000 : null;
          const ageLabel = !row.lastFinishedAt ? "从未" : ageH! < 24 ? "24小时内" : ageH! < 48 ? "昨天" : ageH! < 24*7 ? `${Math.floor(ageH!/24)}天前` : ageH! < 24*30 ? `${Math.floor(ageH!/24/7)}周前` : "更久";
          return <tr key={model} style={{borderBottom:"1px solid #f5f5f5",background: activeNow ? "#e8f5e9" : today ? "#f1f8e9" : "transparent"}}>
            <td style={{padding:"8px"}}>{activeNow ? <span style={{color:"#2e7d32",fontWeight:600}}>● 有 active 回报</span> : <span style={{color:"#aaa"}}>无 active 回报</span>}</td>
            <td style={{padding:"8px"}}><span style={{display:"inline-block",width:8,height:8,borderRadius:4,background:activeDot(row.lastFinishedAt),marginRight:6,verticalAlign:"middle"}}/><span style={{color:"#666"}}>{ageLabel}</span></td>
            <td style={{padding:"8px",fontWeight:500}}>{model}</td>
            <td style={{padding:"8px"}}><div style={{height:8,background:"#e0e0e0",borderRadius:4,overflow:"hidden"}}><div style={{height:"100%",width:`${(row.runs / maxRuns * 100).toFixed(0)}%`,background:"#1976d2",borderRadius:4}}/></div></td>
            <td style={{padding:"8px"}}>{row.runs}</td>
            <td style={{padding:"8px"}}><span style={{color: bucket(r),fontWeight:600}}>{pctText(row.succeeded ?? 0, row.runs)}</span></td>
            <td style={{padding:"8px",color:"#666"}}>{fmtDur(row.durationCount ? (row.durationSum || 0) / row.durationCount : null)}</td>
            <td style={{padding:"8px",color: today ? "#333" : "#aaa"}}>{row.lastFinishedAt ? new Date(row.lastFinishedAt).toLocaleString("zh-CN",{hour12:false,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"}) : "—"}</td>
          </tr>;
        })}
      </tbody>
    </table>
  </article></div>;
})() : <p>暂无执行器数据。</p>}</section><section><h2>模型健康与瞬时租约</h2><div className="console-list">{(state?.models || []).map((health) => { const poolsForModel = modelPoolMap[health.model] || []; return <article className="console-card" key={health.model}><strong>{health.model}</strong><p>熔断：{circuitLabel(health.state)} · 当前租约：{health.active_executors ?? "未知"}/{health.concurrency_limit ?? "未知"} · 连续失败：{health.consecutive_failures ?? "未知"}</p><p>额度池：{poolsForModel.length ? poolsForModel.join("、") : "未配置"} · {health.quota_limit_id ? `当前限流绑定 ${health.quota_limit_id}` : "无活跃限流"}</p><p>限流恢复：{time(health.quota_retry_after_at) !== "未知" ? time(health.quota_retry_after_at) : time(health.retry_after_at)} · 最后错误：{health.last_error_code || "无"} · 最后成功：{time(health.last_success_at)}</p></article>; })}</div></section><section><h2>额度窗口</h2><p><small>报告生成：{time(usage?.generatedAt)}{usage?.snapshotStatus?.stale ? " · 报告已过期" : ""}；各额度以卡片内观测时间为准。</small></p><div className="console-list">{pools.map((pool) => <article className="console-card" key={pool.limit_id || "default"}><strong>{pool.limit_name || pool.limit_id || "默认额度池"}</strong><p>来源：{pool.provider ? `${pool.provider} · ${pool.source === "official-api" ? "官方接口" : pool.source === "runtime-signal" ? "运行时限流信号" : pool.source === "unknown" ? "未知" : pool.source}` : "未标注"}{pool.models?.length ? ` · 覆盖 ${pool.models.join("、")}` : ""}</p><p>主窗口 {quota(pool.primary)}</p><p>次窗口 {quota(pool.secondary)}</p><p><small>额度观测：{time(pool.observed_at)}{pool.notes ? ` · ${pool.notes}` : ""}</small></p></article>)}</div>{loaded && !pools.length && <p>暂无额度快照，使用量与重置时间均未知。</p>}</section><section><h2>今日用量（24 小时）</h2><p><small>主代理 Token，来自本机用量索引；成本估算不可得时显示「不可估算」。</small></p>{today ? <div className="console-list"><article className="console-card"><p>Token：输入 {formatTokens(today.input)}（缓存 {formatTokens(today.cachedInput)}） · 输出 {formatTokens(today.output)} · 共 {formatTokens(today.totalTokens)}</p><p>平均 {formatTokens(today.averageTokens ?? 0)} · P50 {formatTokens(today.p50 ?? 0)} · P95 {formatTokens(today.p95 ?? 0)} · 成本估算：{today.costEstimation === "unestimable" ? "不可估算" : today.cost !== null && today.cost !== undefined ? `${today.cost}` : "不可估算"}</p>{today.byModel.length ? today.byModel.map((row) => <p key={row.model}>{row.model}：{formatTokens(row.totalTokens)}</p>) : null}</article></div> : <p>暂无今日用量数据。</p>}</section>

<section><h2>最近真实调度</h2><p><small>按最近更新的 100 个任务聚合，最多展示 20 条。</small></p><div className="console-list">{routes.map((route, index) => <article className="console-card" key={`${route.taskId}:${route.routeId || route.recordedAt}:${index}`}><strong>{route.taskTitle}</strong><p className="console-path">{route.taskId}</p><p>模型：{route.model} · 结果：{route.outcome} · 时间：{time(route.recordedAt)}</p><p>原因：{route.reason}</p></article>)}</div>{loaded && !routes.length && <p>暂无真实调度记录。</p>}</section><section className="console-card"><h2>角色策略</h2>{(["executor", "reviewer"] as const).map(role => { const value = roles[role]; return value ? <p key={role}><strong>{role}</strong>：{value.model} · 默认 {value.reasoning_effort} · 回退 {(value.fallback_models || []).join("、") || "无"} · 任务推理 {Object.entries(value.task_class_reasoning_efforts || {}).map(([key, effort]) => `${key}:${effort}`).join("，") || "沿用默认"}</p> : null; })}<p>仅手动模型：{(roles.manual_only_models || []).join("、") || "无"}</p></section><section className="console-card"><h2>可选 Astra 策略</h2><label>预设 <select disabled={busy || refreshing || !loaded} value={preset} onChange={event => setPreset(event.target.value)}><option value="saving">节省</option><option value="balanced">平衡</option><option value="quality">质量</option><option value="custom">自定义</option></select></label><label> 阈值 <input disabled={busy || refreshing || !loaded || preset !== "custom"} type="number" min="0" max="100" value={threshold} onChange={event => setThreshold(Number(event.target.value))} />%</label><button disabled={busy || refreshing || !loaded || !Number.isFinite(threshold) || threshold < 0 || threshold > 100 || (preset === savedPolicy.preset && threshold === savedPolicy.threshold)} onClick={save}>保存策略</button></section></>;
}

function Improvements() {
  const [busy, run] = usePending();
  const [refreshing, refresh] = usePending();
  const [filter, setFilter] = useUrlState("status", "all"); const [state, setState] = useState<ReflectionData>(); const [notice, setNotice] = useState("");
  const load = useCallback(() => refresh(async () => { try { setState(await api<ReflectionData>("/reflections")); } catch (error) { setNotice(error instanceof Error ? error.message : "读取失败"); } }), [refresh]);
  useEffect(() => { const timer = window.setTimeout(load, 0); return () => window.clearTimeout(timer); }, [load]);
  const post = (path: string, body?: unknown) => run(async () => { try { await api(path, { method: "POST", headers: actionHeaders, body: body ? JSON.stringify(body) : undefined }); setNotice(path.endsWith("/execute") ? "创建请求已提交，请刷新查看实际结果。" : path.endsWith("/run") ? "建议分析已完成。" : "决定已保存。"); await load(); } catch (error) { setNotice(error instanceof Error ? error.message : "操作失败"); } });
  const proposals = (state?.proposals || []).filter((item) => filter === "all" || item.status === filter);
  return <><Header code="REFLECTIONS" title="改进建议" description="筛选、决策、执行和重新验证复用现有反思引擎。" refresh={load} refreshing={refreshing || busy} /><p className="console-toolbar"><button disabled={busy || refreshing} onClick={() => post("/reflections/run")}>重新分析建议</button><label>状态 <select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部</option><option value="proposed">待决策</option><option value="accepted">已接受</option><option value="rejected">已拒绝</option><option value="resolved">已解决</option></select></label><span role="status">{busy ? "正在提交…" : notice}</span></p><div className="console-list">{proposals.map((item) => <article className="console-card" key={item.id}><p>{item.status || "proposed"}</p><h2>{item.title || item.id}</h2><p>{item.summary || item.reason || "无额外说明"}</p>{item.executionPolicy === "agent_task" && item.status === "proposed" && <><button disabled={busy || refreshing} onClick={() => post(`/reflections/${item.id}/actions`, { decision: "accepted" })}>接受</button><button disabled={busy || refreshing} onClick={() => post(`/reflections/${item.id}/actions`, { decision: "rejected" })}>拒绝</button></>}{item.executionPolicy === "agent_task" && ["accepted", "rejected"].includes(item.status || "") && <button disabled={busy || refreshing} onClick={() => post(`/reflections/${item.id}/actions`, { decision: "proposed" })}>撤回决定</button>}{item.executionPolicy === "agent_task" && item.status === "accepted" && <button disabled={busy || refreshing} onClick={() => post(`/reflections/${item.id}/execute`, { requestId: crypto.randomUUID(), mode: "new_session" })}>创建改进任务</button>}</article>)}</div>{!proposals.length && <p>没有符合当前筛选条件的真实建议。</p>}</>;
}

function Settings() {
  const [busy, run] = usePending();
  const [refreshing, refresh] = usePending();
  const [health, setHealth] = useState<HealthData>(); const [pilots, setPilots] = useState<PilotData>(); const [notice, setNotice] = useState("");
  const load = useCallback(() => refresh(async () => { try { const [nextHealth, nextPilots] = await Promise.all([api<HealthData>("/health"), api<PilotData>("/context-management-pilots")]); setHealth(nextHealth); setPilots(nextPilots); } catch (error) { setNotice(error instanceof Error ? error.message : "读取失败"); } }), [refresh]);
  useEffect(() => { const timer = window.setTimeout(load, 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => { const timer = window.setInterval(load, 5000); return () => window.clearInterval(timer); }, [load]);
  const sync = () => run(async () => { try { await api("/sync", { method: "POST", headers: actionHeaders, body: "{}" }); setNotice("同步已触发"); await load(); } catch (error) { setNotice(error instanceof Error ? error.message : "同步失败"); } });
  const act = (project: PilotProject, action: "enable" | "disable" | "refresh") => run(async () => { try { const result = await api<{ intent: PilotProject["latest_intent"] }>("/context-management-pilots/intents", { method: "POST", headers: actionHeaders, body: JSON.stringify({ request_id: crypto.randomUUID(), project_id: project.project_id, workspace: project.workspace, action }) }); setPilots(current => ({ ...current, projects: (current?.projects || []).map(item => item.project_id === project.project_id && item.workspace === project.workspace ? { ...item, latest_intent: result.intent } : item) })); setNotice("试点 intent 已留档，等待主脑处理"); await load(); } catch (error) { setNotice(error instanceof Error ? error.message : "试点操作失败"); } });
  const value = (item: string | number) => item === "unknown" ? "unknown" : item;
  return <><Header code="SERVICE SETTINGS" title="设置与边界" description="本机服务状态、数据来源、隐私边界与现有配置入口。" refresh={load} refreshing={refreshing || busy} /><p role="status">{busy ? "正在提交…" : notice}</p><div className="console-list"><article className="console-card"><h2>本地服务</h2><p>状态：{health?.ok ? "正常" : "未连接"} · 运行时间：{health?.control?.uptimeSeconds ?? "-"} 秒</p><button disabled={busy || refreshing} onClick={sync}>立即同步</button></article><article className="console-card"><h2>数据来源</h2><p>Dashboard：{health?.dashboard?.readable ? "可读" : "不可读"} · Ledger：{health?.ledger?.readable ? "可读" : "不可读"} · Watcher：{health?.watcher?.healthy ? "健康" : "需关注"}</p></article><article className="console-card"><h2>隐私与配置</h2><p>仅使用本机 Codex 会话索引与项目配置，不上传会话内容。</p><a href="/sessions">管理读取白名单</a> · <a href="/routing">调整模型策略</a></article></div><section className="console-pilots"><h2>Astra context_management 项目试点</h2><p>TaskCenter 只保存受审计 intent 并唤醒主脑，不直接修改外部项目或 ~/.codex。配置仅对新建 Astra 任务生效。</p><small>采集时间：{pilots?.generated_at || "unknown"}</small><div className="console-list">{(pilots?.projects || []).map(project => { const pending = ["pending", "processing"].includes(project.latest_intent?.status || ""); const session = project.sessions[0]; return <article className="console-card" key={`${project.project_id}:${project.workspace}`}><h2>{session?.title || "未命名会话"}</h2><p className="console-path">{session?.session_id || "无关联 Session"}</p><p className="console-path">{project.project_id} · {project.workspace}</p><p>experimental_mode：<strong>{project.context_management.state}</strong> · 采集：{project.context_management.observed_at || "unknown"} · 生效范围：仅新任务</p><p>Intent：{project.latest_intent ? `${project.latest_intent.action} / ${project.latest_intent.status}${project.latest_intent.message ? ` · ${project.latest_intent.message}` : ""}` : "unknown"}</p><p>启用后的连续 Astra 任务进度：{project.trial.completed}/{project.trial.target}</p>{project.trial.tasks.length ? project.trial.tasks.map(task => <div className="pilot-task" key={task.task_id}><strong>{task.task_id} · {task.reported ? "已上报" : "待上报"}</strong><p>资格证据 {task.qualification_evidence.join("；") || "unknown"} · prepare_turn {value(task.prepare_turn)} · 重复读取 {value(task.repeated_reads)} · 恢复成本 {value(task.recovery_cost_tokens)} · input/cachedInput {value(task.input_tokens)}/{value(task.cached_input_tokens)} · 返工 {value(task.rework_count)} · 验证 {value(task.verification)} · Review {value(task.review)} · 权威违规 {value(task.authority_violations)}</p></div>) : <p>自然长任务资格、prepare_turn、重复读取/恢复成本、input/cachedInput、返工、验证、Review、权威违规：unknown</p>}<button disabled={busy || refreshing || pending} onClick={() => act(project, "enable")}>请求启用</button><button disabled={busy || refreshing || pending} onClick={() => act(project, "disable")}>请求停用</button><button disabled={busy || refreshing || pending} onClick={() => act(project, "refresh")}>请求重新采集</button><p><small>停用是当前任务的软停止，仍依赖既有历史；硬回退需关闭配置并新建 Astra 任务。</small></p></article>; })}</div>{!pilots?.projects?.length && <p>尚无带 project_id 与 workspace 的已登记项目。</p>}</section></>;
}
