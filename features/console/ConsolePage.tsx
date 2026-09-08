"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

type Section = "sessions" | "routing" | "improvements" | "settings";
type Thread = { id: string; title?: string };
type Session = { sessionId: string; status?: string; taskCount?: number };
type SessionData = { status: { sessions?: Session[] }; read: { selection?: { threadIds?: string[] }; availableThreads?: Thread[] }; gate: { selection?: { threadIds?: string[] } } };
type ModelHealth = { model: string; state?: string; active_executors?: number; concurrency_limit?: number; consecutive_failures?: number; quota_limit_id?: string };
type ModelRole = { model: string; reasoning_effort?: string; fallback_models?: string[]; task_class_reasoning_efforts?: Record<string, string> };
type RoutingData = { models?: ModelHealth[]; roles?: { executor?: ModelRole; reviewer?: ModelRole; manual_only_models?: string[] } };
type Proposal = { id: string; title?: string; summary?: string; reason?: string; status?: string; executionPolicy?: string };
type ReflectionData = { proposals?: Proposal[] };
type HealthData = { ok?: boolean; control?: { uptimeSeconds?: number }; dashboard?: { readable?: boolean }; ledger?: { readable?: boolean }; watcher?: { healthy?: boolean } };
type PilotMetric = number | "unknown";
type PilotTrial = { task_id: string; prepare_turn: string; repeated_reads: PilotMetric; recovery_cost_tokens: PilotMetric; input_tokens: PilotMetric; cached_input_tokens: PilotMetric; rework_count: PilotMetric; verification: string; review: string; authority_violations: PilotMetric };
type PilotIntent = { intent_id: string; action: string; status: string; message?: string; updated_at?: string };
type PilotProject = { project_id: string; workspace: string; workspaces: string[]; context_management: { state: string; observed_at: string; applies_to: string; error?: string; evidence: Array<{ workspace: string; state: string; config_path: string; error?: string }> }; latest_intent: PilotIntent | null; trial: { completed: number; target: number; tasks: PilotTrial[] } };
type PilotData = { generated_at: string; projects: PilotProject[] };
const actionHeaders = { "content-type": "application/json", "x-taskcenter-action": "delegate" };
const entries: Array<[Section, string, string]> = [["sessions", "/sessions", "会话"], ["routing", "/routing", "模型调度"], ["improvements", "/improvements", "改进建议"], ["settings", "/settings", "设置"]];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/control${path}`, { cache: "no-store", ...init });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data as T;
}

function useUrlState(name: string, fallback: string) {
  const [value, setValue] = useState(() => typeof window === "undefined" ? fallback : new URLSearchParams(window.location.search).get(name) || fallback);
  const update = (next: string) => { const params = new URLSearchParams(window.location.search); if (next === fallback) params.delete(name); else params.set(name, next); window.history.pushState({}, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`); setValue(next); };
  return [value, update] as const;
}

function Layout({ section, children }: { section: Section; children: ReactNode }) {
  return <main className="task-workspace"><aside className="task-nav"><a className="task-logo" href="/tasks">TASK<span>CENTER</span></a><nav><a href="/tasks">任务工作区</a>{entries.map(([key, href, label]) => <a key={key} className={key === section ? "active" : ""} href={href}>{label}</a>)}<a href="/legacy">旧版首页</a></nav></aside><section className="task-main">{children}</section></main>;
}

function Header({ code, title, description, refresh }: { code: string; title: string; description: string; refresh: () => void }) {
  return <header className="task-header"><div><p>{code}</p><h1>{title}</h1><small>{description}</small></div><button onClick={refresh}>刷新</button></header>;
}

export function ConsolePage({ section }: { section: Section }) {
  return <Layout section={section}>{section === "sessions" ? <Sessions /> : section === "routing" ? <Routing /> : section === "improvements" ? <Improvements /> : <Settings />}</Layout>;
}

