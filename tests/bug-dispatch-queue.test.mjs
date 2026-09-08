import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BugDispatchQueue, repositoryIdentity } from "../scripts/bug-dispatch-queue.mjs";
import { execFileSync } from "node:child_process";

const brain = "00000000-0000-4000-8000-000000000001";
const child = "00000000-0000-4000-8000-000000000002";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bug-queue-"));
  const base = join(dir, "base"), worktree = join(dir, "worktree");
  mkdirSync(base); mkdirSync(worktree);
  const sessions = { [brain]: { workspace: base }, [child]: { workspace: worktree } };
  const tasks = Object.fromEntries(["a", "b", "c"].map(id => [id, { id, title: id, workspace: base, sessionId: brain, bug: { targetBranch: "main" } }]));
  const options = { task: id => tasks[id], session: id => sessions[id], repository: () => join(base, ".git"), baseline: () => "a".repeat(40), head: () => "a".repeat(40) };
  const path = join(dir, "queue.json");
  return { queue: new BugDispatchQueue(path, options), path, options, sessions, tasks, base, worktree };
}
function running(record) { return { id: record.id, claimToken: record.claimToken, eventId: "created", status: "running", threadId: child, projectId: "actual-project", visible: true, evidence: "create_thread and read_thread confirmed actual worktree" }; }

test("最多两路，资源冲突排队；重复派发与重启后claim不重复创建", () => {
  const { queue, path, options } = fixture();
  const a = queue.enqueue("a", { resources: ["device:1"] });
  assert.equal(queue.enqueue("a").record.id, a.record.id);
  queue.enqueue("b", { resources: ["device:1"] }); queue.enqueue("c");
  const first = queue.claim(brain);
  assert.equal(first.record.taskId, "a");
  const resumed = new BugDispatchQueue(path, options).claim(brain, first.record.id);
  assert.equal(resumed.resumed, true); assert.equal(resumed.record.claimToken, first.record.claimToken);
  assert.equal(queue.claim(brain).record.taskId, "c");
  assert.equal(queue.claim(brain).record, null);
  assert.equal(queue.snapshot().occupied, 2);
});

test("排队撤回幂等且无法再claim，运行取消仅记请求并保留名额", () => {
  const { queue } = fixture();
  queue.enqueue("a");
  const input = { action: "cancel", eventId: "cancel-1" };
  assert.equal(queue.command("a", input).record.status, "cancelled");
  assert.equal(queue.command("a", input).idempotent, true);
  assert.equal(queue.enqueue("a").idempotent, true);
  assert.equal(queue.claim(brain).record, null);
  queue.enqueue("b"); const claim = queue.claim(brain).record;
  queue.receipt(brain, running(claim));
  queue.command("b", input);
  assert.equal(queue.snapshot("b").records[0].status, "running");
  queue.commandReceipt(brain, { id: claim.id, eventId: "cancel-1", outcome: "sent", evidence: "send_message_to_thread accepted" });
  assert.equal(queue.snapshot().occupied, 1);
  assert.throws(() => queue.commandReceipt(brain, { id: claim.id, eventId: "cancel-1", outcome: "stopped", evidence: "ledger only" }));
  assert.throws(() => queue.command("b", { action: "pause", eventId: "pause" }));
});

test("真实独立worktree与可见项目回执必需，拒绝复用父会话和身份冒领", () => {
  const { queue, sessions, base } = fixture();
  queue.enqueue("a"); const r = queue.claim(brain).record;
  assert.throws(() => queue.receipt(brain, { ...running(r), threadId: brain }));
  assert.throws(() => queue.receipt(brain, { ...running(r), visible: false }));
  assert.throws(() => queue.receipt(brain, { ...running(r), claimToken: "bad" }));
  assert.throws(() => queue.receipt(child, running(r)));
  sessions[child].workspace = base;
  assert.throws(() => queue.receipt(brain, running(r)));
  assert.equal(queue.snapshot().records[0].status, "claimed");
});

