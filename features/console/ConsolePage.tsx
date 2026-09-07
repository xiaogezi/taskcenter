"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

type Section = "sessions" | "routing" | "improvements" | "settings";
const actionHeaders = { "content-type": "application/json", "x-taskcenter-action": "delegate" };
const entries: Array<[Section, string, string]> = [["sessions", "/sessions", "会话"], ["routing", "/routing", "模型调度"], ["improvements", "/improvements", "改进建议"], ["settings", "/settings", "设置"]];

async function api(path: string, init?: RequestInit) {
  const response = await fetch(`/api/control${path}`, { cache: "no-store", ...init });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

function useUrlState(name: string, fallback: string) {
  const [value, setValue] = useState(() => new URLSearchParams(location.search).get(name) || fallback);
  const update = (next: string) => { const params = new URLSearchParams(location.search); next === fallback ? params.delete(name) : params.set(name, next); history.pushState({}, "", `${location.pathname}${params.size ? `?${params}` : ""}`); setValue(next); };
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
  const [filter, setFilter] = useUrlState("filter", "registered"); const [state, setState] = useState<any>(); const [ids, setIds] = useState<string[]>([]); const [notice, setNotice] = useState("");
  const load = useCallback(async () => { try { const [status, read, gate] = await Promise.all([api("/session-status"), api("/session-selection"), api("/gate-session-allowlist")]); setState({ status, read, gate }); setIds(read.selection?.threadIds || []); } catch (error) { setNotice(error instanceof Error ? error.message : "读取失败"); } }, []);
  useEffect(() => { load(); }, [load]);
  const save = async () => { try { await api("/session-selection", { method: "POST", headers: actionHeaders, body: JSON.stringify({ mode: "allowlist", threadIds: ids }) }); setNotice("读取白名单已保存"); load(); } catch (error) { setNotice(error instanceof Error ? error.message : "保存失败"); } };
  const toggleGate = async (session_id: string, enabled: boolean) => { try { await api("/gate-session-allowlist/session", { method: "POST", headers: actionHeaders, body: JSON.stringify({ session_id, enabled }) }); load(); } catch (error) { setNotice(error instanceof Error ? error.message : "更新失败"); } };
  const gateIds = state?.gate?.selection?.threadIds || []; const sessions = (state?.status?.sessions || []).filter((item: any) => filter === "all" || item.registered !== false);
  return <><Header code="SESSION CONTROL" title="会话与读取边界" description="只展示真实登记状态；读取和门禁白名单均由现有 Control API 保存。" refresh={load} /><p className="console-toolbar"><label>范围 <select value={filter} onChange={event => setFilter(event.target.value)}><option value="registered">已登记</option><option value="all">全部可见</option></select></label>{notice}</p><div className="console-list">{sessions.map((item: any) => <article className="console-card" key={item.sessionId}><strong>{item.sessionId}</strong><p>关联任务：{item.taskCount ?? 0} · 状态：{item.status || "unknown"} · 门禁豁免：{gateIds.includes(item.sessionId) ? "已启用" : "未启用"}</p><button onClick={() => toggleGate(item.sessionId, !gateIds.includes(item.sessionId))}>{gateIds.includes(item.sessionId) ? "退出门禁豁免" : "加入门禁豁免"}</button></article>)}</div><section className="console-card"><h2>允许读取的 Codex 会话</h2>{(state?.read?.availableThreads || []).map((thread: any) => <label className="console-check" key={thread.id}><input type="checkbox" checked={ids.includes(thread.id)} onChange={() => setIds(current => current.includes(thread.id) ? current.filter(id => id !== thread.id) : [...current, thread.id])} />{thread.title || thread.id}</label>)}<button onClick={save}>保存读取白名单</button></section></>;
}

function Routing() {
  const [state, setState] = useState<any>(); const [preset, setPreset] = useState("saving"); const [threshold, setThreshold] = useState(0); const [notice, setNotice] = useState("");
  const load = useCallback(async () => { try { const [health, policy] = await Promise.all([api("/routing/health"), api("/routing/optional-astra-policy")]); setState(health); setPreset(policy.policy?.preset || "saving"); setThreshold(policy.policy?.threshold_percent || 0); } catch (error) { setNotice(error instanceof Error ? error.message : "读取失败"); } }, []);
  useEffect(() => { load(); }, [load]);
  const save = async () => { try { await api("/routing/optional-astra-policy", { method: "POST", headers: actionHeaders, body: JSON.stringify({ preset, threshold_percent: Number(threshold) }) }); setNotice("策略已更新"); load(); } catch (error) { setNotice(error instanceof Error ? error.message : "更新失败"); } };
  const roles = state?.roles?.roles || {};
  return <><Header code="ROUTING POLICY" title="模型调度" description="角色模型、任务类别推理等级、健康度和回退策略均来自当前路由控制面。" refresh={load} /><p>{notice}</p><div className="console-list">{Object.entries(state?.models || {}).map(([model, health]: [string, any]) => <article className="console-card" key={model}><strong>{model}</strong><p>熔断：{health.state} · 并发：{health.active_executors}/{health.concurrency_limit} · 失败：{health.consecutive_failures}</p></article>)}</div><section className="console-card"><h2>角色策略</h2>{Object.entries(roles).map(([role, value]: [string, any]) => <p key={role}><strong>{role}</strong>：{value.model} · {value.reasoning_effort} · 回退 {(value.fallback_models || []).join("、") || "无"} · 任务推理 {Object.entries(value.task_class_reasoning_efforts || {}).map(([key, effort]) => `${key}:${effort}`).join("，") || "默认"}</p>)}</section><section className="console-card"><h2>可选 Astra 策略</h2><label>预设 <select value={preset} onChange={event => setPreset(event.target.value)}><option value="saving">节省</option><option value="balanced">平衡</option><option value="quality">质量</option><option value="custom">自定义</option></select></label><label> 阈值 <input type="number" min="0" max="100" value={threshold} onChange={event => setThreshold(Number(event.target.value))} />%</label><button onClick={save}>保存策略</button></section></>;
}

function Improvements() {
  const [filter, setFilter] = useUrlState("status", "all"); const [state, setState] = useState<any>(); const [notice, setNotice] = useState("");
  const load = useCallback(async () => { try { setState(await api("/reflections")); } catch (error) { setNotice(error instanceof Error ? error.message : "读取失败"); } }, []);
  useEffect(() => { load(); }, [load]);
  const post = async (path: string, body?: unknown) => { try { await api(path, { method: "POST", headers: actionHeaders, body: body ? JSON.stringify(body) : undefined }); setNotice("操作已提交"); load(); } catch (error) { setNotice(error instanceof Error ? error.message : "操作失败"); } };
  const proposals = (state?.proposals || []).filter((item: any) => filter === "all" || item.status === filter);
  return <><Header code="REFLECTIONS" title="改进建议" description="筛选、决策、执行和重新验证复用现有反思引擎。" refresh={() => post("/reflections/run")} /><p className="console-toolbar"><label>状态 <select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部</option><option value="proposed">待决策</option><option value="accepted">已接受</option><option value="rejected">已拒绝</option></select></label>{notice}</p><div className="console-list">{proposals.map((item: any) => <article className="console-card" key={item.id}><p>{item.status || "proposed"}</p><h2>{item.title || item.id}</h2><p>{item.summary || item.reason || "无额外说明"}</p><button onClick={() => post(`/reflections/${item.id}/actions`, { decision: "accepted" })}>接受</button><button onClick={() => post(`/reflections/${item.id}/actions`, { decision: "rejected" })}>拒绝</button><button disabled={item.status !== "accepted"} onClick={() => post(`/reflections/${item.id}/execute`, { requestId: crypto.randomUUID(), mode: "new_session" })}>执行</button></article>)}</div>{!proposals.length && <p>没有符合当前筛选条件的真实建议。</p>}</>;
}

function Settings() {
  const [health, setHealth] = useState<any>(); const [notice, setNotice] = useState("");
  const load = useCallback(async () => { try { setHealth(await api("/health")); } catch (error) { setNotice(error instanceof Error ? error.message : "读取失败"); } }, []);
  useEffect(() => { load(); }, [load]);
  const sync = async () => { try { await api("/sync", { method: "POST", headers: actionHeaders, body: "{}" }); setNotice("同步已触发"); load(); } catch (error) { setNotice(error instanceof Error ? error.message : "同步失败"); } };
  return <><Header code="SERVICE SETTINGS" title="设置与边界" description="本机服务状态、数据来源、隐私边界与现有配置入口。" refresh={load} /><p>{notice}</p><div className="console-list"><article className="console-card"><h2>本地服务</h2><p>状态：{health?.ok ? "正常" : "未连接"} · 运行时间：{health?.control?.uptimeSeconds ?? "-"} 秒</p><button onClick={sync}>立即同步</button></article><article className="console-card"><h2>数据来源</h2><p>Dashboard：{health?.dashboard?.readable ? "可读" : "不可读"} · Ledger：{health?.ledger?.readable ? "可读" : "不可读"} · Watcher：{health?.watcher?.healthy ? "健康" : "需关注"}</p></article><article className="console-card"><h2>隐私与配置</h2><p>仅使用本机 Codex 会话索引与项目配置，不上传会话内容。</p><a href="/sessions">管理读取白名单</a> · <a href="/routing">调整模型策略</a></article></div></>;
}
