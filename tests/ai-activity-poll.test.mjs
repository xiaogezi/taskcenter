import { test } from "node:test";
import assert from "node:assert/strict";
import { startActivityPoll } from "../features/console/activity-poll.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

test("AI activity waits for the pending poll before scheduling another", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = deferred(), second = deferred();
  const requests = [first, second];
  const values = [], errors = [];
  const stop = startActivityPoll(() => requests.shift().promise, value => values.push(value), error => errors.push(error));
  try {
    t.mock.timers.tick(0);
    t.mock.timers.tick(15_000);
    assert.deepEqual(requests, [second]);
    first.resolve("current");
    await first.promise;
    assert.deepEqual(values, ["current"]);
    t.mock.timers.tick(4_999);
    assert.deepEqual(requests, [second]);
    t.mock.timers.tick(1);
    assert.deepEqual(requests, []);
    second.reject(new Error("temporary failure"));
    await second.promise.catch(() => {});
    assert.equal(errors[0].message, "temporary failure");
  } finally { stop(); }
});

for (const outcome of ["resolve", "reject"]) {
  test(`AI activity drops a superseded response (${outcome}) even if the request ignored abort`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const old = deferred();
    const values = [], errors = [];
    let oldSignal, newSignal, reads = 0;
    const stopOld = startActivityPoll(signal => { oldSignal = signal; reads++; return old.promise; }, value => values.push(value), error => errors.push(error));
    t.mock.timers.tick(0);
    stopOld();
    assert.equal(oldSignal.aborted, true);
    const stopNew = startActivityPoll(async signal => { newSignal = signal; reads++; return "new source/cursor"; }, value => values.push(value), error => errors.push(error));
    try {
      t.mock.timers.tick(0);
      await Promise.resolve();
      old[outcome](new Error("old scope"));
      await old.promise.catch(() => {});
      assert.deepEqual(values, ["new source/cursor"]);
      assert.deepEqual(errors, []);
    } finally { stopNew(); }
    assert.equal(newSignal.aborted, true);
    t.mock.timers.tick(15_000);
    assert.equal(reads, 2);
  });
}
