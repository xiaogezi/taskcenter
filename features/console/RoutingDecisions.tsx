"use client";

import { useEffect, useState } from "react";

type Jev = {
  phase_id?: string; phase_summary_excerpt?: string; status?: string; error?: string; model?: string;
  candidate_models?: string[]; requested_task_class?: string; requested_channel?: string;
  task_class_choice?: string; task_class_confidence?: number; execution_choice?: string; execution_confidence?: number;
  executor_model_choice?: string; executor_model_confidence?: number; execution_applied?: boolean; model_applied?: boolean;
  execution_override_reason?: string; latency_ms?: number; usage?: { input_tokens: number; output_tokens: number };
};
type Route = {
  route_id: string; task_id: string; task_title: string; status: string; channel: string; task_class: string;
  preferred_model: string; selected_model?: string; native_model?: string; reasoning_effort: string;
  created_at: string; completed_at?: string; reason: string; direct_reason?: string; fallback_reason?: string; fallback_from?: string;
  jev_decision?: Jev; result?: { outcome: string; error_code?: string; error_type?: string; http_status?: number; request_id?: string };
};
type Log = { total: number; routes: Route[]; next_cursor: string | null };
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

export function RoutingDecisions({ request }: { request: Request }) {
  const [log, setLog] = useState<Log>();
  const [before, setBefore] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await request<Log>(`/routing/decisions?limit=20${before ? `&before=${encodeURIComponent(before)}` : ""}`);
        if (!stopped) { setLog(next); setNotice(""); }
      } catch (error) { if (!stopped) setNotice(error instanceof Error ? error.message : "日志读取失败"); }
      finally { if (!stopped) { setBusy(false); if (!before) timer = setTimeout(() => void load(), 5000); } }
    };
    timer = setTimeout(() => { setBusy(true); void load(); }, 0);
    return () => { stopped = true; clearTimeout(timer); };
  }, [request, before, refresh]);
  const time = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
  const confidence = (value?: number) => typeof value === "number" ? `（置信度 ${value}）` : "";
  return <section className="console-card"><h2>Jev 判断与实际调度日志</h2>
    <p>逐条读取保留的真实路由记录，共 {log?.total ?? "—"} 条，每页 20 条。最新页每 5 秒刷新；历史页保留位置。Jev 判断和实际执行分别展示。</p>
    <p role="status">{busy ? "正在读取日志…" : notice}</p>
    <div className="console-toolbar"><button disabled={busy} onClick={() => { setBefore(""); setRefresh(value => value + 1); }}>返回最新并刷新</button><button disabled={busy || !log?.next_cursor} onClick={() => setBefore(log!.next_cursor!)}>更早记录</button></div>
    <div className="console-list">{log?.routes.map(route => {
      const jev = route.jev_decision;
      return <article className="console-card" key={route.route_id}><h3>{route.task_title}</h3>
        <p className="console-path">{route.route_id} · {route.task_id}</p><p>时间：{time(route.created_at)} · 状态：{route.result?.outcome || route.status}</p>
        <p>阶段：{jev?.phase_id || "历史记录未提供"}{jev?.phase_summary_excerpt ? ` · ${jev.phase_summary_excerpt}` : ""}</p>
        {jev ? <>
          <p>Jev：{jev.status || "未知"} · 判断模型：{jev.model || "未调用或未记录"}{jev.error ? ` · 错误：${jev.error}` : ""}</p>
          <p>候选：{jev.candidate_models ? jev.candidate_models.join("、") || "无可派发候选" : "未记录"}</p>
          <p>建议类别：{jev.task_class_choice || "未提供"}{confidence(jev.task_class_confidence)} · 执行：{jev.execution_choice || "未提供"}{confidence(jev.execution_confidence)} · 建议模型：{jev.executor_model_choice || "未提供"}{confidence(jev.executor_model_confidence)}</p>
          <p>建议应用：执行 {jev.execution_applied ? "是" : "否"} · 模型 {jev.model_applied ? "是" : "否"}{jev.execution_override_reason ? ` · 覆盖原因：${jev.execution_override_reason}` : ""}</p>
          <p>判断耗时：{jev.latency_ms == null ? "未记录" : `${jev.latency_ms} ms`} · Token：{jev.usage ? `输入 ${jev.usage.input_tokens} / 输出 ${jev.usage.output_tokens}` : "未记录"}</p>
        </> : <p>此历史路由没有 Jev 判断记录。</p>}
        <p>实际：{route.channel} · {route.task_class} · {route.selected_model || "未选中"} · {route.reasoning_effort}{route.native_model ? ` · runtime ${route.native_model}` : ""}</p>
        <p>调度原因：{route.reason}{route.direct_reason ? ` · 主模型执行理由：${route.direct_reason}` : ""}{route.fallback_reason ? ` · 降级：${route.fallback_from || "未知来源"} → ${route.fallback_reason}` : ""}</p>
        {route.result && <p>回执：{route.result.outcome}{route.result.error_type ? ` · ${route.result.error_type}` : ""}{route.result.error_code ? ` · ${route.result.error_code}` : ""}{route.result.http_status ? ` · HTTP ${route.result.http_status}` : ""}{route.result.request_id ? ` · request ${route.result.request_id}` : ""}{route.completed_at ? ` · ${time(route.completed_at)}` : ""}</p>}
      </article>;
    })}</div>{log && !log.routes.length && <p>暂无调度判断记录。</p>}
  </section>;
}
