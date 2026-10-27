import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectTrustedCli } from "../scripts/trusted-cli-inspection.mjs";

test("ZIP 只读语义覆盖等价参数、跨文件与空格路径，实际执行不落盘", { skip: !existsSync("/usr/bin/zip") }, () => {
  const root = mkdtempSync(join(tmpdir(), "archive-inspection-"));
  const keys = ["PATH", "UNZIP", "UNZIPOPT", "ZIPINFO", "ZIPINFOOPT"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const check = words => inspectTrustedCli(words, { cwd: root, workspace: "/different/project" });
  try {
    for (const key of keys) delete process.env[key];
    process.env.PATH = "/usr/bin:/bin";
    const source = join(root, "source"), output = join(root, "output");
    mkdirSync(source); mkdirSync(output);
    mkdirSync(join(source, "notes"));
    const member = "notes/Read Me.md", content = "归档只读 fixture\n";
    writeFileSync(join(source, member), content);
    for (const filename of ["skills pack.zip", "other.ipa"]) {
      const archive = join(root, filename);
      execFileSync("/usr/bin/zip", ["-q", archive, member], { cwd: source });
      for (const [tool, options, print] of [
        ["unzip", ["-l"], false], ["unzip", ["-v"], false],
        ["unzip", ["-ql"], false], ["unzip", ["-lq"], false], ["unzip", ["-q", "-l"], false],
        ["unzip", ["-Z"], false], ["unzip", ["-Z1"], false], ["unzip", ["-Z", "-1"], false],
        ["unzip", ["-Z", "-lT"], false], ["zipinfo", [], false], ["zipinfo", ["-1"], false],
        ["zipinfo", ["-lT"], false], ["unzip", ["-p"], true], ["unzip", ["-q", "-p"], true],
        ["unzip", ["-pq"], true], ["unzip", ["-c"], true],
      ]) {
        const args = [...options, archive, ...(print ? [member] : [])];
        for (const entry of [tool, `/usr/bin/${tool}`]) {
          for (const prefix of [[], ["rtk", "proxy"], ["/opt/homebrew/bin/rtk", "proxy"]]) assert.equal(check([...prefix, entry, ...args]), true, [...prefix, entry, ...args].join(" "));
        }
        const text = execFileSync(`/usr/bin/${tool}`, args, { cwd: output, encoding: "utf8" });
        if (print) assert.ok(text.includes(content)); else assert.ok(text.includes(member));
        assert.deepEqual(readdirSync(output), []);
      }
      for (const args of [
        [archive], ["-q", archive], ["-p", archive], ["-l", "-p", archive, member],
        ["-o", archive], ["-n", archive], ["-T", archive], ["-lpT", archive, member],
        ["-l", archive, "-d", output], ["-p", archive, member, "-o"], ["-p", archive, "*"],
        ["-p", archive, "notes/[a].md"], ["-p", archive, ".env"], ["-l", archive, "-x", member],
        ["-P", "password", "-p", archive, member], ["-Zp", archive], ["-M", "-l", archive],
        ["--", "-l", archive], ["-l", "-"], ["-l", archive + "*"], ["-l", archive, "--unknown"],
      ]) assert.equal(check(["unzip", ...args]), false, args.join(" "));
      for (const args of [["-p", archive, member], ["-x", archive, member], ["-M", archive], ["-1", archive, "--unknown"]]) assert.equal(check(["zipinfo", ...args]), false);
      for (const words of [["/tmp/unzip", "-l", archive], ["/tmp/rtk", "proxy", "unzip", "-l", archive], ["rtk", "unzip", "-l", archive], ["env", "UNZIPOPT=-T", "unzip", "-l", archive]]) assert.notEqual(check(words), true);
      for (const key of keys.slice(1)) {
        process.env[key] = "-T";
        assert.equal(check(["unzip", "-l", archive]), false);
        assert.equal(check(["zipinfo", "-1", archive]), false);
        delete process.env[key];
      }
    }
    const bin = join(root, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "unzip"), "fake", { mode: 0o755 });
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    assert.equal(check(["unzip", "-l", "archive.zip"]), false);
    assert.equal(check(["/usr/bin/unzip", "-l", "archive.zip"]), true);
  } finally {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    rmSync(root, { recursive: true, force: true });
  }
});
