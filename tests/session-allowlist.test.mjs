import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSessionAllowlist, updateSessionAllowlist } from "../scripts/session-allowlist.mjs";

const sessionId = "019f0000-0000-7000-8000-000000000001";

test("Session 白名单缺省拒绝并过滤非法 ID", () => {
  assert.deepEqual(normalizeSessionAllowlist(null), {
    version: 2,
    mode: "allowlist",
    threadIds: [],
  });
  assert.deepEqual(normalizeSessionAllowlist({ mode: "allowlist", threadIds: [sessionId, "bad", sessionId] }).threadIds, [sessionId]);
});

test("单 Session 更新保持其他白名单项且支持幂等退出", () => {
  const first = "019f0000-0000-7000-8000-000000000001";
  const second = "019f0000-0000-7000-8000-000000000002";
  const joined = updateSessionAllowlist({ threadIds: [first] }, second, true, "2026-08-22T00:00:00.000Z");
  assert.deepEqual(joined.threadIds, [first, second]);
  assert.deepEqual(updateSessionAllowlist(joined, first, false).threadIds, [second]);
  assert.deepEqual(updateSessionAllowlist(joined, "019f0000-0000-7000-8000-000000000003", false).threadIds, [first, second]);
  assert.deepEqual(updateSessionAllowlist({ threadIds: [] }, first.toUpperCase(), true).threadIds, [first]);
});

test("旧 all/selected 配置只迁移其中显式列出的 Session", () => {
  assert.deepEqual(normalizeSessionAllowlist({ mode: "all", threadIds: [] }), {
    version: 2,
    mode: "allowlist",
    threadIds: [],
    migratedFrom: "all",
  });
  assert.deepEqual(normalizeSessionAllowlist({ mode: "selected", threadIds: [sessionId] }), {
    version: 2,
    mode: "allowlist",
    threadIds: [sessionId],
    migratedFrom: "selected",
  });
});