function Sessions() {
  const [filter, setFilter] = useUrlState("filter", "registered"); const [state, setState] = useState<SessionData>(); const [ids, setIds] = useState<string[]>([]); const [notice, setNotice] = useState("");
  const load = useCallback(async () => { try { const [status, read, gate] = await Promise.all([api<SessionData["status"]>("/session-status"), api<SessionData["read"]>("/session-selection"), api<SessionData["gate"]>("/gate-session-allowlist")]); setState({ status, read, gate }); setIds(read.selection?.threadIds || []); } catch (error) { setNotice(error instanceof Error ? error.message : "读取失败"); } }, []);
  useEffect(() => { const timer = window.setTimeout(load, 0); return () => window.clearTimeout(timer); }, [load]);
  const save = async () => { try { await api("/session-selection", { method: "POST", headers: actionHeaders, body: JSON.stringify({ mode: "allowlist", threadIds: ids }) }); setNotice("读取白名单已保存"); load(); } catch (error) { setNotice(error instanceof Error ? error.message : "保存失败"); } };
  const toggleGate = async (session_id: string, enabled: boolean) => { try { await api("/gate-session-allowlist/session", { method: "POST", headers: actionHeaders, body: JSON.stringify({ session_id, enabled }) }); load(); } catch (error) { setNotice(error instanceof Error ? error.message : "更新失败"); } };
  const gateIds = state?.gate?.selection?.threadIds || []; const sessions = (state?.status?.sessions || []).filter((item) => filter === "all" || item.status === "registered");
  return <><Header code="SESSION CONTROL" title="会话与读取边界" description="只展示真实登记状态；读取和门禁白名单均由现有 Control API 保存。" refresh={load} /><p className="console-toolbar"><label>范围 <select value={filter} onChange={event => setFilter(event.target.value)}><option value="registered">已登记</option><option value="all">全部可见</option></select></label>{notice}</p><div className="console-list">{sessions.map((item) => <article className="console-card" key={item.sessionId}><strong>{item.sessionId}</strong><p>关联任务：{item.taskCount ?? 0} · 状态：{item.status || "unknown"} · 门禁豁免：{gateIds.includes(item.sessionId) ? "已启用" : "未启用"}</p><button onClick={() => toggleGate(item.sessionId, !gateIds.includes(item.sessionId))}>{gateIds.includes(item.sessionId) ? "退出门禁豁免" : "加入门禁豁免"}</button></article>)}</div><section className="console-card"><h2>允许读取的 Codex 会话</h2>{(state?.read?.availableThreads || []).map((thread) => <label className="console-check" key={thread.id}><input type="checkbox" checked={ids.includes(thread.id)} onChange={() => setIds(current => current.includes(thread.id) ? current.filter(id => id !== thread.id) : [...current, thread.id])} />{thread.title || thread.id}</label>)}<button onClick={save}>保存读取白名单</button></section></>;
}

function Routing() {
  const [state, setState] = useState<RoutingData>(); const [preset, setPreset] = useState("saving"); const [threshold, setThreshold] = useState(0); const [notice, setNotice] = useState("");
  const load = useCallback(async () => { try { const [health, policy] = await Promise.all([api<RoutingData>("/routing/health"), api<{ policy?: { preset?: string; threshold_percent?: number } }>("/routing/optional-astra-policy")]); setState(health); setPreset(policy.policy?.preset || "saving"); setThreshold(policy.policy?.threshold_percent || 0); } catch (error) { setNotice(error instanceof Error ? error.message : "读取失败"); } }, []);
  useEffect(() => { const timer = window.setTimeout(load, 0); return () => window.clearTimeout(timer); }, [load]);
  const save = async () => { try { await api("/routing/optional-astra-policy", { method: "POST", headers: actionHeaders, body: JSON.stringify({ preset, threshold_percent: Number(threshold) }) }); setNotice("策略已更新"); load(); } catch (error) { setNotice(error instanceof Error ? error.message : "更新失败"); } };
  const roles = state?.roles || {};
  return <><Header code="ROUTING POLICY" title="模型调度" description="角色模型、任务类别推理等级、健康度和回退策略均来自当前路由控制面。" refresh={load} /><p>{notice}</p><div className="console-list">{(state?.models || []).map((health) => <article className="console-card" key={health.model}><strong>{health.model}</strong><p>熔断：{health.state} · 并发：{health.active_executors}/{health.concurrency_limit} · 失败：{health.consecutive_failures} · 额度池：{health.quota_limit_id || "未限流"}</p></article>)}</div><section className="console-card"><h2>角色策略</h2>{(["executor", "reviewer"] as const).map(role => { const value = roles[role]; return value ? <p key={role}><strong>{role}</strong>：{value.model} · 默认 {value.reasoning_effort} · 回退 {(value.fallback_models || []).join("、") || "无"} · 任务推理 {Object.entries(value.task_class_reasoning_efforts || {}).map(([key, effort]) => `${key}:${effort}`).join("，") || "沿用默认"}</p> : null; })}<p>仅手动模型：{(roles.manual_only_models || []).join("、") || "无"}</p></section><section className="console-card"><h2>可选 Astra 策略</h2><label>预设 <select value={preset} onChange={event => setPreset(event.target.value)}><option value="saving">节省</option><option value="balanced">平衡</option><option value="quality">质量</option><option value="custom">自定义</option></select></label><label> 阈值 <input type="number" min="0" max="100" value={threshold} onChange={event => setThreshold(Number(event.target.value))} />%</label><button onClick={save}>保存策略</button></section></>;
}

