import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { sessionDisplayTitle } from "../app/session-groups.mjs";
import { classifyMessage, messageClasses } from "./classify-message.mjs";
import { readSessionAllowlist } from "./session-allowlist.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const sessionsRoot = join(codexHome, "sessions");
const outputPath = process.env.TASKCENTER_DASHBOARD_PATH || join(projectRoot, "data", "dashboard.json");
const selectionPath = process.env.TASKCENTER_SELECTION_PATH || join(projectRoot, "data", "session-selection.json");
const seedPath = process.env.TASKCENTER_SEED_PATH || join(projectRoot, "data", "requirements.seed.json");
const seed = JSON.parse(readFileSync(seedPath, "utf8"));
const sourceLimit = Number(process.env.TASKCENTER_SOURCE_LIMIT || 10);
const configuredThreadIds = process.env.TASKCENTER_THREADS
  ? new Set(process.env.TASKCENTER_THREADS.split(",").map((value) => value.trim()).filter(Boolean))
  : null;

const ignoreMessages = /^(继续|可以|可以的|做吧|执行吧|ok|okok|好的|一允许|继续吧)[。！!,.，\s]*$/i;
const completionSignals = /已完成|已经完成|已上线|已经补上|已通过|实现了|已经接入|已落地/;
const defaultThreadNames = new Map();

function findSessionFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...findSessionFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

function threadIdFromPath(path) {
  return basename(path).match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i)?.[1] || "";
}

async function readSessionFileMetadata(path) {
  const fallbackId = threadIdFromPath(path);
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        break;
      }
      if (record.type !== "session_meta") break;
      const payload = record.payload || {};
      const isSubagent = payload.thread_source === "subagent" || Boolean(payload.source?.subagent);
      const canonicalId = String(isSubagent
        ? payload.parent_thread_id || payload.session_id || fallbackId
        : payload.session_id || fallbackId).trim();
      return {
        path,
        canonicalId,
        rolloutId: String(payload.id || fallbackId).trim(),
        parentThreadId: String(payload.parent_thread_id || "").trim(),
        isSubagent,
        cwd: String(payload.cwd || "").trim(),
        mtimeMs: statSync(path).mtimeMs,
      };
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return { path, canonicalId: fallbackId, rolloutId: fallbackId, parentThreadId: "", isSubagent: false, cwd: "", mtimeMs: statSync(path).mtimeMs };
}

function groupSessionFiles(files) {
  const groups = new Map();
  for (const file of files) {
    if (!file.canonicalId) continue;
    const current = groups.get(file.canonicalId) || {
      threadId: file.canonicalId,
      files: [],
      aliases: new Set([file.canonicalId]),
      cwd: "",
      mtimeMs: 0,
    };
    current.files.push(file);
    if (file.rolloutId) current.aliases.add(file.rolloutId);
    if (file.parentThreadId) current.aliases.add(file.parentThreadId);
    if (!file.isSubagent && file.cwd) current.cwd = file.cwd;
    if (!current.cwd && file.cwd) current.cwd = file.cwd;
    current.mtimeMs = Math.max(current.mtimeMs, file.mtimeMs);
    groups.set(file.canonicalId, current);
  }
  return [...groups.values()].sort((left, right) => left.mtimeMs - right.mtimeMs);
}

function readThreadNames() {
  const indexPath = join(codexHome, "session_index.jsonl");
  const names = new Map();
  if (!existsSync(indexPath)) return names;
  for (const line of readFileSync(indexPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item.id && item.thread_name) names.set(item.id, item.thread_name);
    } catch {
      // Ignore a partially written final line while Codex is updating the file.
    }
  }
  return names;
}

function messageText(payload) {
  if (payload?.type === "user_message") return String(payload.message || "").trim();
  if (payload?.type !== "message") return "";
  return (payload.content || [])
    .filter((item) => item.type === "text" || item.type === "output_text" || item.type === "input_text")
    .map((item) => item.text || "")
    .join("\n")
    .trim();
}

function cleanUserMessage(text) {
  const requestMarker = "# My request for Codex:";
  const request = text.includes(requestMarker) ? text.split(requestMarker).at(-1) : text;
  return request
    .replace(/<image[\s\S]*?<\/image>/gi, "")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function parseThread(path, threadId, title) {
  const users = [];
  const claims = [];
  let cwd = "";
  let userTimestamp = "";
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === "session_meta") cwd = record.payload?.cwd || cwd;
    if (record.type === "event_msg" && record.payload?.type === "user_message") {
      const text = cleanUserMessage(messageText(record.payload));
      if (text && !ignoreMessages.test(text) && !text.includes("<codex_delegation>")) {
        users.push({
          text,
          timestamp: record.timestamp || "",
          classification: classifyMessage(text),
        });
        userTimestamp = record.timestamp || userTimestamp;
      }
    }
    if (
      record.type === "response_item" &&
      record.payload?.type === "message" &&
      record.payload?.role === "assistant"
    ) {
      const text = messageText(record.payload);
      if (completionSignals.test(text)) claims.push({ text, timestamp: record.timestamp || "" });
    }
  }
  return {
    id: threadId,
    title,
    cwd,
    updatedAt: userTimestamp,
    file: path,
    userRequirements: users,
    completionClaims: claims,
  };
}

