import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolveSpawnCommand } from "../platform-command.mjs";

const LOG_LIMIT = 16 * 1024 * 1024;
const RPC_TIMEOUT_MS = 30_000;
const KILL_ESCALATION_MS = 5_000;
const MAX_PARTIAL_JSON = 2 * 1024 * 1024;

const STRIPPED_ENV_KEYS = ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "TASKCENTER_CALLER_SESSION_ID", "TASKCENTER_MANAGED_REVIEW"];

/**
 * Invocation descriptor for `codex app-server --stdio`.
 * Only strips inherited identity; never injects MCP approval overrides or
 * sandbox bypass flags.
 */
export function codexAppServerInvocation(env = process.env) {
  const childEnv = { ...env };
  for (const key of STRIPPED_ENV_KEYS) delete childEnv[key];
  return { args: ["app-server", "--stdio"], env: childEnv };
}

const TRUSTED_HOOK_STATUSES = new Set(["trusted", "managed"]);

/**
 * Fail closed unless an enabled, trusted/managed, synchronous command hook
 * runs `taskcenter-hook.mjs pre-tool-use --agent codex` (not the scheduled
 * variant) and its matcher covers BOTH exec_command and apply_patch for this
 * workspace without hook load errors.
 */
function assertCodexHookCoverage(response, workspace) {
  const entries = Array.isArray(response?.data) ? response.data : null;
  if (entries) {
    for (const entry of entries) {
      if (!entry || entry.cwd !== workspace) continue;
      if (Array.isArray(entry.errors) && entry.errors.length > 0) continue;
      for (const hook of Array.isArray(entry.hooks) ? entry.hooks : []) {
        if (hook?.eventName !== "preToolUse" || hook?.handlerType !== "command") continue;
        if (hook.enabled !== true || hook.async !== false) continue;
        if (!TRUSTED_HOOK_STATUSES.has(hook.trustStatus)) continue;
        const command = String(hook.command || "");
        if (!command.includes("taskcenter-hook.mjs") || !command.includes("pre-tool-use")) continue;
        if (!command.includes("--agent codex") || command.includes("scheduled-pre-tool-use")) continue;
        let matcher;
        try { matcher = new RegExp(String(hook.matcher ?? "")); } catch { continue; }
        if (matcher.test("exec_command") && matcher.test("apply_patch")) return;
      }
    }
  }
  throw new Error(`CLI_CODEX_HOOK_COVERAGE: ${workspace} 缺少覆盖 exec_command 与 apply_patch 的同步可信 pre-tool-use Codex 钩子，已拒绝在自动放行沙箱中启动`);
}

/**
 * Run a delegated Codex task via `codex app-server --stdio` JSON-RPC.
 *
 * Protocol sequence:
 *   initialize → initialized → hooks/list (fail-closed coverage preflight) →
 *   thread/start (verify exact model) → onSessionReady(thread.id) →
 *   turn/start(prompt) → await turn/completed notification
 *
 * Only command approvals with an exact thread identity, kind=command and a
 * non-empty command/cwd reach authorizeTool("Bash", { command, cwd }), and
 * only after the delegation claim succeeded. File-change, permission and
 * unknown server requests are always denied (unknown ones with JSON-RPC
 * -32601).
 */
