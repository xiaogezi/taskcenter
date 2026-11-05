import pino from "pino";
import { createStream } from "rotating-file-stream";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";

// One supervisor owns this namespace; child restarts never create competing rollers.
export async function createRuntimeLogger(directory, { size = "10m", count = 8 } = {}) {
  // 80 MiB here plus the launcher's two existing 10 MiB bootstrap files: about 100 MiB total.
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(directory).filter(name => /^runtime\.\d+\.log$/.test(name))) {
    if (Number(name.split(".")[1]) >= count && statSync(join(directory, name)).isFile()) unlinkSync(join(directory, name));
  }
  const destination = createStream(index => index == null ? "runtime.log" : `runtime.${index}.log`, {
    path: directory, size: size.toUpperCase(), rotate: count - 1, mode: 0o600,
  });
  let failed = false;
  let droppedBytes = 0;
  destination.on("error", () => {
    // Fixed, bounded fallback; do not redirect an unbounded child stream to bootstrap stderr.
    if (!failed) process.stderr.write('{"event":"runtime_logging_failed"}\n');
    failed = true;
  });
  const logger = pino({ base: { component: "supervisor", revision: process.env.TASKCENTER_RELEASE_REVISION || "worktree" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: ["data.authorization", "data.token", "data.password", "data.api_key", "data.headers.authorization", "data.cookie"],
  }, {
    write(data) {
      if (failed) return;
      if (destination.writableLength + Buffer.byteLength(data) > 1024 * 1024) {
        if (!droppedBytes) process.stderr.write('{"event":"runtime_logging_overflow"}\n');
        droppedBytes += Buffer.byteLength(data);
        return;
      }
      destination.write(data);
    },
  });
  destination.on("drain", () => {
    if (!failed && droppedBytes) {
      const bytes = droppedBytes;
      droppedBytes = 0;
      logger.warn({ event: "runtime_logging_resumed", dropped_bytes: bytes });
    }
  });
  function log(source, stream, message, truncated = false) {
    if (failed) return;
    // Preserve structured diagnostics as nested data, without letting children override envelope identity.
    let data;
    try { data = JSON.parse(message); } catch { /* ordinary subprocess output */ }
    const fields = { source, stream, ...(truncated ? { truncated: true } : {}) };
    if (data && typeof data === "object" && !Array.isArray(data)) fields.data = data;
    else fields.msg = message;
    logger.info(fields);
  }
  return {
    log,
    attach(input, source, stream) {
      const decoder = new StringDecoder("utf8");
      let pending = "", truncated = false;
      const consume = text => {
        for (const part of text.split(/(?<=\n)/)) {
          const end = part.endsWith("\n");
          const room = 16 * 1024 - pending.length;
          pending += part.slice(0, Math.max(0, room));
          if (part.length > room) truncated = true;
          if (end) { log(source, stream, pending.trimEnd(), truncated); pending = ""; truncated = false; }
        }
      };
      input.on("data", chunk => consume(decoder.write(chunk)));
      input.once("end", () => { consume(decoder.end()); if (pending) log(source, stream, pending, truncated); });
    },
    async close() {
      if (destination.destroyed) return;
      const closed = once(destination, "close");
      destination.end();
      await closed;
    },
  };
}
