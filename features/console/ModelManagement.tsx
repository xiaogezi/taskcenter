"use client";

import { useEffect, useRef, useState } from "react";

type Model = { id: string; description: string; runtime_model: string; reasoning_efforts: string[]; executor_reasoning_effort: string };
type Config = { content_hash: string; executor_model: string; fallback_models: string[]; reviewer_model: string; models: Model[] };
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
const efforts = ["low", "medium", "high"];
const blank: Model = { id: "", description: "", runtime_model: "", reasoning_efforts: ["low"], executor_reasoning_effort: "" };

export function ModelManagement({ request, onSaved }: { request: Request; onSaved: () => void }) {
  const [saved, setSaved] = useState<Config>();
  const [draft, setDraft] = useState<Config>();
  const [editor, setEditor] = useState<Model>();
  const [originalId, setOriginalId] = useState("");
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
  const load = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try { const config = await request<Config>("/routing/models"); setSaved(config); setDraft(config); setEditor(undefined); setNotice("已读取集中配置"); }
    catch (error) { setNotice(error instanceof Error ? error.message : "读取失败"); }
    finally { inFlight.current = false; setBusy(false); }
  };
  useEffect(() => {
    let stopped = false;
    inFlight.current = true;
    void request<Config>("/routing/models").then(config => { if (!stopped) { setSaved(config); setDraft(config); } }).catch(error => { if (!stopped) setNotice(error instanceof Error ? error.message : "读取失败"); }).finally(() => { if (!stopped) { inFlight.current = false; setBusy(false); } });
    return () => { stopped = true; };
  }, [request]);
  const save = async () => {
    if (!draft || inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try {
      const config = await request<Config>("/routing/models", { method: "POST", headers: { "content-type": "application/json", "x-taskcenter-action": "delegate" }, body: JSON.stringify(draft) });
      setSaved(config); setDraft(config); setNotice("模型配置已保存，下次派发生效"); onSaved();
    } catch (error) { setNotice(error instanceof Error ? error.message : "保存失败"); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const toggle = (id: string, enabled: boolean) => {
    if (!draft) return;
    const pool = [draft.executor_model, ...draft.fallback_models];
    const next = enabled ? [...pool, id] : pool.filter(model => model !== id);
    if (!next.length) { setNotice("至少保留一个执行模型，或先启用其他模型"); return; }
    setDraft({ ...draft, executor_model: next[0], fallback_models: next.slice(1) });
  };
  const move = (index: number, offset: number) => {
    if (!draft) return;
    const next = [...draft.fallback_models];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    setDraft({ ...draft, fallback_models: next });
  };
  const applyEditor = () => {
    if (!draft || !editor) return;
    if (!editor.id.trim() || (!originalId && draft.models.some(model => model.id === editor.id))) { setNotice("请填写不重复的模型 ID"); return; }
    setDraft({ ...draft, models: originalId ? draft.models.map(model => model.id === originalId ? editor : model) : [...draft.models, editor] });
    setEditor(undefined); setNotice("编辑已应用，请保存模型配置");
  };
  const remove = (id: string) => {
    if (!draft || !saved) return;
    if ([saved.executor_model, ...saved.fallback_models, saved.reviewer_model, draft.executor_model, ...draft.fallback_models].includes(id)) { setNotice("模型仍被角色引用，请先停用并保存；Reviewer 引用需在集中配置调整"); return; }
    if (window.confirm(`删除模型 ${id} 的目录和原生映射？`)) setDraft({ ...draft, models: draft.models.filter(model => model.id !== id) });
  };
  const pool = draft ? [draft.executor_model, ...draft.fallback_models] : [];
  return <section className="console-card"><h2>模型管理</h2>
    <p>启停控制自动执行候选池。停用首选时按回退顺序提升下一模型，正在执行的任务不变。实际可用性仍以派发工具和额度为准。</p>
    <p role="status">{busy ? "正在处理…" : notice || "编辑后统一保存"}{dirty && " · 有未保存更改"}</p>
    <div className="console-toolbar">
      <button disabled={busy || !draft || Boolean(editor)} onClick={() => { setOriginalId(""); setEditor({ ...blank }); }}>新增模型</button>
      <button disabled={busy || !dirty || Boolean(editor)} onClick={() => void save()}>保存模型配置</button>
      <button disabled={busy} onClick={() => { if ((!dirty && !editor) || window.confirm("重新读取会丢弃未保存更改，是否继续？")) void load(); }}>重新读取</button>
    </div>
    {draft && <>
      <label>首选执行模型 <select disabled={busy || Boolean(editor)} value={draft.executor_model} onChange={event => setDraft({ ...draft, executor_model: event.target.value, fallback_models: pool.filter(id => id !== event.target.value) })}>{pool.map(id => <option key={id}>{id}</option>)}</select></label>
      <h3>回退顺序</h3><ol>{draft.fallback_models.map((id, index) => <li key={id}>{id} <button aria-label={`上移 ${id}`} disabled={busy || Boolean(editor) || index === 0} onClick={() => move(index, -1)}>上移</button> <button aria-label={`下移 ${id}`} disabled={busy || Boolean(editor) || index === draft.fallback_models.length - 1} onClick={() => move(index, 1)}>下移</button></li>)}</ol>
      <div className="console-list">{draft.models.map(model => <article className="console-card" key={model.id}>
        <h3>{model.id}</h3><p>{model.description}</p><p className="console-path">原生模型：{model.runtime_model || "未配置"}</p><p>支持档位：{model.reasoning_efforts.join(" / ") || "无"} · 执行档位：{model.executor_reasoning_effort || "沿用角色/任务策略"}{model.id === draft.reviewer_model && " · Reviewer 引用"}</p>
        <label className="console-check"><input type="checkbox" checked={pool.includes(model.id)} disabled={busy || Boolean(editor) || !model.runtime_model} onChange={event => toggle(model.id, event.target.checked)} />自动执行候选</label>
        <button disabled={busy || Boolean(editor)} onClick={() => { setOriginalId(model.id); setEditor({ ...model }); }}>编辑 {model.id}</button> <button disabled={busy || Boolean(editor)} onClick={() => remove(model.id)}>删除 {model.id}</button>
      </article>)}</div>
    </>}
    {editor && <form className="console-card" onSubmit={event => { event.preventDefault(); applyEditor(); }}><h3>{originalId ? "编辑模型" : "新增模型"}</h3>
      <p><label>模型 ID <input required maxLength={120} disabled={Boolean(originalId)} value={editor.id} onChange={event => setEditor({ ...editor, id: event.target.value })} /></label></p>
      <p><small>已有 ID 固定；更换 ID 请停用、保存、删除后新增。</small></p>
      <p><label>能力与成本描述 <input required maxLength={300} value={editor.description} onChange={event => setEditor({ ...editor, description: event.target.value })} /></label></p>
      <p><label>原生 runtime model ID <input required maxLength={120} value={editor.runtime_model} onChange={event => setEditor({ ...editor, runtime_model: event.target.value })} /></label></p>
      <fieldset><legend>原生支持的推理档位</legend>{efforts.map(effort => <label className="console-check" key={effort}><input type="checkbox" checked={editor.reasoning_efforts.includes(effort)} onChange={event => setEditor({ ...editor, reasoning_efforts: event.target.checked ? [...editor.reasoning_efforts, effort] : editor.reasoning_efforts.filter(value => value !== effort) })} />{effort}</label>)}</fieldset>
      <p><label>执行推理档位 <select value={editor.executor_reasoning_effort} onChange={event => setEditor({ ...editor, executor_reasoning_effort: event.target.value })}><option value="">沿用角色/任务策略</option>{efforts.map(effort => <option key={effort}>{effort}</option>)}</select></label></p>
      <p><small>停用时保留执行档位；选择 high 表示允许该模型以 high 执行。模型映射必须填写真实工具支持值。</small></p>
      <button type="submit">应用编辑</button> <button type="button" onClick={() => setEditor(undefined)}>取消编辑</button>
    </form>}
  </section>;
}
