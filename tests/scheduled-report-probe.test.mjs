import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectManagedReport } from "../scripts/scheduled-report-probe.mjs";

test("固定报告探针按 sha256-v1 排除 hash 行并 fail-closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taskcenter-report-probe-"));
  const report = join(dir, "report.md");
  try {
    const before = "\n# report\n\n";
    const after = "content\n";
    const hash = createHash("sha256").update(`${before}${after}`).digest("hex");
    await writeFile(report, `<!-- AUTO-MANAGED-BEGIN -->${before}- managed_payload_sha256：\`${hash}\`\n${after}<!-- AUTO-MANAGED-END -->\n`);
    assert.equal(inspectManagedReport(report).valid, true);
    await writeFile(report, `<!-- AUTO-MANAGED-BEGIN -->${before}- managed_payload_sha256：\`${hash}\`\nchanged\n<!-- AUTO-MANAGED-END -->\n`);
    const invalid = inspectManagedReport(report);
    assert.equal(invalid.valid, false);
    assert.equal(invalid.reason, "managed_payload_hash_mismatch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
