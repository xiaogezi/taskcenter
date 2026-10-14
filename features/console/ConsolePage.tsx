"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AiActivity } from "./AiActivity";

type Section = "sessions" | "improvements" | "settings" | "ai";
type Thread = { id: string; title?: string };
type TokenUsage = { usage: { input: number; cachedInput: number; output: number; reasoning: number }; totalTokens: number; count: number };
type Session = { agent?: string; harness?: { label?: string; usage_scope?: string; operations?: Record<string, { supported: boolean; availability: string; reason: string }> }; sessionId: string; title?: string; status?: string; taskCount?: number; tokenUsage?: TokenUsage | null };
type SessionData = { status: { sessions?: Session[] }; read: { selection?: { threadIds?: string[] }; availableThreads?: Thread[] }; gate: { selection?: { threadIds?: string[] } } };
type Proposal = { id: string; title?: string; summary?: string; reason?: string; status?: string; executionPolicy?: string };
type ReflectionData = { proposals?: Proposal[] };
type HealthData = { ok?: boolean; control?: { uptimeSeconds?: number }; dashboard?: { readable?: boolean }; ledger?: { readable?: boolean }; watcher?: { healthy?: boolean } };
type PilotTask = { task_id: string; reported: boolean; qualification_evidence: string[]; prepare_turn: string; repeated_reads: number | "unknown"; recovery_cost_tokens: number | "unknown"; input_tokens: number | "unknown"; cached_input_tokens: number | "unknown"; rework_count: number | "unknown"; verification: string; review: string; authority_violations: number | "unknown" };
type PilotProject = { project_id: string; workspace: string; sessions: Array<{ session_id: string; title?: string }>; context_management: { state: string; experimental_mode: boolean | "unknown"; observed_at: string; applies_to: string }; latest_intent?: { action: string; status: string; message?: string } | null; trial: { completed: number; target: number; tasks: PilotTask[] } };
type PilotData = { generated_at?: string; projects?: PilotProject[] };
const operationLabels: Record<string, string> = { createSession: "新建会话", resumeSession: "恢复会话", inspectSession: "检查会话" };
const actionHeaders = { "content-type": "application/json", "x-taskcenter-action": "delegate" };
const entries: Array<[Section, string, string]> = [["ai", "/ai", "AI 行为"], ["improvements", "/improvements", "改进建议"], ["settings", "/settings", "设置"]];
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
  return <main className="task-workspace"><aside className="task-nav"><a className="task-logo" href="/tasks">TASK<span>CENTER</span></a><nav><a href="/tasks">任务工作区</a>{entries.map(([key, href, label]) => <a key={key} className={(key === section || (key === "settings" && section === "sessions")) ? "active" : ""} href={href}>{label}</a>)}</nav></aside><section className="task-main">{children}</section></main>;
}

function Header({ code, title, description, refresh, refreshing = false }: { code: string; title: string; description: string; refresh: () => void; refreshing?: boolean }) {
  return <header className="task-header"><div><p>{code}</p><h1>{title}</h1><small>{description}</small></div><button disabled={refreshing} onClick={refresh}>{refreshing ? "刷新中…" : "刷新"}</button></header>;
}

