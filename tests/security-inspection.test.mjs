import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectTrustedCli } from "../scripts/trusted-cli-inspection.mjs";

test("系统 security 仅允许精确签名身份及受限描述文件，拒绝路径与入口逃逸", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "security-inspection-"));
  const homeBefore = process.env.HOME, pathBefore = process.env.PATH;
  const identity = ["find-identity", "-v", "-p", "codesigning"];
  const check = args => inspectTrustedCli(["/usr/bin/security", ...args], {});
  try {
    process.env.HOME = root;
    process.env.PATH = "/usr/bin:/bin";
    for (const entry of ["security", "/usr/bin/security"]) {
      for (const prefix of [[], ["rtk", "proxy"], ["/opt/homebrew/bin/rtk", "proxy"]]) assert.equal(inspectTrustedCli([...prefix, entry, ...identity], {}), true);
    }
    const outside = join(root, "outside.mobileprovision");
    writeFileSync(outside, "fixture");
    for (const directory of ["Library/Developer/Xcode/UserData/Provisioning Profiles", "Library/MobileDevice/Provisioning Profiles"]) {
      const file = join(root, directory, "fixture.mobileprovision");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "fixture");
      assert.equal(check(["cms", "-D", "-i", file]), true);
      assert.equal(inspectTrustedCli(["rtk", "proxy", "security", "cms", "-D", "-i", file], {}), true);
      const link = join(dirname(file), "linked.mobileprovision");
      symlinkSync(outside, link);
      const directoryFile = join(dirname(file), "dir.mobileprovision");
      mkdirSync(directoryFile);
      for (const path of [link, directoryFile, file.replace("fixture.mobileprovision", "missing.mobileprovision"), file.replace("fixture.mobileprovision", "../fixture.mobileprovision")]) assert.equal(check(["cms", "-D", "-i", path]), false, path);
      for (const extra of [["-o", "out"], ["-k", "keychain"], ["-p", "password"], ["-E"]]) assert.equal(check(["cms", "-D", "-i", file, ...extra]), false);
      rmSync(dirname(file), { recursive: true });
      symlinkSync(root, dirname(file));
      assert.equal(check(["cms", "-D", "-i", join(dirname(file), "outside.mobileprovision")]), false);
      rmSync(dirname(file));
    }
    for (const args of [[], ["find-generic-password", "-w"], ["export"], ["unlock-keychain"], ["delete-keychain"], ["find-identity"], [...identity, "login.keychain-db"], ["find-identity", "-p", "codesigning", "-v"], ["cms", "-D", "-i", outside], ["cms", "-D", "-i", "relative.mobileprovision"], ["cms", "-D"]]) assert.equal(check(args), false, args.join(" "));
    for (const words of [["/tmp/security", ...identity], ["/tmp/rtk", "proxy", "security", ...identity], ["rtk", "security", ...identity], ["env", "HOME=/tmp", "security", ...identity]]) assert.notEqual(inspectTrustedCli(words, {}), true);
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "security"), "fake", { mode: 0o755 });
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    assert.equal(inspectTrustedCli(["security", ...identity], {}), false);
    assert.equal(check(identity), true);
  } finally {
    if (homeBefore === undefined) delete process.env.HOME; else process.env.HOME = homeBefore;
    if (pathBefore === undefined) delete process.env.PATH; else process.env.PATH = pathBefore;
    rmSync(root, { recursive: true, force: true });
  }
});
