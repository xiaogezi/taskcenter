import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { findSessionPath } from "./harnesses/codex-session.mjs";
import { consumeJsonl } from "./jsonl-stream.mjs";

const root = resolve(import.meta.dirname, "..");
const automationId = "instory-pca-2";
const sha = value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value || "");
const digest = content => createHash("sha256").update(content).digest("hex");

// Bind to host-written automation metadata and its first non-AGENTS user message.
export async function automationMemoryBinding(sessionId, workspace, agent) {
  if (agent !== "codex" || !/^[a-f0-9-]{36}$/.test(sessionId)) return null;
  const configPath = process.env.TASKCENTER_AUTOMATION_MEMORY_CONFIG_PATH || join(root, "config/automation-memory.json");
  let config;
  try { config = JSON.parse(readFileSync(configPath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (config.enabled !== true) return null;
  if (config.automation_id !== automationId || !config.authorization_ref || !isAbsolute(config.workspace_root || "") || !isAbsolute(config.codex_home || "")) throw new Error("自动化 memory 批准配置无效。");
  const workspaceRoot = realpathSync(config.workspace_root);
  if (realpathSync(workspace) !== workspaceRoot) return null;
  assertNoSymlinks(join(config.codex_home, "automations", automationId, "memory.md"));
  const codexHome = realpathSync(config.codex_home);
  const sessionPath = findSessionPath(sessionId, join(codexHome, "sessions"));
  if (!sessionPath) return null;
  assertNoSymlinks(sessionPath);
  let meta, initialMessage;
  await consumeJsonl(sessionPath, { end: 262143, onLine(line) {
    const item = JSON.parse(line);
    if (item.type === "session_meta" && !meta) meta = item.payload;
    const payload = item.payload;
    if (initialMessage !== undefined || item.type !== "response_item" || payload?.type !== "message" || payload.role !== "user") return;
    const text = (payload.content || []).map(part => part.text || "").join("");
    if (!text.startsWith("# AGENTS.md instructions for ")) initialMessage = text;
  } });
  if ((meta?.id || meta?.session_id) !== sessionId || meta?.thread_source !== "automation" || realpathSync(meta?.cwd || "/") !== workspaceRoot) return null;
  const expectedMemory = `$CODEX_HOME/automations/${automationId}/memory.md`;
  if (!initialMessage?.startsWith("Automation: ") || !initialMessage.split(/\r?\n/).includes(`Automation ID: ${automationId}`)
    || !initialMessage.split(/\r?\n/).includes(`Automation memory: ${expectedMemory}`)) return null;
  const memoryPath = join(codexHome, "automations", automationId, "memory.md");
  assertNoSymlinks(memoryPath);
  return { automationId, workspaceRoot, memoryPath, sessionId, authorizationRef: config.authorization_ref };
}

export function assertNoSymlinks(path) {
  const target = resolve(path);
  for (let candidate = target; ; candidate = dirname(candidate)) {
    try {
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink() || (candidate === target ? !stat.isFile() : !stat.isDirectory())) throw new Error("自动化 memory 路径不得经过符号链接或非普通文件/目录。");
      if (candidate === target && stat.nlink !== 1) throw new Error("自动化 memory 不允许硬链接文件。");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (dirname(candidate) === candidate) break;
  }
}

export function parseAutomationMemory(content) {
  if (Buffer.byteLength(content) > 65536) throw new Error("自动化 memory 超出 64 KiB 上限。");
  const match = /^# instory-pca-2\r?\n\r?\n```json\r?\n([\s\S]+)\r?\n```\r?\n?$/.exec(content);
  if (!match) throw new Error("自动化 memory 必须是固定标题和唯一 JSON 区块。");
  const record = JSON.parse(match[1]);
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "automation_id,coverage,last_successful_sha,observed_at,result,status,subject_sha" || record.automation_id !== automationId
    || !["success", "failed", "incomplete"].includes(record.status)
    || !(record.subject_sha === null || sha(record.subject_sha)) || !(record.last_successful_sha === null || sha(record.last_successful_sha))
    || typeof record.observed_at !== "string" || !Number.isFinite(Date.parse(record.observed_at))
    || typeof record.result !== "string" || !record.result.trim() || record.result.length > 4096
    || !Array.isArray(record.coverage) || record.coverage.length > 100
    || record.coverage.some(path => typeof path !== "string" || !path || path.length > 1024 || path.startsWith("/") || path.includes("\\") || path.split("/").includes(".."))) throw new Error("自动化 memory 记录字段无效。");
  if (record.status === "success" && (!sha(record.subject_sha) || record.last_successful_sha !== record.subject_sha || record.coverage.length === 0)) throw new Error("成功记录须包含 Subject、覆盖范围和同一成功 SHA。");
  return record;
}

export function inspectAutomationMemoryPatch(binding, patch, simulateUpdate) {
  assertNoSymlinks(binding.memoryPath);
  if (!patch || !/^\*\*\* Begin Patch\r?\n/.test(patch) || !/\r?\n\*\*\* End Patch\s*$/.test(patch)) throw new Error("自动化 memory 补丁格式无效。");
  const headers = [...patch.matchAll(/^\*\*\* (Add|Update) File: (.+)$/gm)];
  if (headers.length !== 1 || headers[0][2].trim() !== binding.memoryPath || /^\*\*\* (?:Delete File|Move to):/m.test(patch)) throw new Error("自动化 memory 只接受唯一绑定文件的 Add/Update。");
  let before = "";
  try { before = readFileSync(binding.memoryPath, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  let after;
  if (headers[0][1] === "Add") {
    try { lstatSync(binding.memoryPath); throw new Error("自动化 memory Add 不得覆盖已有文件。"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const lines = patch.replaceAll("\r\n", "\n").trimEnd().split("\n").slice(2, -1);
    if (!lines.length || lines.some(line => !line.startsWith("+"))) throw new Error("自动化 memory Add 只能包含新增内容。");
    after = lines.map(line => line.slice(1)).join("\n") + "\n";
  } else {
    if (!before) throw new Error("自动化 memory Update 要求有效的已有文件。");
    after = simulateUpdate(before, patch);
  }
  const oldSha = before ? parseAutomationMemory(before).last_successful_sha : null;
  const record = parseAutomationMemory(after);
  if (record.status !== "success" && record.last_successful_sha !== oldSha) throw new Error("失败或未完成巡检不得推进/删除成功基线。");
  return { content: after, record, oldSha };
}

const stateRoot = () => process.env.TASKCENTER_AUTOMATION_MEMORY_STATE_ROOT || join(root, ".local/automation-memory");
export function auditAutomationMemory(binding, phase, content, oldSha = null) {
  const directory = stateRoot();
  const pendingPath = join(directory, `${binding.sessionId}.json`);
  assertNoSymlinks(pendingPath);
  assertNoSymlinks(join(directory, "audit.jsonl"));
  mkdirSync(directory, { recursive: true });
  const record = parseAutomationMemory(content);
  const fingerprint = digest(content);
  if (phase === "verified") {
    const pending = JSON.parse(readFileSync(pendingPath, "utf8"));
    if (pending.fingerprint !== fingerprint || pending.memoryPath !== binding.memoryPath) throw new Error("自动化 memory 落盘内容与批准补丁不一致。");
    oldSha = pending.oldSha;
    if (record.status !== "success" && record.last_successful_sha !== oldSha) throw new Error("自动化 memory 失败记录改变了成功基线。");
  }
  appendFileSync(join(directory, "audit.jsonl"), JSON.stringify({ at: new Date().toISOString(), phase,
    session_id: binding.sessionId, automation_id: binding.automationId, workspace: binding.workspaceRoot,
    memory_path: binding.memoryPath, authorization_ref: binding.authorizationRef, sha256: fingerprint,
    status: record.status, subject_sha: record.subject_sha, last_successful_sha: record.last_successful_sha }) + "\n", { mode: 0o600 });
  if (phase === "allowed") writeFileSync(pendingPath, JSON.stringify({ fingerprint, oldSha, memoryPath: binding.memoryPath }), { mode: 0o600 });
  else rmSync(pendingPath);
}
