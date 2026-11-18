import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearExitedOwnedCandidate, restoreOwnedCandidate } from "../scripts/service-deployment-policy.mjs";
import { isProcessTreeAlive } from "../scripts/process-tree.mjs";

test("真实已退出候选的匹配残留可清理并恢复，替换或占用不能清理", async () => {
  const root = mkdtempSync(join(tmpdir(), "taskcenter-exited-candidate-"));
  const path = join(root, "web-state.json");
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { detached: true, stdio: "ignore" });
  const pid = child.pid;
  await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  const expected = { pid, token: "fixture-owned-receipt" };
  const readCurrent = () => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  const write = state => writeFileSync(path, JSON.stringify(state));
  const clear = () => rmSync(path);
  try {
    write(expected);
    let restored = false;
    await restoreOwnedCandidate({
      candidate: expected, readCurrent,
      stopCandidate: async identity => {
        assert.equal(await clearExitedOwnedCandidate({ expected: identity, readCurrent,
          hasOccupants: async candidate => isProcessTreeAlive(candidate.pid), clear }), true);
      },
      assertVacant: async () => { assert.equal(readCurrent(), null); assert.equal(isProcessTreeAlive(pid), false); },
      restore: async () => { restored = true; },
    });
    assert.equal(restored, true);
    write(expected);
    assert.equal(await clearExitedOwnedCandidate({ expected, readCurrent, hasOccupants: async () => true, clear }), false);
    assert.deepEqual(readCurrent(), expected);
    // Simulate replacement during the awaited port/child check.
    const replacement = { pid, token: "different-generation" };
    await assert.rejects(() => clearExitedOwnedCandidate({ expected, readCurrent,
      hasOccupants: async () => { write(replacement); return false; }, clear,
    }), error => error.code === "TASKCENTER_RELEASE_IDENTITY_CHANGED");
    assert.deepEqual(readCurrent(), replacement);
    await assert.rejects(() => clearExitedOwnedCandidate({ expected, readCurrent,
      hasOccupants: async () => false, clear,
    }), error => error.code === "TASKCENTER_RELEASE_IDENTITY_CHANGED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