function Improvements() {
  const [filter, setFilter] = useUrlState("status", "all"); const [state, setState] = useState<ReflectionData>(); const [notice, setNotice] = useState("");
  const load = useCallback(async () => { try { setState(await api<ReflectionData>("/reflections")); } catch (error) { setNotice(error instanceof Error ? error.message : "读取失败"); } }, []);
  useEffect(() => { const timer = window.setTimeout(load, 0); return () => window.clearTimeout(timer); }, [load]);
  const post = async (path: string, body?: unknown) => { try { await api(path, { method: "POST", headers: actionHeaders, body: body ? JSON.stringify(body) : undefined }); setNotice("操作已提交"); load(); } catch (error) { setNotice(error instanceof Error ? error.message : "操作失败"); } };
  const proposals = (state?.proposals || []).filter((item) => filter === "all" || item.status === filter);
  return <><Header code="REFLECTIONS" title="改进建议" description="筛选、决策、执行和重新验证复用现有反思引擎。" refresh={() => post("/reflections/run")} /><p className="console-toolbar"><label>状态 <select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部</option><option value="proposed">待决策</option><option value="accepted">已接受</option><option value="rejected">已拒绝</option><option value="resolved">已解决</option></select></label>{notice}</p><div className="console-list">{proposals.map((item) => <article className="console-card" key={item.id}><p>{item.status || "proposed"}</p><h2>{item.title || item.id}</h2><p>{item.summary || item.reason || "无额外说明"}</p>{item.executionPolicy === "agent_task" && item.status === "proposed" && <><button onClick={() => post(`/reflections/${item.id}/actions`, { decision: "accepted" })}>接受</button><button onClick={() => post(`/reflections/${item.id}/actions`, { decision: "rejected" })}>拒绝</button></>}{item.executionPolicy === "agent_task" && ["accepted", "rejected"].includes(item.status || "") && <button onClick={() => post(`/reflections/${item.id}/actions`, { decision: "proposed" })}>重新审核</button>}{item.executionPolicy === "agent_task" && item.status === "accepted" && <button onClick={() => post(`/reflections/${item.id}/execute`, { requestId: crypto.randomUUID(), mode: "new_session" })}>执行</button>}</article>)}</div>{!proposals.length && <p>没有符合当前筛选条件的真实建议。</p>}</>;
}

