import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTrustedInspectionEntry } from "../scripts/trusted-cli-identity.mjs";
import { isLocalControlRequest } from "../lib/control-proxy.mjs";

test("L0 executable identity rejects project paths and PATH shadowing", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "taskcenter-identity-"));
  try {
    const executable = join(directory, "cat");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o700);
    assert.equal(isTrustedInspectionEntry(executable), false);
    assert.equal(isTrustedInspectionEntry("./cat", { cwd: directory }), false);
    assert.equal(isTrustedInspectionEntry("cat", { cwd: directory, path: `${directory}:/bin:/usr/bin` }), false);
    assert.equal(isTrustedInspectionEntry("cat", { cwd: directory, path: ":/bin:/usr/bin" }), false);
    assert.equal(isTrustedInspectionEntry("/bin/cat"), true);
    await symlink("/bin/cat", join(directory, "alias-cat"));
    assert.equal(isTrustedInspectionEntry(join(directory, "alias-cat")), false);
    assert.equal(isTrustedInspectionEntry("command"), true);
    assert.equal(isTrustedInspectionEntry(join(directory, "command")), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Control proxy accepts local authority only and rejects cross-origin requests", () => {
  const request = (url, host, origin) => ({ url, headers: new Headers({ ...(host ? { host } : {}), ...(origin === undefined ? {} : { origin }) }) });
  for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
    const url = `http://${host}`;
    assert.equal(isLocalControlRequest(request(`${url}/api/control/tasks`, host, url), { requireOrigin: true }), true);
    assert.equal(isLocalControlRequest(request(url, host)), true);
    assert.equal(isLocalControlRequest(request(url, host), { requireOrigin: true }), false);
    for (const origin of ["https://attacker.example", "null", "http://localhost:9999", ""]) {
      assert.equal(isLocalControlRequest(request(url, host, origin)), false);
    }
  }
  for (const host of ["192.168.1.2:3000", "attacker.example:3000", "localhost.attacker.example:3000"]) {
    assert.equal(isLocalControlRequest(request(`http://${host}`, host, `http://${host}`)), false);
  }
  assert.equal(isLocalControlRequest(request("http://localhost:3000", "attacker.example")), false);
  assert.equal(isLocalControlRequest(request("http://localhost:3000", null)), false);
});

test("Windows L0 identity remains fail-closed pending a trusted installation inventory", { skip: process.platform !== "win32" }, () => {
  assert.equal(isTrustedInspectionEntry("cat"), false);
  assert.equal(isTrustedInspectionEntry("command"), false);
});
