import { execFileSync } from "node:child_process";
import { sameSubject } from "./completion-state.mjs";

const fields = ["source", "version", "preconditions", "steps", "actual", "expected", "acceptanceSteps", "testArtifact", "targetBranch"];
export function normalizeBug(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("Bug 资料必须是对象。", 400);
  const result = {};
  for (const field of fields) {
    if (typeof value[field] !== "string" || !value[field].trim() || value[field].length > 3000) throw failure(`Bug 资料缺少或超长：${field}`, 400);
    result[field] = value[field].trim();
  }
  return result;
}

export function bugClosure(task, ready = task.completionReadiness?.ready) {
  if (!task.bug) return null;
  const acceptance = task.acceptanceRecords?.at(-1);
  const accepted = acceptance?.outcome === "accepted" && task.bugAcceptanceId === acceptance.id && sameSubject(acceptance.subject_ref, task.currentSubject);
  const merge = task.bugMerge;
  const verificationIds = merge && mergeVerifications(task, merge.targetCommit)?.map(item => item.id);
  const complete = ready && accepted && merge?.acceptanceId === acceptance.id
    && merge.targetBranch === task.bug.targetBranch && sameSubject(merge.subject, task.currentSubject)
    && verificationIds && JSON.stringify(verificationIds) === JSON.stringify(merge.verificationIds);
  return { status: task.status === "cancelled" ? "cancelled" : complete ? "completed" : accepted && ready ? "awaiting_merge" : acceptance?.outcome === "rejected" ? "returned" : ready ? "awaiting_acceptance" : "repairing", merge: merge || null };
}

export function verifyBugMerge(task) {
  if (bugClosure(task)?.status !== "awaiting_merge") throw failure("需要当前修订的验证、审查与验收全部通过，才可核验合入。");
  const subject = task.currentSubject;
  if (subject?.type !== "git_commit" || !/^[a-f0-9]{40,64}$/.test(subject.value || "") || !subject.repository) throw failure("合入核验要求带仓库路径的完整 git_commit Subject。");
  const git = (...args) => execFileSync("git", ["-C", subject.repository, ...args], { encoding: "utf8", timeout: 3000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] }).trim();
  let head;
  try {
    git("check-ref-format", `refs/heads/${task.bug.targetBranch}`);
    head = git("rev-parse", "--verify", `refs/heads/${task.bug.targetBranch}^{commit}`);
    git("merge-base", "--is-ancestor", subject.value, head);
  } catch { throw failure("目标本地分支不存在、无法读取，或尚未包含修复提交；未执行任何合并。"); }
  const verifications = mergeVerifications(task, head);
  if (!verifications) throw failure("目标提交的必需验证未全部通过，或缺少测试、构建、设备验证回执；请先上报合入后验证。");
  return { subject, targetBranch: task.bug.targetBranch, targetCommit: head, acceptanceId: task.acceptanceRecords.at(-1).id, verificationIds: verifications.map(item => item.id), checkedAt: new Date().toISOString() };
}

function mergeVerifications(task, head) {
  const claims = (task.verificationClaims || []).filter(item => item.subject_ref?.type === "git_commit"
    && item.subject_ref.value === head && item.subject_ref.repository === task.currentSubject?.repository);
  const latest = [...new Map(claims.map(item => [item.requirement_id || item.kind, item])).values()];
  const runnable = latest.filter(item => ["test", "build", "device"].includes(item.kind));
  const required = (task.verificationPlan || []).filter(item => item.required).map(requirement =>
    claims.filter(item => item.requirement_id === requirement.id || (!item.requirement_id && item.kind === requirement.kind)).at(-1));
  const selected = [...new Set([...required, ...runnable])];
  return runnable.length && selected.every(item => item?.status === "passed" && (item.command_or_probe || item.evidence_ref)) ? selected : null;
}

function failure(message, statusCode = 409) { return Object.assign(new Error(message), { statusCode }); }
