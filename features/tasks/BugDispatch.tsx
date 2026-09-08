"use client";

import { useEffect, useState } from "react";

type Dispatch = { id: string; status: string; clientThreadId?: string; baselineCommit: string; threadId?: string; executionWorkspace?: string; updatedAt: string; wake: { status: string; message?: string }; receipts: { eventId: string; evidence: string; observedAt: string }[]; commands: { eventId: string; action: string; status: string; evidence?: string }[] };
const labels: Record<string, string> = { queued: "排队中", claimed: "宿主正在派发", creating: "宿主工作树准备中", running: "宿主已核实运行", blocked: "执行阻塞", unknown: "宿主结果待核实", awaiting_acceptance: "待验收", done_claimed: "执行声明完成", cancelled: "已撤回排队" };

export function BugDispatch({ taskId }: { taskId: string }) {
  const [state, setState] = useState<{ records: Dispatch[]; occupied: number }>();
  const [dispatcher, setDispatcher] = useState("");
  const [resources, setResources] = useState("");
  const [baseline, setBaseline] = useState("");
  const [supplement, setSupplement] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const load = () => fetch(`/api/control/tasks/${encodeURIComponent(taskId)}/bug-dispatch`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("派发状态不可用");
      setState(await response.json());
    }).catch(error => { if (error.name !== "AbortError") setNotice(error.message); });
    void load(); const timer = window.setInterval(load, 5000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [taskId, tick]);
  async function act(action?: string) {
    setBusy(true); setNotice("");
    try {
      const body = action ? { action, message: action === "supplement" ? supplement : "", eventId: crypto.randomUUID() } : { ...(dispatcher.trim() ? { dispatcherSessionId: dispatcher.trim() } : {}), baselineCommit: baseline.trim(), resources: resources.split(",").map(v => v.trim()).filter(Boolean) };
      const response = await fetch(`/api/control/tasks/${encodeURIComponent(taskId)}/bug-dispatch${action ? "/control" : ""}`, { method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Action": "delegate" }, body: JSON.stringify(body) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "请求失败");
      setState(value); setTick(v => v + 1); setNotice(action === "cancel" && value.records[0]?.status === "cancelled" ? "排队已撤回，不会派发。" : "请求已记录；实际结果以宿主回执为准。");
    } catch (error) { setNotice(error instanceof Error ? error.message : "请求失败"); }
    finally { setBusy(false); }
  }
  const record = state?.records[0];
  const ended = record?.status === "cancelled";
  return <section aria-label="独立 Bug 会话派发">
    <h3>独立修复会话</h3><p>并发占用：{state?.occupied ?? "未知"} / 2。资源冲突排队，宿主核实后关联所属项目的独立工作树。</p>
    {!record ? <><label>派发主脑会话 ID（留空沿用当前任务会话）<input value={dispatcher} onChange={e => setDispatcher(e.target.value)} /></label><label>授权使用的业务基线（完整 commit）<input value={baseline} onChange={e => setBaseline(e.target.value)} /></label><label>独占资源（逗号分隔，如 device:serial）<input value={resources} onChange={e => setResources(e.target.value)} /></label><button disabled={busy || !state || !/^[a-f0-9]{40,64}$/i.test(baseline.trim())} onClick={() => void act()}>加入独立修复队列</button></> : <>
      <p role="status">{labels[record.status] || record.status} · {record.updatedAt}</p>
      <p>授权基线：{record.baselineCommit}</p>{record.clientThreadId && !record.threadId && <p>宿主创建回执：{record.clientThreadId}（尚非真实会话 ID，不会重复创建）</p>}
      <p>{record.wake.status === "unavailable" ? "宿主事件入口不可用：" : "事件通知："}{record.wake.message || "等待发送"}</p>
      {record.threadId ? <><p>真实会话：{record.threadId}<br />工作树：{record.executionWorkspace}</p><button disabled={busy} onClick={() => void act("open")}>请求在 Codex 打开</button></> : <p>尚无经宿主核实的可见会话。</p>}
      <label>补充要求<textarea value={supplement} maxLength={3000} onChange={e => setSupplement(e.target.value)} /></label>
      <button disabled={busy || ended || !supplement.trim()} onClick={() => void act("supplement")}>发送补充要求</button>{" "}
      <button disabled title="当前宿主没有已核实的暂停通道">暂停不可用</button>{" "}<button disabled title="当前宿主没有已核实的继续通道">继续不可用</button>{" "}
      <button disabled={busy || ended} onClick={() => void act("cancel")}>{record.status === "queued" ? "撤回排队" : "请求取消执行"}</button>
      <p>运行中取消只发送请求，不能证明执行已停止。待核实或阻塞任务保留并发名额，避免重复执行。</p>
      {record.commands.map(c => <p key={c.eventId}>{({ cancel: "取消请求", supplement: "补充要求", open: "打开会话" } as Record<string, string>)[c.action]}：{({ requested: "等待宿主处理", confirmed: "排队已撤回", sent: "宿主已发送", unavailable: "宿主不可用" } as Record<string, string>)[c.status]}{c.evidence ? ` · ${c.evidence}` : ""}</p>)}
      <h4>宿主证据</h4>{record.receipts.length ? record.receipts.map(r => <p key={r.eventId}>{r.observedAt} · {r.evidence}</p>) : <p>尚无回执。派发通知不代表实现或验收完成。</p>}
    </>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
