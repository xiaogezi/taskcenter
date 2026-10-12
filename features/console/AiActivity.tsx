"use client";
import { useCallback, useEffect, useState } from "react";

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type Snapshot = { input_hash: string; references: Array<{ id: string; text: string }>; scope: string; truncated: boolean };
type Row = { id: string; run_id?: string; source: string; at: string; task_id?: string; title: string; model: string; status: string; summary?: string; duration_ms?: number; usage?: Record<string, unknown>; snapshot?: Snapshot; input_hash?: string; prompt_version?: string; error?: string; fallback_reason?: string; result?: Record<string, unknown> };
type Activity = { rows: Row[]; running: boolean; warnings: string[]; coverage: string; next_cursor?: string };
const sources: Record<string, string> = { governance: "治理分析", jev: "Jev 判断" };
const statuses: Record<string, string> = { degraded: "规则降级", started: "已启动", succeeded: "成功", completed: "完成", failed: "失败", skipped: "跳过", unknown: "未知", issued: "授权已签发", leased: "路由已选择", active: "运行中", expired: "过期", cancelled: "取消", revoked: "撤销", actual_route: "实际路由" };

export function AiActivity({ request }: { request: Request }) {
  const [activity, setActivity] = useState<Activity>();
  const [source, setSource] = useState(""); const [before, setBefore] = useState("");
  const [taskId, setTaskId] = useState(""); const [kind, setKind] = useState("evidence");
  const [tasks, setTasks] = useState<Array<{ id: string; title: string }>>([]);
  const [snapshot, setSnapshot] = useState<Snapshot>(); const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    try { setActivity(await request<Activity>(`/ai/activity?${new URLSearchParams({ limit: "30", source, before })}`)); }
    catch (error) { setNotice(error instanceof Error ? error.message : "行为读取失败"); }
  }, [request, source, before]);
  useEffect(() => { const initial = window.setTimeout(load, 0), timer = window.setInterval(load, 5000); return () => { window.clearTimeout(initial); window.clearInterval(timer); }; }, [load]);
  useEffect(() => { void request<{ tasks: Array<{ id: string; title: string }> }>("/tasks?view=summary&page_size=100").then(data => setTasks(data.tasks || [])).catch(() => setNotice("任务列表读取失败；可直接输入任务 ID")); }, [request]);
  const preview = async () => {
    setBusy(true); setConfirmed(false); setSnapshot(undefined);
    try { setSnapshot(await request<Snapshot>(`/ai/snapshot?${new URLSearchParams({ task_id: taskId, kind })}`)); setNotice(""); }
    catch (error) { setNotice(error instanceof Error ? error.message : "快照读取失败"); }
    finally { setBusy(false); }
  };
  const analyze = async (mode = "ai") => {
    setBusy(true);
    try { await request("/ai/analyze", { method: "POST", headers: { "content-type": "application/json", "x-taskcenter-action": "delegate" }, body: JSON.stringify({ task_id: taskId, kind, mode, confirm_data_scope: confirmed, input_hash: snapshot?.input_hash }) }); setConfirmed(false); setNotice("请求已受理，结果会自动出现在时间线。"); setBefore(""); await load(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "分析启动失败"); }
    finally { setBusy(false); }
  };
  const rows = activity?.rows || [];
  return <>
    <header className="task-header"><div><p>AI ACTIVITY</p><h1>AI 行为</h1><small>查看调用范围、建议、实际动作与结果。</small></div><button onClick={() => { setBefore(""); void load(); }}>刷新</button></header>
    <section className="console-card ai-analysis"><h2>分析任务</h2><div className="console-toolbar">
      <label>任务 <input list="ai-tasks" value={taskId} disabled={busy} placeholder="选择或输入任务 ID" onChange={event => { setTaskId(event.target.value); setSnapshot(undefined); setConfirmed(false); }} /></label><datalist id="ai-tasks">{tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</datalist>
      <label>分析类型 <select value={kind} disabled={busy} onChange={event => { setKind(event.target.value); setSnapshot(undefined); setConfirmed(false); }}><option value="evidence">完成证据分析</option><option value="blockers">失败与阻塞复盘</option></select></label><button disabled={busy || !taskId} onClick={() => void preview()}>预览发送内容</button>
    </div>{snapshot && <><details open><summary>发送快照 · {snapshot.references.length} 项引用{snapshot.truncated ? " · 已截断" : ""}</summary><p>{snapshot.scope}</p><pre>{JSON.stringify(snapshot, null, 2)}</pre></details><label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />允许将以上快照发送给配置的模型服务</label><p><button disabled={busy || !confirmed || activity?.running} onClick={() => void analyze()}>开始分析</button><button disabled={busy} onClick={() => void analyze("rules")}>仅规则检查</button></p></>}<p role="status">{activity?.running ? "AI 正在分析，最长等待 120 秒。" : notice}</p><small>AI 不可用时自动返回规则检查；也可直接使用规则检查，不发送模型。任务与验收状态不受影响。</small></section>
    <section className="ai-source-bars" aria-label="本页行为分布">{Object.entries(sources).map(([key, label]) => { const count = rows.filter(row => row.source === key).length; return <div key={key}><span>{label}</span><meter min="0" max={Math.max(1, rows.length)} value={count} /><strong>{count}</strong></div>; })}<small>计数仅覆盖当前页。</small></section>
    <p className="console-toolbar"><label>来源 <select value={source} onChange={event => { setSource(event.target.value); setBefore(""); }}><option value="">全部 AI 行为</option>{Object.entries(sources).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><span>{activity?.coverage}</span></p>{activity?.warnings.map(warning => <p role="alert" key={warning}>{warning}</p>)}
    <div className="ai-timeline">{rows.map(row => <article className={`console-card ai-event ${row.status === "failed" ? "ai-failed" : ""}`} key={row.id}>
      <div className="ai-event-heading"><strong>{sources[row.source]} · {row.title}</strong><span>{statuses[row.status] || row.status}</span></div><p><time dateTime={row.at}>{new Date(row.at).toLocaleString("zh-CN")}</time> · {row.model}{typeof row.duration_ms === "number" ? ` · ${(row.duration_ms / 1000).toFixed(2)} 秒` : " · 耗时未知"}</p><p>{row.task_id && <a href={`/tasks?task=${encodeURIComponent(row.task_id)}`}>{row.task_id}</a>} · {row.summary}</p>

      <details><summary>查看依据与结果</summary>{row.snapshot && <pre>{JSON.stringify(row.snapshot, null, 2)}</pre>}{row.result && <pre>{JSON.stringify(row.result, null, 2)}</pre>}<p>输入指纹：{row.input_hash || "未记录"} · Prompt：{row.prompt_version || "未记录"}</p><p>调用：{row.run_id || row.id} · 错误：{row.error || row.fallback_reason || "无"}</p><p>用量：{row.usage ? JSON.stringify(row.usage) : "未提供，不计为零"}</p></details>
    </article>)}</div>{!rows.length && <p>暂无符合筛选条件的 AI 行为。</p>}<footer className="task-pagination"><button disabled={!before} onClick={() => setBefore("")}>返回最新</button><button disabled={!activity?.next_cursor} onClick={() => setBefore(activity?.next_cursor || "")}>查看更早行为</button></footer>
  </>;
}
