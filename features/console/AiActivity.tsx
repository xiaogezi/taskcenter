"use client";
import { useCallback, useEffect, useState } from "react";

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type Snapshot = { input_hash: string; references: Array<{ id: string; text: string }>; scope: string; truncated: boolean };
type FollowUp = { status: string; updated_at?: string; changed_since_analysis: boolean | null; verification_status: string; acceptance_status: string; attribution: string; remaining_steps: Array<{ id: string; action: string; tool: string; reason: string }> };
type Row = { id: string; run_id?: string; source: string; at: string; task_id?: string; title: string; model: string; status: string; mode?: string; trigger?: string; decision?: string; decision_reason?: string; summary?: string; duration_ms?: number; usage?: Record<string, unknown>; snapshot?: Snapshot; input_hash?: string; prompt_version?: string; error?: string; fallback_reason?: string; result?: Record<string, unknown>; follow_up?: FollowUp };
type Activity = { current_action?: { task_id: string; title: string; phase: string; reason: string; step: string; next_action: string; operation?: { summary: string; status: string; at: string } } | null; rows: Row[]; running: boolean; warnings: string[]; coverage: string; next_cursor?: string; maintenance?: Record<string, number>; work?: { id: string; total: number; pending: number }; observer?: { status: string; stale?: boolean; scope?: string; maintenance?: { status: string; task_id?: string }; workspace?: string; current_task_id?: string; pending_tasks?: number; reason?: string; last_result_at?: string } };
const decisions: Record<string, string> = { observe: "继续观察", evidence: "分析完成证据", blockers: "复盘失败阻塞" };
const sources: Record<string, string> = { governance: "治理分析", jev: "Jev 判断", reconciliation: "自主处置", maintenance: "维护行动" };
const statuses: Record<string, string> = { degraded: "规则降级", started: "已启动", succeeded: "成功", completed: "完成", failed: "失败", skipped: "跳过", unknown: "未知", issued: "授权已签发", leased: "路由已选择", active: "运行中", expired: "过期", cancelled: "取消", revoked: "撤销", actual_route: "实际路由" };
Object.assign(statuses, { queued: "行动待执行", running: "执行中", retry_wait: "等待恢复", attention: "待核对接续", waiting_owner: "等待原执行者", tool_started: "工具执行中", tool_completed: "工具已返回", tool_failed: "工具错误" });

