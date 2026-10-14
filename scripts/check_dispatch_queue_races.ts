/**
 * Repeats the independent A/A/B repro with its original 2000/100/50 ms timing.
 * Run: deno run -A scripts/check_dispatch_queue_races.ts
 * Each transport/capacity combination runs 200 iterations by default.
 */
import {
  bounded,
  queueHarness,
} from "../tests/hypervisor/queue_regression_helpers.ts";

const iterations = Number(Deno.args[0] ?? 200);
if (!Number.isSafeInteger(iterations) || iterations < 1) {
  throw new TypeError("iterations must be positive");
}
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const encoder = new TextEncoder();

async function suite(transport: "in-process" | "websocket", capacity: number) {
  const idleTimes: number[] = [];
  for (let iteration = 1; iteration <= iterations; iteration++) {
    const h = await queueHarness(
      transport,
      async ({ input }) => {
        const ms = Number(await new Response(input).text());
        await sleep(ms);
        return encoder.encode("ok");
      },
      {},
      capacity,
    );
    const startedAt = performance.now();
    const completions: string[] = [];
    const tasks: Promise<void>[] = [];
    const run = async (label: string, target: string, ms: number) => {
      const result = await h.run({
        target: { workerId: target },
        body: encoder.encode(String(ms)),
      });
      if (result !== "ok") throw new Error(`unexpected output: ${result}`);
      completions.push(label);
      if (label === "B#1") idleTimes.push(performance.now() - startedAt);
    };
    try {
      for (let slot = 1; slot <= capacity; slot++) {
        tasks.push(run(`A#${slot}`, "A", 2000));
      }
      tasks.push(run("A#queued", "A", 100));
      tasks.push(
        (async () => {
          await sleep(50);
          await run("B#1", "B", 100);
        })(),
      );
      // Observe all rejections immediately, and bound the whole iteration.
      const results = await bounded(Promise.allSettled(tasks), 15_000);
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) {
        throw new Error(
          JSON.stringify(failures, (_, value) =>
            value instanceof Error
              ? { message: value.message, ...value }
              : value,
          ),
        );
      }
      if (completions[0] !== "B#1" || completions.at(-1) !== "A#queued") {
        throw new Error(
          `incorrect completion order: ${completions.join(", ")}`,
        );
      }
      if (
        h.hypervisor.snapshot().queuedDispatches !== 0 ||
        h.hypervisor.sessions.list().some((s) => s.reserved !== 0)
      ) {
        throw new Error("queue or reservation leaked");
      }
    } catch (error) {
      throw new Error(
        `${transport} capacity=${capacity} iteration=${iteration}`,
        { cause: error },
      );
    } finally {
      await Promise.allSettled(tasks);
      await h.close();
    }
    if (iteration % 25 === 0) {
      console.log(
        `${transport} capacity=${capacity}: ${iteration}/${iterations} passed`,
      );
    }
  }
  idleTimes.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      transport,
      capacity,
      passed: iterations,
      failed: 0,
      idleTargetMs: {
        median: Math.round(idleTimes[Math.floor(idleTimes.length / 2)]),
        p95: Math.round(
          idleTimes[
            Math.min(idleTimes.length - 1, Math.floor(idleTimes.length * 0.95))
          ],
        ),
        max: Math.round(idleTimes.at(-1)!),
      },
    }),
  );
}

const results = await Promise.allSettled([
  suite("in-process", 1),
  suite("in-process", 4),
  suite("websocket", 1),
  suite("websocket", 4),
]);
for (const result of results) {
  if (result.status === "rejected") console.error(result.reason);
}
if (results.some((result) => result.status === "rejected")) Deno.exit(1);
console.log(`All ${iterations * 4} A/A/B scenarios passed.`);
