import { spawn } from "node:child_process";
import { resolveSpawnCommand } from "./platform-command.mjs";

export class KimiAcp {
  constructor({ command = "kimi", env = process.env, cwd, permission = async () => null, update = () => {}, timeout = 60000 } = {}) {
    const resolved = resolveSpawnCommand(command, { env });
    this.child = spawn(resolved.command, [...resolved.argsPrefix, "acp"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.pending = new Map(); this.sequence = 0; this.buffer = ""; this.stderr = ""; this.timeout = timeout;
    this.permission = permission; this.update = update;
    this.child.stdout.on("data", chunk => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) { this.fail(new Error("ACP frame exceeds 4 MiB")); this.child.kill(); return; }
      let index;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
        if (line.trim()) this.receive(line).catch(error => { this.fail(error); this.child.kill(); });
      }
    });
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-4000); });
    this.child.stdin.on("error", error => this.fail(error));
    this.child.on("error", error => this.fail(error));
    this.child.on("exit", (code, signal) => this.fail(new Error(`Kimi ACP exited (${code ?? signal})`)));
  }
  send(value) { this.child.stdin.write(JSON.stringify(value) + "\n"); }
  request(method, params, timeout = this.timeout) {
    if (this.error) return Promise.reject(this.error);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`ACP timeout: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method, params) { if (!this.error) this.send({ jsonrpc: "2.0", method, params }); }
  async receive(line) {
    const message = JSON.parse(line);
    if (message.method && message.id !== undefined) {
      if (message.method === "session/request_permission") {
        const selected = await this.permission(message.params);
        const valid = message.params.options?.some(option => option.optionId === selected && option.kind === "allow_once");
        this.send({ jsonrpc: "2.0", id: message.id, result: { outcome: valid ? { outcome: "selected", optionId: selected } : { outcome: "cancelled" } } });
      } else this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported client capability" } });
    } else if (message.method === "session/update") this.update(message.params);
    else if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`ACP ${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
    }
  }
  fail(error) {
    this.error = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  async close() {
    this.fail(new Error("ACP closed"));
    this.child.stdin.end();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => this.child.kill("SIGKILL"), 2000);
      this.child.once("exit", () => { clearTimeout(timer); resolve(); });
      this.child.kill("SIGTERM");
    });
  }
}

export function reportedUsage(update) {
  if (update?.sessionUpdate !== "usage_update") return null;
  const numeric = value => Number.isFinite(value) && value >= 0 ? value : null;
  return { used: numeric(update.used), size: numeric(update.size), cost: numeric(update.cost?.amount), currency: typeof update.cost?.currency === "string" ? update.cost.currency : null };
}
