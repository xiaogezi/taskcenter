// A fingerprint is acknowledged only by a successful sync for that snapshot.
// This small state machine is independent of timers/processes for regression tests.
export function createWatcherSyncState({ quietPeriodMs, maxSyncDelayMs, retryBaseMs = 1000, retryMaxMs = 30000 }) {
  let observed = null;
  let completed = null;
  let running = null;
  let pendingSince = 0;
  let changedSince = null;
  let failures = 0;
  let retryAt = 0;
  let lastError = "";
  let lastSuccessAt = "";
  return {
    observe(fingerprint, now) {
      if (fingerprint !== observed) { observed = fingerprint; pendingSince = now; }
      if (observed !== completed && changedSince === null) changedSince = now;
      if (observed === completed && !failures) changedSince = null;
    },
    shouldStart(now) {
      if (running !== null || observed === null) return false;
      if (failures) return now >= retryAt;
      return completed === null || observed !== completed
        && (now - pendingSince >= quietPeriodMs || now - changedSince >= maxSyncDelayMs);
    },
    start(now) {
      if (!this.shouldStart(now)) return null;
      running = observed;
      return running;
    },
    finish(ok, now, error = "") {
      if (running === null) return;
      if (ok) {
        completed = running;
        failures = 0;
        retryAt = 0;
        lastError = "";
        lastSuccessAt = new Date(now).toISOString();
        if (observed === completed) changedSince = null;
      } else {
        failures += 1;
        lastError = error || "sync_failed";
        retryAt = now + Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(failures - 1, 10));
      }
      running = null;
    },
    heartbeat() {
      return { status: running !== null ? "syncing" : failures ? "failed" : "watching",
        refreshOk: failures ? false : Boolean(lastSuccessAt), lastSuccessAt,
        lastRefreshError: lastError, retryAt: retryAt ? new Date(retryAt).toISOString() : "" };
    },
  };
}
