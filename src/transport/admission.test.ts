import assert from "node:assert/strict";
import { test } from "node:test";
import { createSendAdmission } from "./admission.ts";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("send admission: a full queue holds later frames and keeps their order", async () => {
  const admission = createSendAdmission({ frames: 2, bytes: 1_000 });
  const started: number[] = [];
  const gates = Array.from({ length: 6 }, latch);
  const sends = gates.map((gate, index) =>
    admission.admit(1, undefined, async (release) => {
      started.push(index);
      await gate.promise;
      release();
      return index;
    }),
  );
  await Promise.resolve();
  assert.deepEqual(started, [0, 1]);
  gates[1]!.resolve();
  await sends[1];
  assert.deepEqual(started, [0, 1, 2]);
  for (const gate of gates) gate.resolve();
  assert.deepEqual(await Promise.all(sends), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
});

test("send admission: bytes are bounded too, and a later small frame never overtakes", async () => {
  const admission = createSendAdmission({ frames: 10, bytes: 10 });
  const started: string[] = [];
  const hold = latch();
  const first = admission.admit(8, undefined, async (release) => {
    started.push("first");
    await hold.promise;
    release();
  });
  const large = admission.admit(5, undefined, () => {
    started.push("large");
    return Promise.resolve();
  });
  const small = admission.admit(1, undefined, () => {
    started.push("small");
    return Promise.resolve();
  });
  await Promise.resolve();
  assert.deepEqual(started, ["first"]);
  hold.resolve();
  await Promise.all([first, large, small]);
  assert.deepEqual(started, ["first", "large", "small"]);
});

test("send admission: a waiting frame cancels alone; an admitted one is unaffected", async () => {
  const admission = createSendAdmission({ frames: 1, bytes: 100 });
  const hold = latch();
  const sent: string[] = [];
  const first = admission.admit(1, undefined, async (release) => {
    sent.push("first");
    await hold.promise;
    release();
  });
  const abort = new AbortController();
  let dropped = false;
  const cancelled = admission.admit(
    1,
    abort.signal,
    () => {
      sent.push("cancelled");
      return Promise.resolve();
    },
    () => void (dropped = true),
  );
  const last = admission.admit(1, undefined, () => {
    sent.push("last");
    return Promise.resolve();
  });
  abort.abort(new Error("caller gave up"));
  await assert.rejects(cancelled, /caller gave up/);
  assert.equal(dropped, true);
  hold.resolve();
  await Promise.all([first, last]);
  assert.deepEqual(sent, ["first", "last"]);
});

test("send admission: close fails waiting and later frames; oversized frames are refused", async () => {
  const admission = createSendAdmission({ frames: 1, bytes: 4 });
  await assert.rejects(
    admission.admit(5, undefined, () => Promise.resolve()),
    RangeError,
  );
  const hold = latch();
  const first = admission.admit(1, undefined, (release) =>
    hold.promise.finally(release),
  );
  const waiting = admission.admit(1, undefined, () => Promise.resolve());
  admission.close(new TypeError("closed"));
  await assert.rejects(waiting, /closed/);
  await assert.rejects(
    admission.admit(1, undefined, () => Promise.resolve()),
    /closed/,
  );
  hold.resolve();
  await first;
});