async function parseSessionFiles(session, title) {
  const roots = session.files.filter((file) => !file.isSubagent).sort((left, right) => left.mtimeMs - right.mtimeMs);
  if (!roots.length) {
    return { id: session.threadId, title, cwd: session.cwd, updatedAt: new Date(session.mtimeMs).toISOString(), file: "", userRequirements: [], completionClaims: [] };
  }
  const parsed = [];
  for (const file of roots) parsed.push(await parseThread(file.path, session.threadId, title));
  const unique = (items) => [...new Map(items.map((item) => [`${item.timestamp}\n${item.text}`, item])).values()]
    .sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)));
  return {
    id: session.threadId,
    title,
    cwd: [...parsed].reverse().find((thread) => thread.cwd)?.cwd || session.cwd,
    updatedAt: parsed.map((thread) => thread.updatedAt).filter(Boolean).sort().at(-1) || new Date(session.mtimeMs).toISOString(),
    file: roots.at(-1)?.path || "",
    userRequirements: unique(parsed.flatMap((thread) => thread.userRequirements)),
    completionClaims: unique(parsed.flatMap((thread) => thread.completionClaims)),
  };
}

function compact(text, limit = 180) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function sourceMatches(requirement, thread) {
  const keywords = requirement.keywords || [];
  return thread.userRequirements
    .filter((message) => keywords.some((keyword) => message.text.toLowerCase().includes(keyword.toLowerCase())))
    .slice(-sourceLimit)
    .map((message) => ({
      threadId: thread.id,
      threadTitle: thread.title,
      excerpt: compact(message.text),
      timestamp: message.timestamp,
    }));
}

function claimMatches(requirement, thread) {
  const keywords = requirement.keywords || [];
  return thread.completionClaims.some((message) =>
    keywords.some((keyword) => message.text.toLowerCase().includes(keyword.toLowerCase())),
  );
}

function analyzeUnmatched(threads, matchedExcerpts) {
  const seen = new Set(matchedExcerpts);
  const result = [];
  const excludedItems = [];
  const excludedCounts = Object.fromEntries(
    messageClasses.map((classification) => [classification, 0]),
  );
  for (const thread of threads) {
    for (const message of thread.userRequirements) {
      const excerpt = compact(message.text);
      if (seen.has(excerpt)) continue;
      if (!["requirement", "feedback", "discovery", "business_goal"].includes(message.classification)) {
        excludedCounts[message.classification] += 1;
        const excludedFingerprint = createHash("sha256")
          .update(`${thread.id}:${message.timestamp}:${excerpt}`)
          .digest("hex")
          .slice(0, 20);
        excludedItems.push({
          id: `excluded-${excludedFingerprint}`,
          classification: message.classification,
          text: excerpt,
          threadId: thread.id,
          threadTitle: thread.title,
          timestamp: message.timestamp,
        });
        continue;
      }
      const fingerprint = createHash("sha256")
        .update(`${thread.id}:${message.timestamp}:${excerpt}`)
        .digest("hex")
        .slice(0, 20);
      result.push({
        id: `inbox-${fingerprint}`,
        title: excerpt.length > 48 ? `${excerpt.slice(0, 47)}…` : excerpt,
        category: "待整理",
        priority: "待定",
        status: "untriaged",
        summary: excerpt,
        gap: "这是从 Codex 对话自动发现的新需求，尚未与代码证据关联。",
        discoveryType: message.classification,
        keywords: [],
        evidence: [],
        sources: [{
          threadId: thread.id,
          threadTitle: thread.title,
          excerpt,
          timestamp: message.timestamp,
        }],
        claimedDone: false,
      });
    }
  }
  return {
    items: result.slice(-80).reverse(),
    excludedCounts,
    excludedItems: excludedItems.slice(-80).reverse(),
  };
}

