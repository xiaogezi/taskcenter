"use client";

import { useEffect, useRef, useState } from "react";

type Model = { id: string; description: string; runtime_model: string; reasoning_efforts: string[]; executor_reasoning_effort: string; display_name?: string };
type Config = { content_hash: string; executor_model: string; fallback_models: string[]; reviewer_model: string; manual_only_models: string[]; retired_models: string[]; models: Model[] };
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

export function ModelManagement({ request, onSaved }: { request: Request; onSaved: () => void }) {
  const [saved, setSaved] = useState<Config>();
  const [draft, setDraft] = useState<Config>();
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const inFlight = useRef(false);
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
  const load = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try {
      const config = await request<Config>("/routing/models");
      setSaved(config); setDraft(config); setNotice("已读取集中配置派发名单");
    } catch (error) { setNotice(error instanceof Error ? error.message : "读取失败"); }
    finally { inFlight.current = false; setBusy(false); }
  };
  useEffect(() => {
    let stopped = false;
    inFlight.current = true;
    void request<Config>("/routing/models").then(config => {
      if (!stopped) { setSaved(config); setDraft(config); }
    }).catch(error => { if (!stopped) setNotice(error instanceof Error ? error.message : "读取失败"); }).finally(() => { if (!stopped) { inFlight.current = false; setBusy(false); } });
    return () => { stopped = true; };
  }, [request]);
  const save = async () => {
    if (!draft || inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try {
      const config = await request<Config>("/routing/models", { method: "POST", headers: { "content-type": "application/json", "x-taskcenter-action": "delegate" }, body: JSON.stringify(draft) });
      setSaved(config); setDraft(config); setNotice("派发名单已保存，下次派发生效"); onSaved();
    } catch (error) { setNotice(error instanceof Error ? error.message : "保存失败"); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const pool = draft ? [draft.executor_model, ...draft.fallback_models].filter(Boolean) : [];
  const rows = draft?.models || [];
  const toggle = (model: Model, enabled: boolean) => {
    if (!draft) return;
    const next = enabled ? [...pool, model.id] : pool.filter(id => id !== model.id);
    let models = draft.models;
    if (enabled) models = models.some(entry => entry.id === model.id) ? models.map(entry => entry.id === model.id ? model : entry) : [...models, model];
    else if (!saved?.models.some(entry => entry.id === model.id)) models = models.filter(entry => entry.id !== model.id);
    setDraft({ ...draft, models, executor_model: next[0] || "", fallback_models: next.slice(1) });
  };
  const move = (index: number, offset: number) => {
    if (!draft) return;
    const next = [...pool]; [next[index], next[index + offset]] = [next[index + offset], next[index]];
    setDraft({ ...draft, executor_model: next[0], fallback_models: next.slice(1) });
  };
  return <section className="console-card"><h2>配置模型与派发名单</h2>
    <p>从集中配置的模型中勾选加入派发名单。名单外模型不派发，空名单由当前主模型继续；运行中的任务保持原模型。实际派发仍校验工具能力、档位和额度。</p>
    <p role="status">{busy ? "正在读取或保存…" : notice || "勾选后保存名单"}{dirty && " · 有未保存更改"}</p>
    <div className="console-toolbar">
      <button disabled={busy || !dirty} onClick={() => void save()}>保存派发名单</button>
      <button disabled={busy} onClick={() => { if (!dirty || window.confirm("重新读取会丢弃未保存更改，是否继续？")) void load(); }}>重新读取名单</button>
      <label>搜索模型 <input value={search} onChange={event => setSearch(event.target.value)} placeholder="名称或模型 ID" /></label>
    </div>
    <h3>派发名单（{pool.length}）</h3><p>首项为默认偏好，其余为回退；Jev 按任务从名单中判断。只支持 high 的模型，保存即确认以 high 派发。</p>
    {!pool.length && <p>派发已关闭，当前主模型继续执行。</p>}
    <ol>{pool.map((id, index) => <li key={id}>{id} {index === 0 && "（首选）"} <button aria-label={`上移 ${id}`} disabled={busy || index === 0} onClick={() => move(index, -1)}>上移</button> <button aria-label={`下移 ${id}`} disabled={busy || index === pool.length - 1} onClick={() => move(index, 1)}>下移</button> <button disabled={busy} onClick={() => toggle(draft!.models.find(model => model.id === id)!, false)}>移出名单</button></li>)}</ol>
    <h3>配置模型</h3>
    <div className="console-list">{rows.filter(model => `${model.id} ${model.display_name || ""}`.toLowerCase().includes(search.toLowerCase())).map(model => {
      const manual = draft?.manual_only_models.includes(model.id);
      const retired = draft?.retired_models.includes(model.id);
      return <article className="console-card" key={model.id}><h4>{model.display_name || model.id}</h4><p className="console-path">{model.id}</p><p>{model.description}</p>
        <label className="console-check"><input type="checkbox" checked={pool.includes(model.id)} disabled={busy || Boolean(manual) || (!pool.includes(model.id) && !model.reasoning_efforts.length)} onChange={event => toggle(model, event.target.checked)} />加入派发名单</label>
        <p>集中配置记录；实际派发时校验原生工具能力{manual && " · 仅手动策略，不参与普通派发"}{retired && " · 勾选保存将恢复此模型的派发资格"}</p>
        <p>支持档位：{model.reasoning_efforts.join(" / ") || "无可用档位"}</p>
        {pool.includes(model.id) && <label>派发档位 <select disabled={busy} value={draft!.models.find(entry => entry.id === model.id)?.executor_reasoning_effort || ""} onChange={event => setDraft({ ...draft!, models: draft!.models.map(entry => entry.id === model.id ? { ...entry, executor_reasoning_effort: event.target.value } : entry) })}>
          {model.reasoning_efforts.includes("low") && <option value="">沿用角色/任务策略</option>}{model.reasoning_efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
        </select></label>}
      </article>;
    })}</div>
  </section>;
}
