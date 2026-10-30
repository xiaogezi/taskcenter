import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isReadOnlyJugg } from "../scripts/jugg-inspection.mjs";

test("Jugg 仅透传版本或设备列表查询，安装产物变化立即拒绝", async () => {
  const home = await mkdtemp(join(tmpdir(), "jugg-inspection-"));
  try {
    const installed = join(home, ".local/bin/jugg-env");
    await mkdir(join(home, ".local/bin"), { recursive: true });
    const content = "#!/bin/sh\nexec \"$@\"\n";
    await writeFile(installed, content);
    await chmod(installed, 0o755);
    const context = { home, sha256: createHash("sha256").update(content).digest("hex") };
    for (const args of [["version"], ["devices"], ["devices", "-l"]]) {
      assert.equal(isReadOnlyJugg([installed, "adb", ...args], context), true);
    }
    for (const tokens of [
      [installed, "adb", "shell", "id"], [installed, "adb", "reboot"],
      [installed, "adb", "devices", "-l", "extra"], [installed, "python3", "-c", "pass"],
      ["jugg-env", "adb", "devices"], ["/tmp/jugg-env", "adb", "devices"],
    ]) assert.equal(isReadOnlyJugg(tokens, context), false, tokens.join(" "));
    await writeFile(installed, content + "touch sentinel\n");
    assert.equal(isReadOnlyJugg([installed, "adb", "devices"], context), false);
  } finally { await rm(home, { recursive: true, force: true }); }
});
