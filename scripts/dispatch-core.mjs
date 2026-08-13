import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function loadDispatchTarget(dashboardPath, requirementId, threadId) {
  if (!uuidPattern.test(threadId || "")) {
    throw new DispatchError(400, "会话 ID 格式无效。");
  }
  const dashboard = JSON.parse(readFileSync(dashboardPath, "utf8"));
  const requirement = dashboard.requirements.find((item) => item.id === requirementId);
  if (!requirement) {
    throw new DispatchError(404, "需求不存在或已经被重新整理。");
  }
  if (!['partial', 'in_progress'].includes(requirement.status)) {
    throw new DispatchError(409, "只有“部分完成”或“进行中”的正式需求可以转发到来源 Session。");
  }
  const source = (requirement.sources || []).find((item) => item.threadId === threadId);
  if (!source) {
    throw new DispatchError(400, "目标会话不是这条需求的证据来源。");
  }
  const thread = dashboard.threads.find((item) => item.id === threadId);
  if (!thread) {
    throw new DispatchError(404, "目标 Codex 会话不在当前同步范围内。");
  }
  const cwd = resolveDispatchCwd(dashboardPath, requirement, thread);
  return {
    requirement,
    thread,
    cwd,
    prompt: buildDispatchPrompt(requirement, cwd),
  };
}

export function buildDispatchPrompt(requirement, cwd = "") {
  const evidence = (requirement.evidence || []).slice(0, 6);
  const lines = [
    "【TaskCenter 继续需求】",
    `稳定需求 ID：${bounded(requirement.id, 200)}`,
    `调用 taskcenter_task_create 时 requirement_id 必须设置为 ${bounded(requirement.id, 200)}`,
    `需求：${bounded(requirement.title, 160)}`,
    `当前状态：${requirement.status === "in_progress" ? "进行中" : "部分完成"}`,
    `已完成概况：${bounded(requirement.summary, 500)}`,
    `剩余缺口：${bounded(requirement.gap, 500)}`,
    evidence.length ? `现有证据：${evidence.map((item) => bounded(String(item), 180)).join("；")}` : "",
    cwd ? `已解析工作目录：${bounded(cwd, 300)}` : "",
    "",
    "请基于以上上下文和工作区继续完成这条需求。先核对现状和证据，不要重复、回滚或重启已经完成的工作；从下一安全节点实施剩余缺口。",
    "【TaskCenter 强制任务闸门】开始任何代码、配置或文档修改前，必须先调用 taskcenter_session_register，再调用 taskcenter_task_create；返回 accepted=true 和 task_id 后才能实施。",
    "每个阶段调用 taskcenter_task_update，遇到阻塞上报 blocked，完成后调用 taskcenter_task_report。报告必须包含计划理由、关键假设、风险、取舍、待确认问题、变更文件、测试和复盘；不要提交隐藏思维链。",
    "如果 TaskCenter MCP 不可用，不开始实施，只做只读检查并输出 TASKCENTER_UNAVAILABLE。",
    "完成标准：给出实际代码或配置修改，运行必要测试，并明确区分“实现声明”和“已验证结果”。未经当前任务明确授权，不执行 git add、commit 或 push。",
  ];
  return lines.filter(Boolean).join("\n").slice(0, 3_500);
}

export function resolveDispatchCwd(dashboardPath, requirement, thread) {
  const dashboardProject = dirname(dirname(resolve(dashboardPath)));
  const projectsRoot = dirname(dashboardProject);
  for (const item of requirement.evidence || []) {
    const evidence = typeof item === "string" ? item : item?.label ?? item?.text ?? "";
    const projectName = String(evidence).split("/")[0];
    if (!/^[A-Za-z0-9._-]+$/.test(projectName) || [".", ".."].includes(projectName)) continue;
    const candidate = join(projectsRoot, projectName);
    if (isGitRoot(candidate)) return candidate;
  }
  const threadGitRoot = findGitRoot(thread.cwd);
  if (threadGitRoot) return threadGitRoot;
  if (isGitRoot(dashboardProject)) return dashboardProject;
  throw new DispatchError(
    409,
    "无法从需求证据解析可信 Git 项目目录，请先修正需求证据路径。",
  );
}

function findGitRoot(candidate) {
  if (!candidate || !existsSync(candidate)) return "";
  let current = resolve(candidate);
  while (true) {
    if (isGitRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return "";
    current = parent;
  }
}

function isGitRoot(candidate) {
  return existsSync(candidate) && existsSync(join(candidate, ".git"));
}

function bounded(value, limit) {
  const text = String(value || "未记录").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export class DispatchError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}
