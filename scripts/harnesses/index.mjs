import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { codexAdapter } from "./codex.mjs";
import { kimiAdapter } from "./kimi.mjs";
import { claudeAdapter } from "./claude.mjs";

// Static registration is intentional: never load code or shell commands from request input.
const adapters = [codexAdapter, claudeAdapter,
  { id: "workbuddy", client: { label: "WorkBuddy", hooks: false, resume: false, usage: false }, identity: "explicit_host_binding_required", usageScope: "unknown", operations: {} },
  kimiAdapter,
  { id: "unknown", client: { label: "Unknown", hooks: false, resume: false, usage: false }, identity: "explicit_host_binding_required", usageScope: "unknown", operations: {} },
];
export const HARNESS_IDS = Object.freeze(adapters.map(adapter => adapter.id));
// Compatibility default for historical Codex-scanned dashboard entries only.
export const LEGACY_HARNESS_ID = "codex";
export const HARNESS_CLIENTS = Object.freeze(Object.fromEntries(adapters.map(adapter => [adapter.id, Object.freeze(adapter.client)])));
const registry = new Map(adapters.map(adapter => [adapter.id, adapter]));
const operations = ["createSession", "resumeSession", "inspectSession", "openSession", "cancelSession"];

export class HarnessError extends Error {
  constructor(code, message, statusCode = 409, outcome = "not_started", cause) {
    super(message, { cause }); this.code = code; this.statusCode = statusCode; this.outcome = outcome;
  }
}

function adapterFor(id) {
  const adapter = registry.get(id);
  if (!adapter) throw new HarnessError("HARNESS_UNKNOWN", `Unknown Harness: ${id}`, 400);
  return adapter;
}

export function harnessCapabilities(id) {
  const adapter = adapterFor(id);
  return {
    agent: id, ...adapter.client, task_protocol: true, trusted_identity: adapter.identity,
    usage_scope: adapter.usageScope,
    operations: Object.fromEntries(operations.map(operation => {
      const supported = Object.hasOwn(adapter.operations, operation);
      return [operation, { supported, availability: supported ? "unknown" : "unsupported",
        reason: supported ? "Adapter implemented; runtime connection and authorization are checked on invocation" : "This operation is not implemented by the adapter" }];
    })),
  };
}

export function dispatchHarnessId(record, sessions = {}) {
  const registered = sessions[record.threadId || record.contextThreadId];
  // A known but unsupported client must never silently fall back to Codex.
  return registered?.agent || record.harness || LEGACY_HARNESS_ID;
}

export function requireHarnessOperation(id, operation) {
  const adapter = adapterFor(id);
  if (!Object.hasOwn(adapter.operations, operation)) throw new HarnessError("HARNESS_UNSUPPORTED", `${adapter.client.label} 尚未适配 ${operation}`);
  return adapter.operations[operation];
}

// Internal invocation boundary. Callers still own authorization, task ownership and scheduling.
export async function invokeHarness(id, operation, input = {}) {
  const execute = requireHarnessOperation(id, operation);
  if (["resumeSession", "inspectSession"].includes(operation) && (typeof input.sessionId !== "string" || !input.sessionId.trim())) {
    throw new HarnessError("HARNESS_INVALID_INPUT", "A native sessionId is required", 400);
  }
  if (operation === "createSession" && input.sessionId) throw new HarnessError("HARNESS_INVALID_INPUT", "createSession cannot target an existing session", 400);
  if (["createSession", "resumeSession"].includes(operation)) {
    if (typeof input.prompt !== "string" || !input.prompt.trim() || typeof input.workingDirectory !== "string" ||
      !isAbsolute(input.workingDirectory) || !existsSync(input.workingDirectory) || !statSync(input.workingDirectory).isDirectory()) {
      throw new HarnessError("HARNESS_INVALID_INPUT", "Prompt and an existing absolute workingDirectory are required", 400);
    }
    if (input.signal?.aborted) throw new HarnessError("HARNESS_CANCELLED", "Request cancelled before invocation", 409);
  }
  const onEvent = event => {
    // An observer failure must not change execution or cause an automatic retry.
    try { input.onEvent?.({ ...event, harness: id, operation }); }
    catch (error) { console.error("Harness observer failed:", String(error.message).slice(0, 500)); }
  };
  try {
    const result = await execute({ ...input, onEvent });
    if (operation !== "inspectSession" && result.status !== "accepted") onEvent(result);
    return { ...result, harness: id, operation };
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    // Without a terminal receipt, a transport error cannot prove that execution did not occur.
    onEvent({ status: "unknown", sessionId: input.sessionId, message: String(error.message).slice(0, 500) });
    throw new HarnessError("HARNESS_OUTCOME_UNKNOWN", String(error.message).slice(0, 500), 502, "unknown", error);
  }
}
