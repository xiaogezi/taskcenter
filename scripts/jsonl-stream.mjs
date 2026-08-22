import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

const DEFAULT_MAX_LINE_BYTES = 2 * 1024 * 1024;

export async function consumeJsonl(path, options = {}) {
  const start = Math.max(0, Number(options.start || 0));
  const end = Number.isFinite(Number(options.end)) ? Number(options.end) : undefined;
  const maxLineBytes = Math.max(1024, Number(options.maxLineBytes || DEFAULT_MAX_LINE_BYTES));
  const onLine = typeof options.onLine === "function" ? options.onLine : () => {};
  if (end !== undefined && end < start) return { offset: start, lines: 0, skippedOversizedLines: 0 };

  const stream = createReadStream(path, { start, ...(end === undefined ? {} : { end }) });
  let parts = [];
  let lineBytes = 0;
  let offset = start;
  let lines = 0;
  let skippedOversizedLines = 0;
  let oversized = false;

  for await (const chunk of stream) {
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(10, cursor);
      const segmentEnd = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(cursor, segmentEnd);
      lineBytes += segment.length;
      if (!oversized && lineBytes <= maxLineBytes) {
        if (segment.length) parts.push(segment);
      } else if (!oversized) {
        oversized = true;
        parts = [];
      }

      if (newline === -1) break;
      offset += lineBytes + 1;
      lines += 1;
      if (oversized) skippedOversizedLines += 1;
      else if (lineBytes) await onLine(Buffer.concat(parts, lineBytes));
      parts = [];
      lineBytes = 0;
      oversized = false;
      cursor = newline + 1;
    }
  }

  return { offset, lines, skippedOversizedLines };
}

export async function jsonlCheckpointFingerprint(path, offset, maxBytes = 4096) {
  const end = Math.max(0, Number(offset || 0));
  const start = Math.max(0, end - Math.max(256, Number(maxBytes || 4096)));
  const buffer = Buffer.allocUnsafe(end - start);
  const handle = await open(path, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("hex");
  } finally {
    await handle.close();
  }
}
