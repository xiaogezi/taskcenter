import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const terminal = new Set(["cancelled"]);
const occupied = new Set(["claimed", "creating", "running", "blocked", "unknown"]);
export class BugDispatchError extends Error { constructor(message, statusCode = 409) { super(message); this.statusCode = statusCode; } }
const requireValue = (condition, message) => { if (!condition) throw new BugDispatchError(message); };

export function repositoryIdentity(workspace) {
  requireValue(typeof workspace === "string" && isAbsolute(workspace), "缺少绝对路径工作区。");
  try {
    const git = flag => realpathSync(execFileSync("git", ["-C", workspace, "rev-parse", "--path-format=absolute", flag], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] }).trim());
    requireValue(git("--show-toplevel") === realpathSync(workspace), "必须使用 Git 工作树根目录。");
    return git("--git-common-dir");
  }
  catch { throw new BugDispatchError("工作区不是可读取的 Git 仓库。"); }
}

function resolveBaseline(workspace, revision) {
  requireValue(typeof revision === "string" && /^[a-f0-9]{40,64}$/i.test(revision), "请明确提供已授权的完整业务基线 commit，不从目标分支猜测。");
  try { return execFileSync("git", ["-C", workspace, "rev-parse", "--verify", `${revision}^{commit}`], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { throw new BugDispatchError("已授权业务基线 commit 在所属仓库中不可读取。"); }
}
const worktreeHead = workspace => execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] }).trim();

