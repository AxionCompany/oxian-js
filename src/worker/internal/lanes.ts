import type { HostCallChannel } from "../../work/host-call-channel.ts";
import { createHostCallError } from "../../work/host-call.ts";
import { createDeferred } from "./async.ts";

/** One ready connection that can carry worker-to-host calls. */
export type HostLane = Readonly<{
  channel: HostCallChannel;
  /** Ready and not draining: it may open calls for any parent, or none. */
  open(): boolean;
  /** Streams this connection may still open before its lifetime runs out. */
  remaining(): number;
  /** Called after a call opened on it, so it can ask for a successor in time. */
  opened(): void;
}>;

export type HostLanes = ReturnType<typeof createHostLanes>;

/**
 * Routes worker-to-host calls across a Worker's live connections.
 *
 * The newest open connection takes new calls, so a successor relieves its
 * predecessor at once. A parent's own connection still serves it while it has
 * streams left, even while draining. When neither can, a call waits for the
 * successor instead of failing.
 */
export function createHostLanes() {
  const lanes: HostLane[] = [];
  let changed = createDeferred<void>();
  const touch = (): void => {
    const previous = changed;
    changed = createDeferred<void>();
    previous.resolve(undefined);
  };

  const pick = (own?: HostLane): HostLane | undefined => {
    for (let index = lanes.length - 1; index >= 0; index--) {
      const lane = lanes[index]!;
      if (lane.open() && lane.remaining() > 0) return lane;
    }
    return own !== undefined && lanes.includes(own) && own.remaining() > 0
      ? own
      : undefined;
  };

  /** Waits until a lane can carry the call, or its signal or deadline ends. */
  const wait = async (
    own: HostLane | undefined,
    waiting: () => boolean,
    signal: AbortSignal,
    deadlineAtMs: number,
    now: () => number,
  ): Promise<HostLane | undefined> => {
    for (;;) {
      const lane = pick(own);
      if (lane !== undefined || !waiting()) return lane;
      if (signal.aborted) throw createHostCallError("cancelled", "not_started");
      const remaining = deadlineAtMs - now();
      if (remaining <= 0)
        throw createHostCallError("deadline_exceeded", "not_started");
      const next = changed.promise;
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, remaining);
        signal.addEventListener("abort", done, { once: true });
        void next.then(done);
      });
    }
  };

  return Object.freeze({
    add(lane: HostLane): void {
      lanes.push(lane);
      touch();
    },
    remove(lane: HostLane): void {
      const index = lanes.indexOf(lane);
      if (index >= 0) lanes.splice(index, 1);
      touch();
    },
    /** Wakes waiting calls after a lane opened, drained or ran out. */
    touch,
    pick,
    wait,
    newest: (): HostLane | undefined => lanes.at(-1),
    /** A parent's calls may run on any connection once it hands off. */
    cancelParent(streamId: string): void {
      for (const lane of [...lanes]) lane.channel.cancelParent(streamId);
    },
  });
}
