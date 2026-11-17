import test from "node:test";
import assert from "node:assert/strict";
import { createWatcherSyncState } from "../scripts/watcher-sync-state.mjs";

const create = () => createWatcherSyncState({ quietPeriodMs: 20, maxSyncDelayMs: 30, retryBaseMs: 100, retryMaxMs: 400 });

test("失败不确认 fingerprint，无文件变化也有界重试并保留失败健康状态", () => {
  const state = create();
  state.observe("a", 0);
  assert.equal(state.start(0), "a");
  state.finish(false, 10, "exit 1");
  assert.equal(state.heartbeat().status, "failed");
  assert.equal(state.heartbeat().refreshOk, false);
  assert.equal(state.start(109), null);
  assert.equal(state.start(110), "a");
  assert.equal(state.heartbeat().refreshOk, false, "开始重试不等于成功恢复");
  state.finish(true, 120);
  assert.equal(state.heartbeat().status, "watching");
  assert.equal(state.heartbeat().refreshOk, true);
  assert.equal(state.start(999), null);
});

test("同步期间新变化保持 dirty，旧扫描成功不吞掉新 fingerprint", () => {
  const state = create();
  state.observe("a", 0); state.start(0);
  state.observe("b", 5);
  assert.equal(state.start(40), null, "仍在执行不能启动重叠扫描");
  state.finish(true, 50);
  assert.equal(state.start(51), "b", "新快照仍需扫描");
  state.finish(true, 60);
  assert.equal(state.start(100), null);
});

test("连续变化以最大延迟触发；失败退避有上限", () => {
  const state = create();
  state.observe("a", 0); state.start(0); state.finish(true, 1);
  state.observe("b", 5); state.observe("c", 20);
  assert.equal(state.start(34), null);
  assert.equal(state.start(35), "c");
  state.finish(false, 36);
  state.start(136); state.finish(false, 137);
  state.start(337); state.finish(false, 338);
  state.start(738); state.finish(false, 739);
  assert.equal(Date.parse(state.heartbeat().retryAt), 1139);
});

test("空目录 fingerprint 也能重试，初次未成功不宣称健康", () => {
  const state = create();
  assert.equal(state.heartbeat().refreshOk, false);
  state.observe("", 0);
  assert.equal(state.start(0), "");
  state.finish(false, 1, "spawn failed");
  assert.equal(state.start(101), "");
});