test("回执幂等、稳定事件碰撞拒绝；公开快照不泄露claim；等待验收释放名额", () => {
  const { queue } = fixture();
  queue.enqueue("a"); const r = queue.claim(brain).record;
  queue.receipt(brain, running(r));
  assert.equal(queue.receipt(brain, running(r)).idempotent, true);
  assert.throws(() => queue.receipt(brain, { ...running(r), evidence: "different" }));
  assert.equal(JSON.stringify(queue.snapshot()).includes(r.claimToken), false);
  queue.receipt(child, { id: r.id, eventId: "ready", status: "awaiting_acceptance", evidence: "read_thread terminal turn and evidence ready" });
  assert.equal(queue.snapshot().occupied, 0);
  queue.enqueue("b"); queue.enqueue("c"); queue.claim(brain); queue.claim(brain);
  for (const status of ["running", "blocked", "unknown"]) {
    assert.throws(() => queue.receipt(child, { id: r.id, eventId: `resume-${status}`, status, evidence: "resume attempt" }));
    assert.equal(queue.snapshot().occupied, 2);
  }
});

test("声明完成仍能补充与退回原会话修复，恢复前重新检查名额", () => {
  const { queue } = fixture();
  queue.enqueue("a"); const r = queue.claim(brain).record; queue.receipt(brain, running(r));
  queue.receipt(child, { id: r.id, eventId: "done", status: "done_claimed", evidence: "implementation declared, not accepted" });
  assert.equal(queue.snapshot().occupied, 0);
  assert.equal(queue.command("a", { action: "supplement", eventId: "returned", message: "验收退回" }).command.status, "requested");
  queue.receipt(child, { id: r.id, eventId: "repair", status: "running", evidence: "return to repair in same thread" });
  assert.equal(queue.snapshot().occupied, 1);
});

test("外部合入租约按仓库串行且只允许已验收的绑定执行会话", () => {
  const { queue, sessions, tasks, base } = fixture();
  const child2 = "00000000-0000-4000-8000-000000000003";
  const worktree2 = join(base, "wt2"); mkdirSync(worktree2); sessions[child2] = { workspace: worktree2 };
  queue.enqueue("a"); const a = queue.claim(brain).record; queue.receipt(brain, running(a));
  queue.enqueue("b"); const b = queue.claim(brain).record; queue.receipt(brain, { ...running(b), threadId: child2 });
  assert.throws(() => queue.mergeLease(child, { id: a.id }));
  tasks.a.bugClosure = tasks.b.bugClosure = { status: "awaiting_merge" };
  tasks.a.bug.targetBranch = "release/new";
  assert.equal(queue.mergeLease(child, { id: a.id }).acquired, true);
  assert.equal(queue.mergeLease(child, { id: a.id }).targetBranch, "release/new");
  assert.throws(() => queue.mergeLease(child2, { id: b.id }));
  queue.mergeLease(child, { id: a.id, release: true });
  assert.equal(queue.mergeLease(child2, { id: b.id }).acquired, true);
});

test("异步创建clientThreadId持久化且重启不重派，取消创建请求保留不确定名额", () => {
  const { queue, path, options } = fixture();
  queue.enqueue("a"); const r = queue.claim(brain).record;
  const pending = { id: r.id, claimToken: r.claimToken, eventId: "pending", status: "creating", clientThreadId: "host-pending-id", evidence: "create_thread returned queued setup" };
  queue.receipt(brain, pending);
  assert.equal(queue.receipt(brain, pending).idempotent, true);
  const restarted = new BugDispatchQueue(path, options);
  const resumed = restarted.claim(brain, r.id);
  assert.equal(resumed.resumed, true); assert.equal(resumed.record.clientThreadId, "host-pending-id");
  assert.equal(restarted.claim(brain).record, null);
  assert.throws(() => queue.receipt(brain, { ...pending, eventId: "different", clientThreadId: "new-id" }));
  queue.command("a", { action: "cancel", eventId: "cancel-pending" });
  assert.equal(queue.snapshot().occupied, 1);
  queue.receipt(brain, running(r));
  assert.equal(queue.snapshot().records[0].threadId, child);
  assert.throws(() => queue.receipt(brain, { ...pending, eventId: "again" }));
});

test("拒绝把同一工作树子目录当独立worktree，且核实新工作树确切业务基线", () => {
  const { queue, base } = fixture();
  execFileSync("git", ["init", base], { stdio: "ignore" });
  const subdir = join(base, "subdir"); mkdirSync(subdir);
  assert.throws(() => repositoryIdentity(subdir));
  assert.ok(repositoryIdentity(base));
  queue.enqueue("a"); const r = queue.claim(brain).record;
  queue.head = () => "b".repeat(40);
  assert.throws(() => queue.receipt(brain, running(r)));
  assert.equal(queue.snapshot().records[0].status, "claimed");
});
