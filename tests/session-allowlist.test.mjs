import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSessionAllowlist } from "../scripts/session-allowlist.mjs";

const sessionId = "019f0000-0000-7000-8000-000000000001";

test("Session 白名单缺省拒绝并过滤非法 ID", () => {
  assert.deepEqual(normalizeSessionAllowlist(null), {
    version: 2,
    mode: "allowlist",
    threadIds: [],
  });
  assert.deepEqual(normalizeSessionAllowlist({ mode: "allowlist", threadIds: [sessionId, "bad", sessionId] }).threadIds, [sessionId]);
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
