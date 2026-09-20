import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectSessionState, resumeSession } from "./codex-session.mjs";
import { runCodexDelegated } from "./codex-delegated.mjs";

async function createSession({ workingDirectory, prompt, onThreadStarted, onEvent = () => {} }) {
  const moduleName = process.env.TASKCENTER_CODEX_SDK_MODULE || "@openai/codex-sdk";
  const { Codex } = await import(isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
  const thread = new Codex().startThread({ workingDirectory, sandboxMode: "workspace-write", approvalPolicy: "on-request" });
  const { events } = await thread.runStreamed(prompt);
  const iterator = events[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) throw new Error("Codex SDK 未返回任务启动事件");
  if (first.value?.type === "error" || first.value?.type === "turn.failed") throw new Error(first.value.message || "目标 Session 拒绝接收消息");
  const sessionId = first.value?.type === "thread.started" ? first.value.thread_id : "";
  if (!sessionId) throw new Error("Codex SDK 未返回新 Session ID");
  await onThreadStarted?.(sessionId);
  onEvent({ status: "accepted", sessionId });
  // Delivery is not completion. Continue consuming the stream and report its actual outcome.
  void drain(iterator, sessionId, onEvent);
  return { status: "accepted", sessionId, threadId: sessionId };
}

async function drain(iterator, sessionId, onEvent) {
  let terminal = false;
  try {
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      const event = next.value;
      if (!terminal && event.type === "turn.started") onEvent({ status: "running", sessionId });
      if (!terminal && ["turn.completed", "turn.failed", "error"].includes(event.type)) {
        terminal = true;
        onEvent({ status: event.type === "turn.completed" ? "completed" : "failed", sessionId, message: event.message || event.error?.message || "" });
      }
    }
    if (!terminal) onEvent({ status: "unknown", sessionId, message: "Stream ended without a terminal receipt" });
  } catch (error) {
    onEvent({ status: "unknown", sessionId, message: String(error.message).slice(0, 500) });
  }
}

export const codexAdapter = {
  id: "codex",
  client: { label: "Codex", hooks: true, resume: true, usage: true },
  identity: "host_metadata_or_environment",
  usageScope: "token_usage",
  operations: {
    createSession,
    inspectSession: ({ sessionId, sessionsRoot }) => inspectSessionState(sessionId, sessionsRoot),
    resumeSession: async ({ sessionId, onEvent = () => {}, onStarted, ...input }) => {
      const result = await resumeSession({ ...input, threadId: sessionId, onStarted: () => {
        onEvent({ status: "running", sessionId }); onStarted?.();
      } });
      return { ...result, status: "completed", sessionId };
    },
    runDelegatedCli: runCodexDelegated,
  },
};
