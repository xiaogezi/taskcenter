import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { launchActiveMcp, resolveActiveMcp } from "../scripts/taskcenter-mcp-launcher.mjs";

const revisionA = "a".repeat(40);
const revisionB = "b".repeat(40);

test("launcher resolves the current immutable release and follows later cutovers", (t) => {
  const fixture = createFixture(t);
  const releaseA = fixture.addRelease(revisionA);
  fixture.activate(releaseA);
  assert.equal(resolveActiveMcp(fixture.options).entryPath, join(releaseA.sourceRoot, "scripts/taskcenter-mcp.mjs"));

  const releaseB = fixture.addRelease(revisionB);
  fixture.activate(releaseB);
  const resolved = resolveActiveMcp(fixture.options);
  assert.equal(resolved.sourceRoot, releaseB.sourceRoot);
  assert.equal(resolved.revision, revisionB);
});

test("launcher spawns Node in the release root and binds the controller MCP credential", (t) => {
  const fixture = createFixture(t);
  const release = fixture.addRelease(revisionA);
  fixture.activate(release);
  const calls = [];
  const child = new EventEmitter();
  child.kill = () => true;
  const environment = { TASKCENTER_TEST: "1" };
  launchActiveMcp({
    ...fixture.options,
    environment,
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    },
  });
  child.emit("exit", 0, null);
  assert.deepEqual(calls, [{
    command: process.execPath,
    args: [join(release.sourceRoot, "scripts/taskcenter-mcp.mjs")],
    options: {
      cwd: release.sourceRoot,
      env: {
        ...environment,
        TASKCENTER_MCP_TOKEN_PATH: join(fixture.root, ".local/runtime/mcp-token"),
      },
      stdio: "inherit",
    },
  }]);
});

test("launcher preserves an explicitly configured MCP credential path", (t) => {
  const fixture = createFixture(t);
  const release = fixture.addRelease(revisionA);
  fixture.activate(release);
  const child = new EventEmitter();
  child.kill = () => true;
  const calls = [];
  const configuredPath = join(fixture.root, "custom-runtime/mcp-token");

  launchActiveMcp({
    ...fixture.options,
    environment: { TASKCENTER_MCP_TOKEN_PATH: configuredPath },
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    },
  });
  child.emit("exit", 0, null);

  assert.equal(calls[0].options.env.TASKCENTER_MCP_TOKEN_PATH, configuredPath);
});

test("launcher rejects missing, corrupt, and inconsistent active metadata", (t) => {
  const fixture = createFixture(t);
  assert.throws(() => resolveActiveMcp(fixture.options), /active release 不可读取/u);
  writeFileSync(fixture.activeReleasePath, "not-json");
  assert.throws(() => resolveActiveMcp(fixture.options), /不是有效 JSON/u);

  const release = fixture.addRelease(revisionA);
  fixture.activate({ ...release, releaseId: "wrong" });
  assert.throws(() => resolveActiveMcp(fixture.options), /releaseId 与 revision 不一致/u);
});

test("launcher rejects a mismatched release marker and missing or empty MCP entries", (t) => {
  const fixture = createFixture(t);
  const release = fixture.addRelease(revisionA);
  fixture.activate(release);
  writeFileSync(join(release.sourceRoot, ".taskcenter-release.json"), JSON.stringify({
    ...releaseMarker(release),
    revision: revisionB,
  }));
  assert.throws(() => resolveActiveMcp(fixture.options), /release marker 与 active release 不一致/u);

  writeFileSync(join(release.sourceRoot, ".taskcenter-release.json"), JSON.stringify(releaseMarker(release)));
  const entryPath = join(release.sourceRoot, "scripts/taskcenter-mcp.mjs");
  rmSync(entryPath);
  assert.throws(() => resolveActiveMcp(fixture.options), /MCP entry 不可读取/u);
  writeFileSync(entryPath, "");
  assert.throws(() => resolveActiveMcp(fixture.options), /MCP entry 不能为空文件/u);
});

test("launcher rejects releases outside the managed root and symlinked release paths", (t) => {
  const fixture = createFixture(t);
  const outsideRoot = join(fixture.root, "outside");
  const outside = fixture.addRelease(revisionA, outsideRoot);
  fixture.activate(outside);
  assert.throws(() => resolveActiveMcp(fixture.options), /必须位于/u);

  const real = fixture.addRelease(revisionB);
  const linkedRoot = join(fixture.releasesRoot, "linked-release");
  symlinkSync(real.sourceRoot, linkedRoot, "dir");
  fixture.activate({ ...real, sourceRoot: linkedRoot });
  assert.throws(() => resolveActiveMcp(fixture.options), /非符号链接目录/u);
});

test("launcher rejects symlinked metadata, marker, and MCP entry files", (t) => {
  const fixture = createFixture(t);
  const release = fixture.addRelease(revisionA);
  const activeTarget = join(fixture.root, "active-target.json");
  fixture.activate(release, activeTarget);
  symlinkSync(activeTarget, fixture.activeReleasePath);
  assert.throws(() => resolveActiveMcp(fixture.options), /非符号链接的普通文件/u);
  rmSync(fixture.activeReleasePath);
  fixture.activate(release);

  const markerPath = join(release.sourceRoot, ".taskcenter-release.json");
  const markerTarget = join(release.sourceRoot, "marker-target.json");
  writeFileSync(markerTarget, JSON.stringify(releaseMarker(release)));
  rmSync(markerPath);
  symlinkSync(markerTarget, markerPath);
  assert.throws(() => resolveActiveMcp(fixture.options), /release marker 必须是非符号链接/u);
  rmSync(markerPath);
  writeFileSync(markerPath, JSON.stringify(releaseMarker(release)));

  const entryPath = join(release.sourceRoot, "scripts/taskcenter-mcp.mjs");
  const entryTarget = join(release.sourceRoot, "scripts/entry-target.mjs");
  writeFileSync(entryTarget, "");
  rmSync(entryPath);
  symlinkSync(entryTarget, entryPath);
  assert.throws(() => resolveActiveMcp(fixture.options), /MCP entry 必须是非符号链接/u);
});

function createFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "taskcenter-mcp-launcher-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const releasesRoot = join(root, ".local/releases");
  const runtimeRoot = join(root, ".local/runtime");
  const activeReleasePath = join(runtimeRoot, "active-release.json");
  mkdirSync(releasesRoot, { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  return {
    root,
    releasesRoot,
    activeReleasePath,
    options: { projectRoot: root, releasesRoot, activeReleasePath },
    addRelease(revision, parent = releasesRoot) {
      const releaseId = revision.slice(0, 12);
      const sourceRoot = join(parent, releaseId);
      mkdirSync(join(sourceRoot, "scripts"), { recursive: true });
      const release = { sourceRoot: resolve(sourceRoot), revision, releaseId };
      writeFileSync(join(sourceRoot, ".taskcenter-release.json"), JSON.stringify(releaseMarker(release)));
      writeFileSync(join(sourceRoot, "scripts/taskcenter-mcp.mjs"), "export {};\n");
      return release;
    },
    activate(release, path = activeReleasePath) {
      writeFileSync(path, JSON.stringify(release));
    },
  };
}

function releaseMarker(release) {
  return {
    schemaVersion: "taskcenter-release/v1",
    revision: release.revision,
    releaseId: release.releaseId,
  };
}