export function ConsolePage({ section }: { section: Section }) {
  return <Layout section={section}>{section === "ai" ? <AiActivity request={api} /> : section === "sessions" ? <Sessions /> : section === "improvements" ? <Improvements /> : <Settings />}</Layout>;
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

function Improvements() {
  const [busy, run] = usePending();
  const [refreshing, refresh] = usePending();
  const [filter, setFilter] = useUrlState("status", "all"); const [state, setState] = useState<ReflectionData>(); const [notice, setNotice] = useState("");
  const load = useCallback(() => refresh(async () => { try { setState(await api<ReflectionData>("/reflections")); } catch (error) { setNotice(error instanceof Error ? error.message : "读取失败"); } }), [refresh]);
  useEffect(() => { const timer = window.setTimeout(load, 0); return () => window.clearTimeout(timer); }, [load]);
  const post = (path: string, body?: unknown) => run(async () => { try { await api(path, { method: "POST", headers: actionHeaders, body: body ? JSON.stringify(body) : undefined }); setNotice(path.endsWith("/run") ? "建议分析已完成。" : "决定已保存。"); await load(); } catch (error) { setNotice(error instanceof Error ? error.message : "操作失败"); } });
  const proposals = (state?.proposals || []).filter((item) => filter === "all" || item.status === filter);
  return <><Header code="REFLECTIONS" title="改进建议" description="分析和记录建议；历史状态仅为最后观察结果，旧投递不会自动继续。" refresh={load} refreshing={refreshing || busy} /><p className="console-toolbar"><button disabled={busy || refreshing} onClick={() => post("/reflections/run")}>重新分析建议</button><label>状态 <select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部</option><option value="proposed">待决策</option><option value="accepted">已接受</option><option value="rejected">已拒绝</option><option value="resolved">已解决</option></select></label><span role="status">{busy ? "正在提交…" : notice}</span></p><div className="console-list">{proposals.map((item) => <article className="console-card" key={item.id}><p>{item.status || "proposed"}</p><h2>{item.title || item.id}</h2><p>{item.summary || item.reason || "无额外说明"}</p>{item.executionPolicy === "agent_task" && item.status === "proposed" && <><button disabled={busy || refreshing} onClick={() => post(`/reflections/${item.id}/actions`, { decision: "accepted" })}>接受</button><button disabled={busy || refreshing} onClick={() => post(`/reflections/${item.id}/actions`, { decision: "rejected" })}>拒绝</button></>}{item.executionPolicy === "agent_task" && ["accepted", "rejected"].includes(item.status || "") && <button disabled={busy || refreshing} onClick={() => post(`/reflections/${item.id}/actions`, { decision: "proposed" })}>撤回决定</button>}</article>)}</div>{!proposals.length && <p>没有符合当前筛选条件的真实建议。</p>}</>;
}

function Settings() {
  const [busy, run] = usePending();
  const [refreshing, refresh] = usePending();
  const [selectedSession] = useUrlState("session", "");
  const [health, setHealth] = useState<HealthData>(); const [pilots, setPilots] = useState<PilotData>(); const [notice, setNotice] = useState("");
  const load = useCallback(() => refresh(async () => { try { const [nextHealth, nextPilots] = await Promise.all([api<HealthData>("/health"), api<PilotData>("/context-management-pilots")]); setHealth(nextHealth); setPilots(nextPilots); } catch (error) { setNotice(error instanceof Error ? error.message : "读取失败"); } }), [refresh]);
  useEffect(() => { const timer = window.setTimeout(load, 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => { const timer = window.setInterval(load, 5000); return () => window.clearInterval(timer); }, [load]);
  const sync = () => run(async () => { try { await api("/sync", { method: "POST", headers: actionHeaders, body: "{}" }); setNotice("同步已触发"); await load(); } catch (error) { setNotice(error instanceof Error ? error.message : "同步失败"); } });
  const value = (item: string | number) => item === "unknown" ? "unknown" : item;
  return <><Header code="SERVICE SETTINGS" title="设置与边界" description="本机服务状态、数据来源、隐私边界与现有配置入口。" refresh={load} refreshing={refreshing || busy} /><p role="status">{busy ? "正在提交…" : notice}</p><div className="console-list"><article className="console-card"><h2>本地服务</h2><p>状态：{health?.ok ? "正常" : "未连接"} · 运行时间：{health?.control?.uptimeSeconds ?? "-"} 秒</p><button disabled={busy || refreshing} onClick={sync}>立即同步</button></article><article className="console-card"><h2>数据来源</h2><p>Dashboard：{health?.dashboard?.readable ? "可读" : "不可读"} · Ledger：{health?.ledger?.readable ? "可读" : "不可读"} · Watcher：{health?.watcher?.healthy ? "健康" : "需关注"}</p></article><article className="console-card"><h2>隐私与配置</h2><p>仅使用本机 Codex 会话索引与项目配置，不上传会话内容。</p><a href="#session-settings">管理会话与读取边界</a></article></div><details id="session-settings" open={Boolean(selectedSession) || undefined}><summary>高级：会话与读取边界</summary><Sessions /></details><section className="console-pilots"><h2>Astra context_management 项目试点</h2><p>只读展示项目试点和历史回执；历史状态不代表仍在执行，旧队列不会自动继续，配置由目标项目维护。</p><small>采集时间：{pilots?.generated_at || "unknown"}</small><div className="console-list">{(pilots?.projects || []).map(project => { const session = project.sessions[0]; return <article className="console-card" key={`${project.project_id}:${project.workspace}`}><h2>{session?.title || "未命名会话"}</h2><p className="console-path">{session?.session_id || "无关联 Session"}</p><p className="console-path">{project.project_id} · {project.workspace}</p><p>experimental_mode：<strong>{project.context_management.state}</strong> · 采集：{project.context_management.observed_at || "unknown"} · 生效范围：仅新任务</p><p>Intent：{project.latest_intent ? `${project.latest_intent.action} / ${project.latest_intent.status}${project.latest_intent.message ? ` · ${project.latest_intent.message}` : ""}` : "unknown"}</p><p>启用后的连续 Astra 任务进度：{project.trial.completed}/{project.trial.target}</p>{project.trial.tasks.length ? project.trial.tasks.map(task => <div className="pilot-task" key={task.task_id}><strong>{task.task_id} · {task.reported ? "已上报" : "待上报"}</strong><p>资格证据 {task.qualification_evidence.join("；") || "unknown"} · prepare_turn {value(task.prepare_turn)} · 重复读取 {value(task.repeated_reads)} · 恢复成本 {value(task.recovery_cost_tokens)} · input/cachedInput {value(task.input_tokens)}/{value(task.cached_input_tokens)} · 返工 {value(task.rework_count)} · 验证 {value(task.verification)} · Review {value(task.review)} · 权威违规 {value(task.authority_violations)}</p></div>) : <p>自然长任务资格、prepare_turn、重复读取/恢复成本、input/cachedInput、返工、验证、Review、权威违规：unknown</p>}<p><small>停用是当前任务的软停止，仍依赖既有历史；硬回退需关闭配置并新建 Astra 任务。</small></p></article>; })}</div>{!pilots?.projects?.length && <p>尚无带 project_id 与 workspace 的已登记项目。</p>}</section></>;
}
