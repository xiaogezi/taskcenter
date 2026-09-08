"use client";

import { useState } from "react";
import { BugDispatch } from "./BugDispatch";

const fields = { source: "反馈来源 / 原文", version: "受影响版本", preconditions: "前置条件", steps: "复现步骤", actual: "实际行为", expected: "预期行为与依据", acceptanceSteps: "验收步骤", testArtifact: "测试包或运行入口", targetBranch: "目标本地分支" };
const statuses: Record<string, string> = { repairing: "修复与验证中", returned: "验收退回", awaiting_acceptance: "待你验收", awaiting_merge: "待合入", completed: "已核验合入", cancelled: "已取消" };
type BugTask = { id: string; sessionId?: unknown; updatedAt?: string; bug?: Record<string, string>; currentSubject?: unknown; bugClosure?: { status: string; merge?: { targetCommit?: string; checkedAt?: string } }; completionReadiness?: { ready?: boolean }; };

export function BugDetails({ task, onChanged }: { task: BugTask; onChanged: () => void }) {
  const [draft, setDraft] = useState(task.bug || {});
  const [editing, setEditing] = useState(!task.bug);
  const [reason, setReason] = useState("");
  const [confirmedVersion, setConfirmedVersion] = useState<string>();
  const confirmed = Boolean(confirmedVersion && confirmedVersion === task.updatedAt);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function act(path: string, body: object) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/control/tasks/${encodeURIComponent(task.id)}/${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Action": "delegate" }, body: JSON.stringify({ ...body, expectedUpdatedAt: task.updatedAt }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "操作失败");
      setEditing(false); setConfirmedVersion(undefined); setMessage("已保存，任务记录已更新。"); onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(false); }
  }
  return <section className="detail-content bug-details">
    <h3>Bug 修复闭环</h3>
    <p>{task.bug ? statuses[task.bugClosure?.status || "repairing"] : "核实缺陷后，将当前任务登记为 Bug。已有任务、会话与证据继续沿用。"}</p>
    <p>修复 → 验证与审查 → 你的验收 → 合入核验</p>
    {editing ? <form onSubmit={event => { event.preventDefault(); void act("bug", { bug: draft }); }}>
      {Object.entries(fields).map(([key, label]) => <label key={key}>{label}<textarea required maxLength={3000} value={draft[key] || ""} onChange={event => setDraft({ ...draft, [key]: event.target.value })} /></label>)}
      <button disabled={busy} type="submit">保存 Bug 资料</button>
    </form> : <><dl>{Object.entries(fields).map(([key, label]) => <div key={key}><dt>{label}</dt><dd style={{ whiteSpace: "pre-wrap" }}>{task.bug?.[key]}</dd></div>)}</dl><button disabled={busy} onClick={() => { setDraft(task.bug || {}); setEditing(true); }}>编辑资料</button><p>修改资料会使已有验收与合入确认失效。</p></>}
    {task.bug && !editing && <>
      <BugDispatch taskId={task.id} />
      <h3>人工验收</h3><p>请按上面的步骤检查测试版本。通过后进入待合入；退回后继续由原任务处理。</p>
      <label>验收结果说明<textarea value={reason} maxLength={1000} onChange={event => setReason(event.target.value)} /></label>
      <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmedVersion(event.target.checked ? task.updatedAt : undefined)} />我已核对当前修订和验收步骤（任务变化后需重新确认）</label>
      <button disabled={busy || !confirmed || !reason.trim() || !task.completionReadiness?.ready} onClick={() => void act("bug-acceptance", { outcome: "accepted", reason, confirm: true, subject: task.currentSubject })}>验收通过</button>{" "}
      <button disabled={busy || !confirmed || !reason.trim()} onClick={() => void act("bug-acceptance", { outcome: "rejected", reason, confirm: true, subject: task.currentSubject })}>退回修复</button>
      {!task.completionReadiness?.ready && <p>验证或审查未就绪时，不能通过验收。具体缺项见证据页。</p>}
      <h3>合入核验</h3><p>目标分支：{task.bug.targetBranch}。先由项目会话合入并上报绑定目标提交的验证，再核验修复提交是否被包含。此按钮不执行 Git 合并。</p>
      <button disabled={busy || task.bugClosure?.status !== "awaiting_merge"} onClick={() => void act("bug-merge", {})}>核验合入结果</button>
      {task.bugClosure?.merge && <p>记录提交：{task.bugClosure.merge.targetCommit}<br />核验时间：{task.bugClosure.merge.checkedAt}</p>}
      {typeof task.sessionId === "string" && <p><a href={`/sessions?session=${encodeURIComponent(task.sessionId)}`}>查看关联会话</a></p>}
    </>}
    {message && <p role="status">{message}</p>}
  </section>;
}