// 单个本地控制进程同步落盘；不自动释放不确定的宿主 claim，防止崩溃后重复创建会话。
export class BugDispatchQueue {
  constructor(path, { task, session, repository = repositoryIdentity, baseline = resolveBaseline, head = worktreeHead }) { Object.assign(this, { path, task, session, repository, baseline, head }); }
  read() { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : { records: [] }; }
  change(fn) {
    const state = this.read();
    const result = fn(state);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
    return structuredClone(result);
  }
  snapshot(taskId) {
    const records = this.read().records;
    return { limit: 2, occupied: records.filter(r => occupied.has(r.status)).length,
      capabilities: { dispatch: "event_dispatcher_required", pause: false, resume: false, cancelRunning: "request_only", merge: "external_serial_lease" },
      records: records.filter(r => !taskId || r.taskId === taskId).map(record => {
        const r = structuredClone(record); delete r.claimToken;
        for (const receipt of r.receipts) delete receipt.signature;
        return r;
      }) };
  }
  enqueue(taskId, { dispatcherSessionId, resources = [], baselineCommit } = {}) {
    const task = this.task(taskId);
    requireValue(task?.bug && !["removed", "cancelled", "verified"].includes(task.status), "需要可修复的 Bug 任务。");
    const dispatcher = dispatcherSessionId || task.sessionId;
    requireValue(uuid.test(dispatcher || "") && this.session(dispatcher), "请提供已登记的真实主脑会话 ID。");
    requireValue(Array.isArray(resources) && resources.length <= 20 && resources.every(r => typeof r === "string" && /^[\w.:/-]{1,200}$/.test(r)), "资源键格式无效。");
    const repository = this.repository(task.workspace);
    return this.change(state => {
      const previous = state.records.find(r => r.taskId === taskId);
      if (previous) return { record: previous, idempotent: true };
      const now = new Date().toISOString();
      const record = { id: randomUUID(), taskId, title: task.title, workspace: task.workspace, repository, baselineCommit: this.baseline(task.workspace, baselineCommit), targetBranch: task.bug.targetBranch,
        bug: task.bug, dispatcherSessionId: dispatcher, resources: [...new Set(resources)], status: "queued", createdAt: now, updatedAt: now, commands: [], receipts: [], wake: { status: "pending" } };
      state.records.push(record);
      return { record, idempotent: false };
    });
  }
  wakeResult(id, error) {
    return this.change(state => {
      const r = state.records.find(r => r.id === id);
      requireValue(r, "派发不存在。");
      r.wake = { status: error ? "unavailable" : "sent", message: error ? String(error).slice(0, 500) : "唤醒事件已送达；尚不代表宿主已执行。", observedAt: new Date().toISOString() };
      return r.wake;
    });
  }
  claim(sessionId, id) {
    requireValue(uuid.test(sessionId || "") && this.session(sessionId), "领取者 Session 未登记。");
    return this.change(state => {
      const owned = state.records.find(r => r.id === id && r.claimant === sessionId && ["claimed", "creating", "unknown"].includes(r.status));
      if (owned) return { record: owned, resumed: true, warning: "已有 claim；先核实先前创建结果，不得重新创建。" };
      if (state.records.filter(r => occupied.has(r.status)).length >= 2) return { record: null, reason: "两路执行名额已占用。" };
      const r = state.records.find(r => (!id || r.id === id) && r.status === "queued" && !state.records.some(other => occupied.has(other.status) && other.resources.some(key => r.resources.includes(key))));
      if (!r) return { record: null, reason: "没有可领取项，或资源冲突。" };
      const task = this.task(r.taskId);
      requireValue(task?.bug && !["removed", "cancelled", "verified"].includes(task.status) && this.repository(task.workspace) === r.repository, "Bug 已取消或所属仓库已变化，不得派发。");
      r.bug = task.bug; r.targetBranch = task.bug.targetBranch;
      r.status = "claimed"; r.claimant = sessionId; r.claimToken = randomUUID(); r.updatedAt = new Date().toISOString();
      return { record: r, resumed: false };
    });
  }
  receipt(sessionId, input) {
    requireValue(typeof input.eventId === "string" && /^[\w.-]{1,160}$/.test(input.eventId), "回执必须有稳定 eventId。");
    requireValue(typeof input.evidence === "string" && input.evidence.trim() && input.evidence.length <= 2000, "回执必须引用真实宿主操作和核实证据。");
    return this.change(state => {
      const r = state.records.find(r => r.id === input.id);
      requireValue(r, "派发不存在。");
      requireValue(sessionId === r.claimant || sessionId === r.threadId, "回执不属于派发者或执行会话。");
      const signature = JSON.stringify(input);
      const prior = r.receipts.find(e => e.eventId === input.eventId);
      if (prior) { requireValue(prior.signature === signature, "同一 eventId 的回执内容不一致。"); return { record: r, idempotent: true }; }
      requireValue(!terminal.has(r.status), "终态派发不能接受新执行结果。");
      if (input.status === "creating") {
        requireValue(!r.threadId && sessionId === r.claimant && input.claimToken === r.claimToken, "排队创建回执必须属于原 claim，不能覆盖真实会话。");
        requireValue(typeof input.clientThreadId === "string" && input.clientThreadId.trim() && input.clientThreadId.length <= 200 && (!r.clientThreadId || r.clientThreadId === input.clientThreadId), "缺少或冲突的宿主 clientThreadId。");
        r.clientThreadId = input.clientThreadId;
      }
      if (occupied.has(input.status) && !occupied.has(r.status)) {
        requireValue(state.records.filter(other => occupied.has(other.status)).length < 2 && !state.records.some(other => other.id !== r.id && occupied.has(other.status) && (other.executionWorkspace === r.executionWorkspace || other.resources.some(key => r.resources.includes(key)))), "恢复执行需等待并发名额和资源释放。");
      }
      if (input.status === "running" && !r.threadId) {
        requireValue(sessionId === r.claimant && input.claimToken === r.claimToken, "派发 claim 无效。");
        const child = this.session(input.threadId);
        requireValue(uuid.test(input.threadId || "") && child && input.threadId !== r.claimant && input.threadId !== this.task(r.taskId)?.sessionId, "必须使用独立、已登记的真实执行会话。");
        requireValue(input.visible === true && typeof input.projectId === "string" && input.projectId.trim(), "缺少桌面 read_thread/list_projects 可见项目核实回执。");
        requireValue(child.workspace && realpathSync(child.workspace) !== realpathSync(r.workspace) && this.repository(child.workspace) === r.repository, "执行会话必须位于所属仓库的独立 worktree。");
        requireValue(this.head(child.workspace) === r.baselineCommit, "新执行工作树 HEAD 与已授权业务基线不符；核实前禁止开始修复。");
        requireValue(!state.records.some(other => other.id !== r.id && (other.threadId === input.threadId || (occupied.has(other.status) && other.executionWorkspace === realpathSync(child.workspace)))), "执行会话或 worktree 已被占用。");
        r.threadId = input.threadId; r.projectId = input.projectId; r.executionWorkspace = realpathSync(child.workspace);
      }
      requireValue(["creating", "running", "blocked", "unknown", "awaiting_acceptance", "done_claimed"].includes(input.status), "不支持该宿主状态；不能用账本回执伪造停止。");
      requireValue(["creating", "unknown"].includes(input.status) || r.threadId, "先核实真实执行会话再上报状态。");
      r.status = input.status; r.updatedAt = new Date().toISOString();
      r.receipts.push({ eventId: input.eventId, status: input.status, evidence: input.evidence, observedAt: r.updatedAt, signature });
      return { record: r, idempotent: false };
    });
  }
  command(taskId, { action, message = "", eventId }) {
    requireValue(["supplement", "cancel", "open"].includes(action), "宿主没有已核实的暂停/继续能力，操作不可用。");
    requireValue(typeof eventId === "string" && /^[\w.-]{1,160}$/.test(eventId), "控制操作必须有稳定 eventId。");
    requireValue(typeof message === "string" && message.length <= 3000 && (action !== "supplement" || message.trim()), "补充要求不能为空或超长。");
    return this.change(state => {
      const r = state.records.find(r => r.taskId === taskId);
      requireValue(r, "尚无 Bug 派发。");
      const prior = r.commands.find(c => c.eventId === eventId);
      if (prior) { requireValue(prior.action === action && prior.message === message, "同一 eventId 的控制内容不一致。"); return { record: r, command: prior, idempotent: true }; }
      const cancelled = action === "cancel" && ["queued", "cancelled"].includes(r.status);
      requireValue(cancelled || !terminal.has(r.status) || action === "open", "该派发已终止。");
      if (action === "open") requireValue(r.threadId, "尚未核实真实宿主会话。");
      const command = { eventId, action, message, status: cancelled ? "confirmed" : "requested", createdAt: new Date().toISOString() };
      if (cancelled) r.status = "cancelled";
      r.commands.push(command); r.updatedAt = command.createdAt;
      return { record: r, command, idempotent: false };
    });
  }
  commandReceipt(sessionId, { id, eventId, evidence, outcome }) {
    requireValue(typeof evidence === "string" && evidence.trim() && evidence.length <= 2000, "缺少宿主控制证据。");
    return this.change(state => {
      const r = state.records.find(r => r.id === id);
      requireValue(r && [r.claimant, r.dispatcherSessionId].includes(sessionId), "控制回执不属于派发主脑。");
      const c = r.commands.find(c => c.eventId === eventId);
      requireValue(c, "控制请求不存在。");
      requireValue(["sent", "unavailable"].includes(outcome), "只能上报实际发送结果；不能把取消请求标为执行已停止。");
      if (c.status !== "requested") { requireValue(c.status === outcome && c.evidence === evidence, "控制回执已存在。"); return c; }
      c.status = outcome; c.evidence = evidence; c.observedAt = new Date().toISOString();
      return c;
    });
  }
  mergeLease(sessionId, { id, release = false }) {
    return this.change(state => {
      const r = state.records.find(r => r.id === id);
      requireValue(r && sessionId === r.threadId, "合入租约仅限已绑定执行会话。");
      if (release) { r.mergeLease = false; return { acquired: false }; }
      const task = this.task(r.taskId);
      requireValue(task?.bugClosure?.status === "awaiting_merge", "未通过当前修订验收，不允许领取合入租约。");
      requireValue(!state.records.some(other => other.id !== r.id && other.repository === r.repository && other.mergeLease), "同一仓库已有合入操作，必须排队。");
      r.targetBranch = task.bug.targetBranch;
      r.mergeLease = true;
      return { acquired: true, repository: r.repository, targetBranch: r.targetBranch, note: "租约不执行或授权合并；完成或失败后必须释放。" };
    });
  }
}