export function AiActivity({ request }: { request: Request }) {
  const [activity, setActivity] = useState<Activity>();
  const [source, setSource] = useState(""); const [before, setBefore] = useState("");
  const [taskId, setTaskId] = useState(""); const [kind, setKind] = useState("evidence");
  const [tasks, setTasks] = useState<Array<{ id: string; title: string }>>([]);
  const [snapshot, setSnapshot] = useState<Snapshot>(); const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState("");
  const [activityError, setActivityError] = useState("");
  const load = useCallback(async () => {
    try { setActivity(await request<Activity>(`/ai/activity?${new URLSearchParams({ limit: "30", source, before })}`)); setActivityError(""); }
    catch (error) { setActivityError(error instanceof Error ? error.message : "行为读取失败"); }
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
  const work = async () => {
    setBusy(true);
    try {
      const result = await request<{ queued: number; reused: boolean }>("/ai/work", { method: "POST", headers: { "content-type": "application/json", "x-taskcenter-action": "delegate" }, body: "{}" });
      setNotice(`${result.reused ? "继续已有处理轮次" : "已受理主动处理"}：核实队列 ${result.queued} 条；本地对账在后台执行，实际结果会出现在下方时间线。`);
      setBefore(""); await load();
    } catch (error) { setNotice(error instanceof Error ? error.message : "主动处理启动失败"); }
    finally { setBusy(false); }
  };
  return <>
    <header className="task-header"><div><p>AI ACTIVITY</p><h1>AI 行为</h1><small>发现异常、执行维护、验证效果；每一步保存真实回执。</small></div><div><button disabled={busy} onClick={() => void work()}>{busy ? "正在受理…" : "立即主动处理"}</button><button onClick={() => { setBefore(""); void load(); }}>刷新</button></div></header>
    <p role="status">{notice}</p>{activityError && <p role="alert">时间线刷新失败：{activityError}；已受理请求的后台处理不受此提示影响。</p>}{activity?.work && <p>本轮核实：已处理 {activity.work.total - activity.work.pending} / {activity.work.total} 条。结果包括分析、规则降级与跳过，不代表业务任务完成。</p>}
    <section className="console-card ai-analysis" aria-label="AI 当前行动"><h2>AI 现在在做什么</h2>{activity?.current_action ? <>
      <h3><a href={`/tasks?task=${encodeURIComponent(activity.current_action.task_id)}`}>{activity.current_action.title || "未命名任务"}</a></h3>
      <p role="status">{activity.current_action.phase === "executing" ? "正在执行维护" : activity.current_action.phase === "analyzing" ? "正在分析" : activity.current_action.phase === "stale" ? "心跳已过期，以下为最后记录" : `最近行动：${statuses[activity.current_action.phase] || activity.current_action.phase}`}</p>
      <p>处理原因：{activity.current_action.reason || "尚未记录"}</p><p>当前步骤：{activity.current_action.step || "正在核对任务，尚未登记阶段"}</p>
      <p>最近操作：{activity.current_action.operation?.summary || "此行动尚无操作详情记录"}</p>{activity.current_action.operation && <small>记录于 {new Date(activity.current_action.operation.at).toLocaleString("zh-CN")}</small>}
      <p>下一步：{activity.current_action.next_action || "等待执行者登记下一步"}</p>
    </> : <p>当前没有可展示的维护行动。观察器正在运行时会继续核对任务；实际动作将在这里显示。</p>}</section>
    <section className="console-card ai-analysis"><h2>自主治理与行动</h2><p role="status">{!activity ? "正在读取观察器状态…" : activity.observer?.stale ? "观察器心跳已停止，主线工具仍可使用" : activity.observer?.maintenance?.status === "executing" ? "Claude Agent 正在执行系统维护" : activity.observer?.status === "analyzing" ? "AI 正在自主判断与分析" : activity.observer?.status === "watching" ? "正在自动观察任务变化" : "自动观察器未运行"}</p><p>治理范围：{activity?.observer?.scope === "all_projects" ? "全部项目" : "当前项目"}的活跃任务与异常；分析后自动排队行动，无需选择任务 ID。</p><p>待判断：{activity?.observer?.pending_tasks ?? "未知"}</p><p>行动：待执行 {activity?.maintenance?.queued || 0} · 执行中 {activity?.maintenance?.running || 0} · 已闭环 {activity?.maintenance?.completed || 0} · 等待恢复 {activity?.maintenance?.retry_wait || 0} · 待核对接续 {activity?.maintenance?.attention || 0}</p>{activity?.observer?.reason && <p>{activity.observer.reason}</p>}<small>维护 Agent 在原契约内接续已确认停止的任务，实际执行并提交验证证据。CLI 不可用时本地对账继续、行动持久保留；任务交付与独立验收分别记录。</small></section>
    <details className="console-card ai-analysis"><summary>手动补充分析</summary><h2>分析任务</h2><div className="console-toolbar">
      <label>任务 <input list="ai-tasks" value={taskId} disabled={busy} placeholder="选择或输入任务 ID" onChange={event => { setTaskId(event.target.value); setSnapshot(undefined); setConfirmed(false); }} /></label><datalist id="ai-tasks">{tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</datalist>
      <label>分析类型 <select value={kind} disabled={busy} onChange={event => { setKind(event.target.value); setSnapshot(undefined); setConfirmed(false); }}><option value="evidence">完成证据分析</option><option value="blockers">失败与阻塞复盘</option></select></label><button disabled={busy || !taskId} onClick={() => void preview()}>预览发送内容</button>
    </div>{snapshot && <><details open><summary>发送快照 · {snapshot.references.length} 项引用{snapshot.truncated ? " · 已截断" : ""}</summary><p>{snapshot.scope}</p><pre>{JSON.stringify(snapshot, null, 2)}</pre></details><label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />允许将以上快照发送给配置的模型服务</label><p><button disabled={busy || !confirmed || activity?.running} onClick={() => void analyze()}>开始分析</button><button disabled={busy} onClick={() => void analyze("rules")}>仅规则检查</button></p></>}<p role="status">{notice}</p><small>此入口用于临时补充分析，自动治理不依赖手动操作。</small></details>
    <section className="ai-source-bars" aria-label="本页行为分布">{Object.entries(sources).map(([key, label]) => { const count = rows.filter(row => row.source === key).length; return <div key={key}><span>{label}</span><meter min="0" max={Math.max(1, rows.length)} value={count} /><strong>{count}</strong></div>; })}<small>计数仅覆盖当前页。</small></section>
    <p className="console-toolbar"><label>来源 <select value={source} onChange={event => { setSource(event.target.value); setBefore(""); }}><option value="">全部 AI 行为</option>{Object.entries(sources).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><span>{activity?.coverage}</span></p>{activity?.warnings.map(warning => <p role="alert" key={warning}>{warning}</p>)}
    <div className="ai-timeline">{rows.map(row => <article className={`console-card ai-event ${row.status === "failed" ? "ai-failed" : ""}`} key={row.id}>
      <div className="ai-event-heading"><strong>{sources[row.source]} · {row.title}</strong><span>{statuses[row.status] || row.status}</span></div><p><time dateTime={row.at}>{new Date(row.at).toLocaleString("zh-CN")}</time> · {row.model}{typeof row.duration_ms === "number" ? ` · ${(row.duration_ms / 1000).toFixed(2)} 秒` : " · 耗时未知"}</p><p>{row.task_id && <a href={`/tasks?task=${encodeURIComponent(row.task_id)}`}>{row.task_id}</a>} · {row.summary}</p>{row.mode === "automatic" && <p>触发：{row.trigger === "manual_work" ? "立即主动处理" : row.trigger === "active_task" ? "活跃任务" : "任务内容变化"} · 判断：{decisions[row.decision || ""] || (row.trigger === "manual_work" && !row.task_id ? "已排队" : "判断中")}{row.decision_reason ? ` · ${row.decision_reason}` : ""}</p>}
      {row.source === "reconciliation" && <section><h3>实际处置</h3><p>动作：{row.result?.action === "delivery_reconciled" ? "补齐交付声明" : row.result?.action === "recovery_pending" ? "登记运行缺项与恢复动作" : "收口运行并登记执行待确认"} · 依据：{String(row.result?.basis || "未知")}</p>{typeof row.result?.next_action === "string" && <p>恢复动作：{row.result.next_action}</p>}{typeof row.result?.error === "string" && <p role="alert">{String(row.result.error)}</p>}</section>}
      {Array.isArray(row.result?.next_steps) && row.result.next_steps.length > 0 && <section><h3>推进建议</h3><ol>{(row.result.next_steps as string[]).map((step, index) => <li key={index}>{step}</li>)}</ol></section>}
      {row.follow_up && <section><h3>任务后续事实</h3><p>{row.follow_up.changed_since_analysis === true ? "分析后任务内容已变化" : row.follow_up.changed_since_analysis === false ? "尚无新的任务内容变化" : "无法核对内容变化"} · 执行：{row.follow_up.status} · 验证：{row.follow_up.verification_status} · 验收：{row.follow_up.acceptance_status}</p><p>{row.follow_up.attribution}</p><details><summary>当前可继续的动作</summary><ol>{row.follow_up.remaining_steps.map(step => <li key={step.id}>{step.action}<small> · {step.tool} · {step.reason}</small></li>)}</ol></details></section>}
      <details><summary>查看依据与结果</summary>{row.snapshot && <pre>{JSON.stringify(row.snapshot, null, 2)}</pre>}{row.result && <pre>{JSON.stringify(row.result, null, 2)}</pre>}<p>输入指纹：{row.input_hash || "未记录"} · Prompt：{row.prompt_version || "未记录"}</p><p>调用：{row.run_id || row.id} · 错误：{row.error || row.fallback_reason || "无"}</p><p>用量：{row.usage ? JSON.stringify(row.usage) : "未提供，不计为零"}</p></details>
    </article>)}</div>{!rows.length && <p>暂无符合筛选条件的记录。观察器会自动关联当前项目的任务，并记录参与判断、分析或规则降级结果。</p>}<footer className="task-pagination"><button disabled={!before} onClick={() => setBefore("")}>返回最新</button><button disabled={!activity?.next_cursor} onClick={() => setBefore(activity?.next_cursor || "")}>查看更早行为</button></footer>
  </>;
}