export async function runCodexDelegated({ manifest, profile, prompt, signal, logPath, onSessionReady, update, authorizeTool }) {
  if (signal?.aborted) throw new Error("CODEX_ABORTED");
  const { args, env } = codexAppServerInvocation();
  const executable = env.TASKCENTER_CODEX_COMMAND
    ? {
      command: env.TASKCENTER_CODEX_COMMAND,
      argsPrefix: (() => {
        const raw = env.TASKCENTER_CODEX_PREFIX_ARGS;
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.some((a) => typeof a !== "string")) {
          throw new Error("CODEX_PREFIX_ARGS_INVALID: expected a JSON string array");
        }
        return parsed;
      })(),
    }
    : resolveSpawnCommand("codex", { env });
  const child = spawn(executable.command, [...executable.argsPrefix, ...args], {
    cwd: manifest.workspace,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let logBytes = 0;
  const logChunk = (text) => {
    logBytes += Buffer.byteLength(text);
    if (logBytes <= LOG_LIMIT) appendFileSync(logPath, text);
  };

  // --- JSON-RPC transport state ---
  let nextId = 0;
  const pending = new Map();      // id → { method, resolve, reject, timer }
  const listeners = new Map();    // method → Set<callback>
  let partialBuf = "";
  let serverThreadId = null;
  let claimed = false;
  let fatalError = null;

  const write = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");

  child.stdin.on("error", (err) => {
    fail(err instanceof Error ? err : new Error(String(err)));
  });

  function rejectAllPending(error) {
    for (const [, entry] of pending) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  }

  function fail(error) {
    if (!fatalError) fatalError = error;
    rejectAllPending(fatalError);
    kill();
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    logChunk(chunk);
    partialBuf += chunk;
    if (partialBuf.length > MAX_PARTIAL_JSON) {
      partialBuf = "";
      fail(new Error("CODEX_STDIO_PARTIAL_LIMIT"));
      return;
    }
    let nl;
    while ((nl = partialBuf.indexOf("\n")) >= 0) {
      const line = partialBuf.slice(0, nl);
      partialBuf = partialBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch {
        fail(new Error("CODEX_STDIO_INVALID_JSON"));
        return;
      }
      update?.(msg);
      // RPC response: has id but no method. A server request may reuse the
      // same id, so anything carrying a method is never treated as a response.
      if (msg.method == null && msg.id != null && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(`CODEX_RPC_ERROR: ${msg.error.message || JSON.stringify(msg.error)}`));
        else {
          // Bind the matched response before processing an approval in the same chunk.
          if (entry.method === "turn/start") {
            const turnId = msg.result?.turn?.id;
            if (typeof turnId !== "string" || !turnId) {
              entry.reject(new Error("CODEX_NO_TURN_ID"));
              continue;
            }
            currentTurnId = turnId;
          }
          entry.resolve(msg.result);
        }
        continue;
      }
      if (msg.method != null && msg.id != null) {
        handleServerRequest(msg).catch((err) => {
          fail(err instanceof Error ? err : new Error(String(err)));
        });
        continue;
      }
      const cbs = listeners.get(msg.method);
      if (cbs) for (const cb of cbs) cb(msg);
    }
  });

  child.stderr.on("data", logChunk);

  function request(method, params) {
    if (fatalError) return Promise.reject(fatalError);
    if (closed) return Promise.reject(new Error(`CODEX_PROCESS_CLOSED: cannot send ${method}`));
    if (signal?.aborted) return Promise.reject(new Error("CODEX_ABORTED"));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CODEX_RPC_TIMEOUT: ${method}`));
      }, RPC_TIMEOUT_MS);
      pending.set(id, { method, resolve, reject, timer });
      write({ id, method, params });
    });
  }

  function notify(method, params) {
    if (fatalError || closed || signal?.aborted) return;
    write({ method, params });
  }

  function on(method, callback) {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(callback);
  }

  // --- Process lifecycle ---
  let closed = false;
  const exitP = new Promise((resolve) => {
    child.once("close", (code, sig) => { closed = true; resolve({ code, signal: sig }); });
    child.once("error", (err) => { if (!closed) { closed = true; resolve({ code: 1, signal: null, error: err }); } });
  });

  function kill() {
    if (closed) return;
    child.kill("SIGTERM");
    const esc = setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, KILL_ESCALATION_MS);
    exitP.then(() => clearTimeout(esc));
  }

  exitP.then((exit) => {
    if (!fatalError && !signal?.aborted) {
      fatalError = new Error(`CODEX_PROCESS_EXIT: code=${exit.code} signal=${exit.signal}`);
    }
    rejectAllPending(fatalError || new Error(`CODEX_PROCESS_EXIT: code=${exit.code} signal=${exit.signal}`));
  });

  function onAbort() {
    fail(new Error("CODEX_ABORTED"));
    settleTurn();
  }
  signal.addEventListener("abort", onAbort, { once: true });

  // --- Turn outcome tracking ---
  let turnStatus = "unknown";
  let turnError = null;
  let currentTurnId = null;
  let earlyCompletion = null; // turn/completed seen before turn/start response
  let settleTurn;
  const turnDone = new Promise((resolve) => { settleTurn = resolve; });

  on("turn/completed", (msg) => {
    const p = msg.params;
    if (p?.threadId !== serverThreadId) return;
    const turnId = p.turn?.id;
    if (currentTurnId == null) {
      // Completion arrived before the turn/start response; validate it later.
      if (typeof turnId === "string" && turnId) earlyCompletion = p;
      return;
    }
    if (turnId !== currentTurnId) return;
    turnStatus = p.turn?.status === "completed" ? "completed" : "failed";
    turnError = p.turn?.error?.message || null;
    settleTurn();
  });

  on("error", (msg) => {
    const p = msg.params;
    if (p?.threadId === serverThreadId) {
      turnStatus = "failed";
      turnError = p.error?.message || "server_error";
      settleTurn();
    }
  });

  exitP.then(() => settleTurn());

  // --- Approval routing ---
  function decline(msg) {
    write({ id: msg.id, result: { decision: "decline" } });
  }

  async function handleServerRequest(msg) {
    if (msg.method === "item/commandExecution/requestApproval") {
      await handleCommandApproval(msg);
      return;
    }
    // File-change / permission grants are denied until real patch paths are
    // available; itemId/grantRoot must never be treated as a file path.
    if (msg.method === "item/fileChange/requestApproval" || msg.method === "item/permissions/requestApproval" || msg.method === "tool_request_user_input") {
      decline(msg);
      return;
    }
    write({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }

  async function handleCommandApproval(msg) {
    const p = msg.params || {};
    let decision = "decline";
    // Any permission/policy amendment payload is never auto-approved.
    const hasAmendments = p.additionalPermissions != null
      || p.networkApprovalContext != null
      || p.proposedNetworkPolicyAmendments != null
      || p.proposedExecpolicyAmendment != null;
    if (claimed && p.threadId === serverThreadId && p.turnId === currentTurnId && p.kind === "command"
      && typeof p.command === "string" && p.command.trim() && typeof p.cwd === "string" && p.cwd.trim()
      && !hasAmendments && typeof authorizeTool === "function") {
      try {
        if (await authorizeTool("Bash", { command: p.command, cwd: p.cwd })) decision = "accept";
      } catch { /* authorization failure stays denied */ }
    }
    write({ id: msg.id, result: { decision } });
  }

  try {
    // --- Phase 1: initialize → initialized ---
    const initResult = await request("initialize", {
      clientInfo: { name: "taskcenter_delegated", version: "2" },
      capabilities: { experimentalApi: true },
    });
    update?.({ type: "rpc.initialize", result: initResult });
    notify("initialized", {});

    // --- Phase 2: fail-closed hook coverage preflight (before any model tokens) ---
    const hooks = await request("hooks/list", { cwds: [manifest.workspace] });
    assertCodexHookCoverage(hooks, manifest.workspace);
    update?.({ type: "hooks.verified" });

    // --- Phase 3: thread/start ---
    const threadResult = await request("thread/start", {
      model: profile.model,
      config: { model: profile.model, model_reasoning_effort: profile.effort },
      sandbox: manifest.mode === "read-only" ? "read-only" : "workspace-write",
      cwd: manifest.workspace,
      approvalPolicy: "on-request",
    });

    const thread = threadResult?.thread;
    if (!thread?.id) throw new Error("CODEX_NO_THREAD_ID");

    const returnedModel = threadResult.model ?? thread.model;
    if (typeof returnedModel !== "string" || !returnedModel) throw new Error("CODEX_MODEL_MISSING");
    if (returnedModel !== profile.model) {
      throw new Error(`CODEX_MODEL_MISMATCH: requested=${profile.model} returned=${returnedModel}`);
    }

    serverThreadId = thread.id;
    update?.({ type: "thread.started", thread_id: thread.id, model: returnedModel });

    // --- Phase 4: claim (onSessionReady) ---
    await onSessionReady({ taskcenterSessionId: thread.id });
    claimed = true;

    // --- Phase 5: turn/start ---
    await request("turn/start", {
      threadId: serverThreadId,
      effort: profile.effort,
      input: [{ type: "text", text: prompt }],
    });

    // A completion that raced ahead of the turn/start response only counts
    // when it matches this exact turn and thread.
    if (earlyCompletion && earlyCompletion.turn?.id === currentTurnId
      && earlyCompletion.threadId === serverThreadId && turnStatus === "unknown") {
      turnStatus = earlyCompletion.turn?.status === "completed" ? "completed" : "failed";
      turnError = earlyCompletion.turn?.error?.message || null;
      settleTurn();
    }
    earlyCompletion = null;

    await turnDone;

    return {
      status: signal.aborted ? "cancelled" : (turnStatus === "completed" && !fatalError) ? "completed" : "failed",
      sessionId: serverThreadId,
      reportedModels: [returnedModel],
      summary: turnError ? `Turn error: ${turnError}` : "Codex delegated execution",
      rawStatus: turnStatus,
    };
  } finally {
    signal.removeEventListener("abort", onAbort);
    rejectAllPending(fatalError || new Error("CODEX_PROCESS_EXIT"));
    if (!closed) kill();
    await exitP;
  }
}
