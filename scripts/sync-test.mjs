#!/usr/bin/env node

Object.assign(process.env, {
  CODEX_HOME: "tests/fixtures",
  TASKCENTER_SEED_PATH: "tests/fixtures/requirements.seed.json",
  TASKCENTER_SELECTION_PATH: "tests/fixtures/session-selection-all.json",
  TASKCENTER_DASHBOARD_PATH: ".local/test-dashboard.json",
});

await import("./sync-codex.mjs");