function Settings() {
  const [health, setHealth] = useState<HealthData>(); const [pilots, setPilots] = useState<PilotData>(); const [notice, setNotice] = useState("");
  const load = useCallback(async () => { try { const [nextHealth, nextPilots] = await Promise.all([api<HealthData>("/health"), api<PilotData>("/context-management-pilots")]); setHealth(nextHealth); setPilots(nextPilots); } catch (error) { setNotice(error instanceof Error ? error.message : "读取失败"); } }, []);
  useEffect(() => { const timer = window.setTimeout(load, 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => { if (!(pilots?.projects || []).some(item => ["pending", "processing"].includes(item.latest_intent?.status || ""))) return; const timer = window.setInterval(load, 5000); return () => window.clearInterval(timer); }, [load, pilots]);
  const sync = async () => { try { await api("/sync", { method: "POST", headers: actionHeaders, body: "{}" }); setNotice("同步已触发"); load(); } catch (error) { setNotice(error instanceof Error ? error.message : "同步失败"); } };
  const act = async (project: PilotProject, action: string) => { const optimistic: PilotIntent = { intent_id: "pending", action, status: "pending", updated_at: new Date().toISOString() }; setPilots(current => current ? { ...current, projects: current.projects.map(item => item.project_id === project.project_id ? { ...item, latest_intent: optimistic } : item) } : current); try { const result = await api<{ snapshot: PilotData }>(`/context-management-pilots/${encodeURIComponent(project.project_id)}/actions`, { method: "POST", headers: actionHeaders, body: JSON.stringify({ requestId: crypto.randomUUID(), action }) }); setPilots(result.snapshot); setNotice("操作已进入主脑处理队列"); } catch (error) { setNotice(error instanceof Error ? error.message : "操作失败"); load(); } };
  const value = (item: PilotMetric) => item === "unknown" ? "unknown" : item.toLocaleString();
  return <><Header code="SERVICE SETTINGS" title="设置与边界" description="本机服务状态、试点证据与受审计控制入口。" refresh={load} /><p>{notice}</p><div className="console-list"><article className="console-card"><h2>本地服务</h2><p>状态：{health?.ok ? "正常" : "未连接"} · 运行时间：{health?.control?.uptimeSeconds ?? "-"} 秒</p><button onClick={sync}>立即同步</button></article><article className="console-card"><h2>数据来源</h2><p>Dashboard：{health?.dashboard?.readable ? "可读" : "不可读"} · Ledger：{health?.ledger?.readable ? "可读" : "不可读"} · Watcher：{health?.watcher?.healthy ? "健康" : "需关注"}</p></article>{(pilots?.projects || []).map(project => <article className="console-card context-pilot" key={project.project_id}><div className="context-pilot-head"><div><small>ASTRA CONTEXT PILOT</small><h2>{project.project_id}</h2><p>{project.workspace}</p></div><strong className={`status-${project.context_management.state}`}>{project.context_management.state}</strong></div><p>采集：{project.context_management.observed_at} · 仅对新任务生效 · 自然长任务 {project.trial.completed}/{project.trial.target}</p>{project.context_management.error && <p className="attention">{project.context_management.error}</p>}<details><summary>配置证据 · {project.context_management.evidence.length} 个已登记 workspace</summary>{project.context_management.evidence.map(item => <p key={item.workspace}><strong>{item.state}</strong> · {item.workspace}<br /><small>{item.config_path}{item.error ? ` · ${item.error}` : ""}</small></p>)}</details>{project.latest_intent && <p className="context-pilot-intent">{project.latest_intent.action} · {project.latest_intent.status}{project.latest_intent.message ? ` · ${project.latest_intent.message}` : ""}</p>}<div className="context-pilot-actions"><button onClick={() => act(project, "enable")}>启用试点</button><button onClick={() => act(project, "disable")}>停用并回退</button><button onClick={() => act(project, "refresh")}>刷新证据</button></div><p><small>停用会让当前任务软停止依赖自动历史；硬回退需关闭项目配置后新建 Astra 任务。</small></p>{project.trial.tasks.map(task => <details key={task.task_id}><summary>{task.task_id} · prepare_turn {task.prepare_turn}</summary><div className="context-pilot-metrics"><span>重复读取 {value(task.repeated_reads)}</span><span>恢复成本 {value(task.recovery_cost_tokens)}</span><span>Input {value(task.input_tokens)}</span><span>Cached Input {value(task.cached_input_tokens)}</span><span>返工 {value(task.rework_count)}</span><span>验证 {task.verification}</span><span>Review {task.review}</span><span>权威违规 {value(task.authority_violations)}</span></div></details>)}</article>)}<article className="console-card"><h2>隐私与配置</h2><p>TaskCenter 只记录 intent、证据与回执，不直接修改外部项目或 ~/.codex。</p><a href="/sessions">管理读取白名单</a> · <a href="/routing">调整模型策略</a></article></div></>;
}
