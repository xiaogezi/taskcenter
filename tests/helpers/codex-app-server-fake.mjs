#!/usr/bin/env node
/**
 * Fake codex app-server for protocol tests.
 * Reads JSON-RPC from stdin, writes to stdout.
 *
 * Controlled via env vars:
 *   CAPTURE_FILE=path       → append received thread/start and turn/start params as JSON lines
 *   MODEL_MISMATCH=1        → return wrong model in thread/start
 *   MODEL_MISSING=1         → omit model from thread/start result
 *   NO_HOOK=1               → hooks/list returns an entry with no hooks
 *   BAD_HOOK_MATCHER=1      → hooks/list matcher lacks exec_command coverage
 *   HOOK_WRONG_CWD=1        → hooks/list entry targets a different cwd
 *   INVALID_JSON=1          → emit a non-JSON line after initialize
 *   EXIT_EARLY=1            → exit when thread/start arrives
 *   SLOW_TURN=1             → delay turn completion (for abort test)
 *   SEND_EXEC_APPROVAL=1    → send command execution approval before completing
 *   SEND_FILE_APPROVAL=1    → send file change approval before completing
 *   PRE_CLAIM_APPROVAL=1    → send command approval right after thread/start (before claim)
 *   UNKNOWN_REQUEST=1       → send an unknown-method server request; expect -32601
 *   WRONG_THREAD_APPROVAL=1 → send approval with mismatched thread identity
 *   TURN_FAIL=1             → complete turn with failed status
 */

import { appendFileSync } from "node:fs";

const THREAD_ID = "thread-test-001";
const TURN_ID = "turn-test-001";

let stdinBuf = "";
let nextResponseId = 0;
const pendingResponses = new Map(); // id → handler