async function main() {
  const names = readThreadNames();
  const sessionSelection = readSessionAllowlist(selectionPath);
  const selectedThreadIds = new Set(sessionSelection.threadIds);
  const scannedFiles = [];
  for (const path of findSessionFiles(sessionsRoot)) scannedFiles.push(await readSessionFileMetadata(path));
  const candidateSessions = groupSessionFiles(scannedFiles)
    .filter((session) => !configuredThreadIds || [...session.aliases].some((id) => configuredThreadIds.has(id)));
  const normalizedSelectedIds = new Set();
  for (const session of candidateSessions) {
    if ([...session.aliases].some((id) => selectedThreadIds.has(id))) normalizedSelectedIds.add(session.threadId);
  }
  const effectiveSessionSelection = { ...sessionSelection, threadIds: [...normalizedSelectedIds] };
  const allowedSessions = candidateSessions.filter((session) => normalizedSelectedIds.has(session.threadId));
  const allThreads = [];
  for (const session of allowedSessions) {
    const sourceTitle = names.get(session.threadId) || defaultThreadNames.get(session.threadId);
    const title = sessionDisplayTitle(
      sourceTitle,
      session.threadId,
      session.cwd,
    );
    allThreads.push({
      ...await parseSessionFiles(session, title),
      titleSource: sourceTitle ? "codex" : "metadata",
    });
  }
  const threads = allThreads;

  const matchedExcerpts = new Set();
  const seededItems = seed.map((requirement) => {
    const sources = threads.flatMap((thread) => sourceMatches(requirement, thread));
    sources.forEach((source) => matchedExcerpts.add(source.excerpt));
    return {
      ...requirement,
      sources,
      claimedDone: threads.some((thread) => claimMatches(requirement, thread)),
    };
  });
  // Curated seed requirements are repository-owned data and remain visible even
  // when the Session allowlist is empty. Only Session-derived sources/proposals
  // are constrained by the allowlist.
  const requirements = seededItems.filter((requirement) => !requirement.requiresConfirmation);
  const proposals = seededItems
    .filter(
      (requirement) =>
        requirement.requiresConfirmation &&
        requirement.sources.length > 0,
    )
    .map((requirement) => ({
      ...requirement,
      status: "untriaged",
      category: "待整理",
      summary: requirement.inboxExcerpt || requirement.sources[0]?.excerpt || requirement.summary,
      normalizedSummary: requirement.summary,
      suggestedCategory: requirement.category,
      suggestedStatus: requirement.status,
      gap: "AI 已识别并规范化为候选需求，等待人工选择继续推进或丢弃。",
    }));
  const unmatched = analyzeUnmatched(threads, matchedExcerpts);
  const inbox = [...proposals, ...unmatched.items];
  const classificationCounts = Object.fromEntries(
    messageClasses.map((classification) => [
      classification,
      threads.reduce(
        (total, thread) =>
          total + thread.userRequirements.filter(
            (message) => message.classification === classification,
          ).length,
        0,
      ),
    ]),
  );
  const excludedCount = ["operation", "question", "collaboration", "other"]
    .reduce((total, classification) => total + unmatched.excludedCounts[classification], 0);
  const all = [...requirements, ...inbox];
  const statusCounts = Object.fromEntries(
    ["verified", "in_progress", "partial", "missing", "needs_validation", "untriaged"].map((status) => [
      status,
      all.filter((item) => item.status === status).length,
    ]),
  );
  const dashboard = {
    generatedAt: new Date().toISOString(),
    source: {
      codexHome: process.env.CODEX_HOME ? codexHome : "~/.codex",
      threadCount: threads.length,
      availableThreadCount: candidateSessions.length,
      messageCount: threads.reduce((sum, thread) => sum + thread.userRequirements.length, 0),
      mode: "read-only local JSONL",
      sessionSelection: effectiveSessionSelection,
      availableThreads: candidateSessions.map((session) => ({
        id: session.threadId,
        title: sessionDisplayTitle(
          names.get(session.threadId) || defaultThreadNames.get(session.threadId),
          session.threadId,
          session.cwd,
        ),
        titleSource: names.get(session.threadId) || defaultThreadNames.get(session.threadId) ? "codex" : "metadata",
        updatedAt: new Date(session.mtimeMs).toISOString(),
        allowed: normalizedSelectedIds.has(session.threadId),
        requirementCount: allThreads.find((thread) => thread.id === session.threadId)?.userRequirements.length || 0,
      })),
      classificationCounts,
      excludedCounts: unmatched.excludedCounts,
      excludedItems: unmatched.excludedItems,
    },
    summary: {
      total: all.length,
      curatedTotal: requirements.length,
      inboxCount: inbox.length,
      excludedCount,
      completionRate: requirements.length
        ? Math.round(statusCounts.verified * 100 / requirements.length)
        : 0,
      statusCounts,
    },
    threads: threads.map((thread) => ({
      id: thread.id,
      title: thread.title,
      titleSource: thread.titleSource,
      cwd: thread.cwd,
      updatedAt: thread.updatedAt,
      requirementCount: thread.userRequirements.length,
      completionClaimCount: thread.completionClaims.length,
    })),
    requirements: all,
  };
  const current = existsSync(outputPath) ? JSON.parse(readFileSync(outputPath, "utf8")) : null;
  const comparable = (value) => JSON.stringify({ ...value, generatedAt: "" });
  if (current && comparable(current) === comparable(dashboard)) {
    console.log("TaskCenter checked Codex tasks; dashboard data is unchanged.");
    return;
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(dashboard, null, 2)}\n`);
  console.log(`TaskCenter synced ${all.length} requirements from ${threads.length} Codex thread(s).`);
}

await main();
