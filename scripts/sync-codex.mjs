import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { classifyMessage, messageClasses } from "./classify-message.mjs";

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

function readSessionSelection() {
  if (!existsSync(selectionPath)) return { mode: "all", threadIds: [] };
  try {
    const value = JSON.parse(readFileSync(selectionPath, "utf8"));
    if (value?.mode === "selected" && Array.isArray(value.threadIds)) {
      return { mode: "selected", threadIds: value.threadIds.filter((id) => typeof id === "string") };
    }
  } catch {
    // Ignore a partially written local selection file and keep the safe default.
  }
  return { mode: "all", threadIds: [] };
}

const ignoreMessages = /^(继续|可以|可以的|做吧|执行吧|ok|okok|好的|一允许|继续吧)[。！!,.，\s]*$/i;
const completionSignals = /已完成|已经完成|已上线|已经补上|已通过|实现了|已经接入|已落地/;
const defaultThreadNames = new Map([
  ["019f6f27-d228-7af0-b32b-c2daeed14030", "boss广进计划"],
  ["019e698a-392b-7521-b782-ea3dd00c1a42", "探索 LegacyProject 项目"],
]);

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
  const sessionSelection = readSessionSelection();
  const selectedThreadIds = sessionSelection.mode === "selected"
    ? new Set(sessionSelection.threadIds)
    : null;
  const candidateFiles = findSessionFiles(sessionsRoot)
    .map((path) => ({ path, threadId: threadIdFromPath(path) }))
    .filter((item) => !configuredThreadIds || configuredThreadIds.has(item.threadId))
    .sort((a, b) => statSync(a.path).mtimeMs - statSync(b.path).mtimeMs);
  const allThreads = [];
  for (const item of candidateFiles) {
    allThreads.push(await parseThread(
      item.path,
      item.threadId,
      names.get(item.threadId) ||
        defaultThreadNames.get(item.threadId) ||
        `Codex ${item.threadId.slice(0, 8)}`,
    ));
  }
  const threads = allThreads.filter((thread) => !selectedThreadIds || selectedThreadIds.has(thread.id));

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
  const requirements = seededItems.filter(
    (requirement) =>
      !requirement.requiresConfirmation &&
      (sessionSelection.mode === "all" || requirement.sources.length > 0),
  );
  const proposals = seededItems
    .filter(
      (requirement) =>
        requirement.requiresConfirmation &&
        (sessionSelection.mode === "all" || requirement.sources.length > 0),
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
      availableThreadCount: allThreads.length,
      messageCount: threads.reduce((sum, thread) => sum + thread.userRequirements.length, 0),
      mode: "read-only local JSONL",
      sessionSelection,
      availableThreads: allThreads.map((thread) => ({
        id: thread.id,
        title: thread.title,
        cwd: thread.cwd,
        updatedAt: thread.updatedAt,
        requirementCount: thread.userRequirements.length,
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
  writeFileSync(outputPath, `${JSON.stringify(dashboard, null, 2)}\n`);
  console.log(`TaskCenter synced ${all.length} requirements from ${threads.length} Codex thread(s).`);
}

await main();