function capture(kind, params) {
  if (process.env.CAPTURE_FILE) appendFileSync(process.env.CAPTURE_FILE, JSON.stringify({ kind, params }) + "\n");
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuf += chunk;
  let nl;
  while ((nl = stdinBuf.indexOf("\n")) >= 0) {
    const line = stdinBuf.slice(0, nl);
    stdinBuf = stdinBuf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handleMessage(msg);
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function hookEntry(cwd) {
  if (process.env.NO_HOOK === "1") return { cwd, errors: [], warnings: [], hooks: [] };
  const matcher = process.env.BAD_HOOK_MATCHER === "1"
    ? "^(Bash|apply_patch|Edit|Write)$"
    : "^(Bash|apply_patch|exec_command|Edit|Write)$";
  return {
    cwd,
    errors: [],
    warnings: [],
    hooks: [{
      eventName: "preToolUse",
      handlerType: "command",
      command: "node /abs/scripts/taskcenter-hook.mjs pre-tool-use --agent codex",
      async: false,
      matcher,
      enabled: true,
      trustStatus: "trusted",
    }],
  };
}

function handleMessage(msg) {
  // Client response to a server request (has id, no method)
  if (msg.id != null && !msg.method) {
    const handler = pendingResponses.get(msg.id);
    if (handler) { pendingResponses.delete(msg.id); handler(msg); }
    return;
  }

  // Notification (no id)
  if (msg.id == null) {
    if (msg.method === "initialized") return;
    return;
  }

  const { id, method, params } = msg;

  if (method === "initialize") {
    send({ id, result: { serverInfo: { name: "fake", version: "0.1" } } });
    if (process.env.INVALID_JSON === "1") process.stdout.write("this is not json\n");
    return;
  }

  if (method === "hooks/list") {
    const cwd = process.env.HOOK_WRONG_CWD === "1" ? "/elsewhere" : params?.cwds?.[0] || "/tmp";
    send({ id, result: { data: [hookEntry(cwd)] } });
    return;
  }

  if (method === "thread/start") {
    if (process.env.EXIT_EARLY === "1") {
      process.exit(1);
    }
    capture("thread/start", params);
    const model = process.env.MODEL_MISMATCH === "1" ? "wrong-model" : params.model;
    const result = {
      modelProvider: "openai",
      approvalPolicy: params.approvalPolicy || "on-request",
      sandbox: {},
      cwd: params.cwd || "/tmp",
      thread: {
        id: THREAD_ID,
        sessionId: THREAD_ID,
        cliVersion: "0.0.0-test",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        cwd: params.cwd || "/tmp",
        ephemeral: false,
        modelProvider: "openai",
        preview: false,
        projectId: null,
        source: { type: "api" },
        status: { type: "idle" },
        turns: [],
      },
    };
    if (process.env.MODEL_MISSING !== "1") result.model = model;
    send({ id, result });
    if (process.env.PRE_CLAIM_APPROVAL === "1") void sendExecApproval(THREAD_ID);
    return;
  }

  if (method === "turn/start") {
    capture("turn/start", params);
    handleTurnStart(id, params);
    return;
  }

  // Unknown method → generic empty result
  send({ id, result: {} });
}

function sendExecApproval(threadId, prefix = []) {
  const approvalId = ++nextResponseId;
  const request = {
    id: approvalId,
    method: "item/commandExecution/requestApproval",
    params: {
      itemId: `exec-${approvalId}`,
      threadId,
      turnId: TURN_ID,
      command: "ls -la",
      commandActions: [{ type: "listFiles", command: "ls -la" }],
      cwd: "/tmp",
      kind: "command",
      startedAtMs: Date.now(),
    },
  };
  process.stdout.write([...prefix, request].map(value => JSON.stringify(value)).join("\n") + "\n");
  // Wait for response from client before continuing
  return new Promise((resolve) => {
    pendingResponses.set(approvalId, (response) => {
      capture("exec-approval-response", response);
      resolve(response);
    });
  });
}

function sendFileChangeApproval(threadId) {
  const approvalId = ++nextResponseId;
  send({
    id: approvalId,
    method: "item/fileChange/requestApproval",
    params: {
      itemId: `file-${approvalId}`,
      threadId,
      turnId: TURN_ID,
      grantRoot: "/tmp/test.txt",
      reason: "write access",
      startedAtMs: Date.now(),
    },
  });
  return new Promise((resolve) => {
    pendingResponses.set(approvalId, (response) => {
      capture("file-approval-response", response);
      resolve(response);
    });
  });
}

function sendUnknownRequest() {
  const requestId = ++nextResponseId;
  send({ id: requestId, method: "some/unknownMethod", params: {} });
  return new Promise((resolve) => {
    pendingResponses.set(requestId, (response) => {
      capture("unknown-response", response);
      resolve(response);
    });
  });
}

async function handleTurnStart(responseId, params) {
  // Batch the start response and approval to deterministically exercise frame ordering.
  const prefix = [
    { id: responseId, result: { turn: { id: TURN_ID, items: [], status: "inProgress" } } },
    { method: "turn/started", params: { threadId: THREAD_ID, turn: { id: TURN_ID, items: [], status: "inProgress" } } },
  ];
  const threadId = process.env.WRONG_THREAD_APPROVAL === "1" ? "wrong-thread-id" : THREAD_ID;
  if (process.env.SEND_EXEC_APPROVAL === "1") await sendExecApproval(threadId, prefix);
  else for (const message of prefix) send(message);

  if (process.env.SEND_FILE_APPROVAL === "1") {
    await sendFileChangeApproval(threadId);
  }

  if (process.env.UNKNOWN_REQUEST === "1") {
    await sendUnknownRequest();
  }

  if (process.env.SLOW_TURN === "1") {
    // Stay alive until killed (for abort test)
    await new Promise(() => {});
  }

  // Send turn/completed
  const status = process.env.TURN_FAIL === "1" ? "failed" : "completed";
  const error = process.env.TURN_FAIL === "1" ? { message: "simulated_turn_failure" } : null;
  send({
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, items: [], status, error },
    },
  });
}
