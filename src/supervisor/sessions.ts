import type { WorkerIdentity } from "../protocol/types.ts";
import {
  expectFiniteTimestamp,
  expectIdentifier,
  expectWorkload,
  fail,
  freeze,
  sameIdentity,
} from "./internal.ts";
import {
  createSessionFence,
  createWorkDispatchTarget,
  createWorkerSession,
  sessionFence,
} from "./state.ts";
import type {
  SessionFence,
  WorkDispatchTarget,
  WorkerSession,
} from "./types.ts";

export type SessionAttachment = Readonly<{
  session: WorkerSession;
  replaced?: WorkerSession;
  /**
   * The predecessor named by `retire`. It is no longer routable but stays
   * valid for its own frames until its streams finish (make-before-break).
   */
  retired?: WorkerSession;
  /** Retiring sessions closed because a newer attempt or epoch attached. */
  superseded?: readonly WorkerSession[];
}>;

export type SessionLease = Readonly<{
  fence: SessionFence;
  snapshot(): WorkerSession;
  isCurrent(): boolean;
  assertCurrent(): WorkerSession;
}>;

export type SessionReservationInput = Readonly<{
  workload: string;
  target?: WorkDispatchTarget;
}>;

export type SessionRegistry = Readonly<{
  /**
   * True when `attach` honors `retire`. Only then does the Hypervisor offer
   * workers make-before-break handoff.
   */
  handoff?: boolean;
  /** Synchronous change observer; must not mutate the registry. Errors are ignored. */
  subscribe?(listener: (session: WorkerSession) => void): () => void;
  attach(
    input: Readonly<{
      identity: WorkerIdentity;
      connectionId: string;
      sessionGeneration: number;
      transportType?: "in-process" | "websocket";
      workloads: readonly string[];
      capacity: number;
      leaseTimeoutMs: number;
      /**
       * Connection ID of the current session this one hands off from. When it
       * matches the same identity, that session retires instead of closing.
       */
      retire?: string;
    }>,
  ): SessionAttachment;
  markReady(fence: SessionFence): WorkerSession;
  heartbeat(
    fence: SessionFence,
    input: Readonly<{ sequence: number }>,
  ): WorkerSession;
  startDrain(fence: SessionFence): WorkerSession;
  markDrained(fence: SessionFence): WorkerSession;
  detach(fence: SessionFence): WorkerSession | undefined;
  expireLeases(): readonly WorkerSession[];
  get(workerId: string): WorkerSession | undefined;
  list(): readonly WorkerSession[];
  assertCurrent(fence: SessionFence): WorkerSession;
  withCurrent<T>(
    fence: SessionFence,
    operation: (session: WorkerSession) => T,
  ): T;
  isCurrent(fence: SessionFence): boolean;
  lease(fence: SessionFence): SessionLease;
  reserve(input: SessionReservationInput): WorkerSession;
  release(fence: SessionFence): WorkerSession;
  releaseIfCurrent(fence: SessionFence): WorkerSession | undefined;
}>;

function withSession(
  session: WorkerSession,
  changes: Partial<WorkerSession>,
): WorkerSession {
  return freeze({ ...session, ...changes });
}

function closeSession(
  session: WorkerSession,
  phase: "closed" | "expired",
): WorkerSession {
  return withSession(session, { phase });
}

/**
 * Creates the process-local authority for socket sessions and readiness.
 *
 * This registry is deliberately process-local and performs no durable
 * authorization. The gateway must await registration authority exchange and
 * worker repository fencing before calling `attach`. The authority-issued
 * session-generation high-watermark survives detach and expiry. Every inbound
 * frame must then call `assertCurrent` immediately before processing; protocol
 * data frames intentionally do not repeat the connection ID.
 */
export function createSessionRegistry(
  options: Readonly<{
    clock?: () => number;
  }> = {},
): SessionRegistry {
  const clock = options.clock ?? Date.now;
  // The routable session of each worker.
  const sessions = new Map<string, WorkerSession>();
  // Handed-off predecessors, by connection ID. They stay valid for their own
  // frames, so their streams finish, but never take new work once draining.
  const retiring = new Map<string, WorkerSession>();
  const listeners = new Set<(session: WorkerSession) => void>();
  const notify = (session: WorkerSession): void => {
    for (const listener of listeners) {
      try {
        listener(session);
      } catch {
        // Observers cannot roll back a session mutation or strand a reservation.
      }
    }
  };
  const connectionOwners = new Map<string, string>();
  const expiredEvents: WorkerSession[] = [];
  const highWatermarks = new Map<
    string,
    Readonly<{
      identity: WorkerIdentity;
      sessionGeneration: number;
    }>
  >();

  const now = (): number => expectFiniteTimestamp(clock(), "clock()");

  // Sessions of one worker that share its execution capacity.
  const siblings = (workerId: string): WorkerSession[] => {
    const found: WorkerSession[] = [];
    if (retiring.size === 0) return found;
    for (const session of retiring.values()) {
      if (session.identity.workerId === workerId) found.push(session);
    }
    return found;
  };

  // A current session as callers see it: its retiring predecessors' work still
  // occupies the same worker, so it counts against this session's capacity.
  const view = (session: WorkerSession): WorkerSession => {
    if (retiring.size === 0) return session;
    let reserved = session.reserved;
    for (const sibling of siblings(session.identity.workerId)) {
      reserved += sibling.reserved;
    }
    return reserved === session.reserved
      ? session
      : withSession(session, { reserved });
  };

  const load = (workerId: string): number => {
    const current = sessions.get(workerId);
    return (
      (current?.reserved ?? 0) +
      siblings(workerId).reduce((sum, session) => sum + session.reserved, 0)
    );
  };

  const store = (session: WorkerSession): void => {
    if (retiring.has(session.connectionId)) {
      retiring.set(session.connectionId, session);
    } else {
      sessions.set(session.identity.workerId, session);
    }
  };

  // If a successor goes before it is ready, its still-ready predecessor is
  // routable again: it never stopped taking work.
  const restore = (workerId: string): void => {
    if (sessions.has(workerId)) return;
    let candidate: WorkerSession | undefined;
    for (const session of siblings(workerId)) {
      if (
        session.phase === "ready" &&
        (candidate === undefined ||
          session.sessionGeneration > candidate.sessionGeneration)
      ) {
        candidate = session;
      }
    }
    if (candidate === undefined) return;
    retiring.delete(candidate.connectionId);
    sessions.set(workerId, candidate);
    notify(candidate);
  };

  const remove = (
    session: WorkerSession,
    phase: "closed" | "expired",
  ): WorkerSession => {
    if (sessions.get(session.identity.workerId) === session) {
      sessions.delete(session.identity.workerId);
    }
    if (retiring.get(session.connectionId) === session) {
      retiring.delete(session.connectionId);
    }
    if (
      connectionOwners.get(session.connectionId) === session.identity.workerId
    ) {
      connectionOwners.delete(session.connectionId);
    }
    const closed = closeSession(session, phase);
    notify(closed);
    return closed;
  };

  const expireOne = (
    session: WorkerSession,
    currentTime: number,
    restoreAfter = true,
  ): WorkerSession | undefined => {
    // A connected session is authenticated and fenced but deliberately not
    // routable yet. Its Ready handshake timer, owned by the Hypervisor, is the
    // sole startup deadline. The heartbeat lease begins only at markReady().
    if (session.phase === "connected") return undefined;
    // An in-process Worker shares the Hypervisor's process and event loop.
    // When that loop is suspended, both its heartbeat and this sweep become
    // overdue together; wall-clock fencing would therefore disconnect a live
    // local session as soon as the process resumes. Its event-fabric close is
    // authoritative instead. WebSocket Workers remain heartbeat-leased.
    if (session.transportType === "in-process") return undefined;
    if (currentTime < session.leaseExpiresAtMs) return undefined;
    const wasCurrent = sessions.get(session.identity.workerId) === session;
    const expired = remove(session, "expired");
    expiredEvents.push(expired);
    if (wasCurrent && restoreAfter) restore(session.identity.workerId);
    return expired;
  };

  const scanExpired = (): void => {
    const currentTime = now();
    for (const session of [...sessions.values(), ...retiring.values()]) {
      expireOne(session, currentTime);
    }
  };

  const isFence = (
    session: WorkerSession | undefined,
    fence: SessionFence,
  ): session is WorkerSession => {
    return (
      session !== undefined &&
      session.connectionId === fence.connectionId &&
      session.sessionGeneration === fence.sessionGeneration &&
      sameIdentity(session.identity, fence.identity)
    );
  };

  // The live session a fence names: the worker's current one or a retiring one.
  const located = (fence: SessionFence): WorkerSession | undefined => {
    const current = sessions.get(fence.identity.workerId);
    if (isFence(current, fence)) return current;
    const retired = retiring.get(fence.connectionId);
    return isFence(retired, fence) ? retired : undefined;
  };

  const assertCurrent = (fenceInput: SessionFence): WorkerSession => {
    const fence = createSessionFence(fenceInput);
    const session = located(fence);
    if (!isFence(session, fence)) {
      return fail(
        "stale_session",
        `connection ${fence.connectionId} is not current for ${fence.identity.workerId}/${fence.identity.attemptId}/${fence.identity.epoch}`,
      );
    }
    if (expireOne(session, now()) !== undefined) {
      return fail(
        "stale_session",
        `connection ${fence.connectionId} has expired`,
      );
    }
    return session;
  };

  const isCurrent = (fence: SessionFence): boolean => {
    try {
      assertCurrent(fence);
      return true;
    } catch {
      return false;
    }
  };

  const attach = (
    input: Parameters<SessionRegistry["attach"]>[0],
  ): SessionAttachment => {
    const incoming = createWorkerSession({
      ...input,
      connectedAtMs: now(),
    });

    const connectionOwner = connectionOwners.get(incoming.connectionId);
    if (connectionOwner !== undefined) {
      return fail(
        "already_exists",
        `connection ${incoming.connectionId} is already attached to ${connectionOwner}`,
      );
    }

    const highWatermark = highWatermarks.get(incoming.identity.workerId);
    if (highWatermark !== undefined) {
      if (incoming.identity.epoch < highWatermark.identity.epoch) {
        return fail(
          "stale_session",
          `epoch ${incoming.identity.epoch} is older than high-watermark epoch ${highWatermark.identity.epoch}`,
        );
      }
      if (
        incoming.identity.epoch === highWatermark.identity.epoch &&
        incoming.identity.attemptId !== highWatermark.identity.attemptId
      ) {
        return fail(
          "stale_session",
          "a different attempt already owns this worker epoch",
        );
      }
      if (
        sameIdentity(incoming.identity, highWatermark.identity) &&
        incoming.sessionGeneration <= highWatermark.sessionGeneration
      ) {
        return fail(
          "stale_session",
          `session generation ${incoming.sessionGeneration} is not newer than published generation ${highWatermark.sessionGeneration}`,
        );
      }
    }

    let existing = sessions.get(incoming.identity.workerId);
    let expiredExisting: WorkerSession | undefined;
    if (existing !== undefined) {
      expiredExisting = expireOne(existing, now(), false);
      if (expiredExisting !== undefined) existing = undefined;
    }

    if (existing !== undefined) {
      if (incoming.identity.epoch < existing.identity.epoch) {
        return fail(
          "stale_session",
          `epoch ${incoming.identity.epoch} is older than current epoch ${existing.identity.epoch}`,
        );
      }
      if (
        incoming.identity.epoch === existing.identity.epoch &&
        incoming.identity.attemptId !== existing.identity.attemptId
      ) {
        return fail(
          "stale_session",
          "a different attempt already owns this worker epoch",
        );
      }
      if (
        sameIdentity(incoming.identity, existing.identity) &&
        incoming.sessionGeneration <= existing.sessionGeneration
      ) {
        return fail(
          "stale_session",
          `session generation ${incoming.sessionGeneration} cannot displace live generation ${existing.sessionGeneration}`,
        );
      }
    }

    // A handoff names the live connection it replaces. That session keeps its
    // streams; anything else is displaced exactly as before.
    const retires =
      existing !== undefined &&
      input.retire !== undefined &&
      input.retire === existing.connectionId &&
      sameIdentity(existing.identity, incoming.identity) &&
      (existing.phase === "ready" || existing.phase === "draining");
    let replaced: WorkerSession | undefined;
    let retired: WorkerSession | undefined;
    if (retires) {
      sessions.delete(existing!.identity.workerId);
      retiring.set(existing!.connectionId, existing!);
      retired = existing;
    } else {
      replaced =
        existing === undefined ? expiredExisting : remove(existing, "closed");
    }
    // A newer attempt or epoch fences every older session of this worker.
    const superseded = siblings(incoming.identity.workerId)
      .filter((session) => !sameIdentity(session.identity, incoming.identity))
      .map((session) => remove(session, "closed"));
    sessions.set(incoming.identity.workerId, incoming);
    connectionOwners.set(incoming.connectionId, incoming.identity.workerId);
    highWatermarks.set(
      incoming.identity.workerId,
      freeze({
        identity: incoming.identity,
        sessionGeneration: incoming.sessionGeneration,
      }),
    );
    notify(incoming);
    return freeze({
      session: incoming,
      ...(replaced === undefined ? {} : { replaced }),
      ...(retired === undefined ? {} : { retired }),
      ...(superseded.length === 0 ? {} : { superseded: freeze(superseded) }),
    });
  };

  const replace = (
    fence: SessionFence,
    update: (session: WorkerSession) => WorkerSession,
  ): WorkerSession => {
    const previous = assertCurrent(fence);
    const next = update(previous);
    store(next);
    notify(next);
    return next;
  };

  const markReady = (fence: SessionFence): WorkerSession => {
    return replace(fence, (session) => {
      if (session.phase !== "connected") {
        return fail(
          "invalid_state",
          `cannot mark a ${session.phase} session ready`,
        );
      }
      const currentTime = now();
      const leaseTimeoutMs =
        session.leaseExpiresAtMs - session.lastHeartbeatAtMs;
      const leaseExpiresAtMs = currentTime + leaseTimeoutMs;
      if (!Number.isSafeInteger(leaseExpiresAtMs)) {
        throw new TypeError("lease expiration exceeds safe integer range");
      }
      return withSession(session, {
        phase: "ready",
        lastHeartbeatAtMs: currentTime,
        leaseExpiresAtMs,
      });
    });
  };

  const heartbeat = (
    fence: SessionFence,
    input: Readonly<{ sequence: number }>,
  ): WorkerSession => {
    return replace(fence, (session) => {
      if (session.phase !== "ready" && session.phase !== "draining") {
        return fail(
          "invalid_state",
          `cannot heartbeat a ${session.phase} session`,
        );
      }
      if (
        !Number.isSafeInteger(input.sequence) ||
        input.sequence !== session.nextHeartbeatSequence
      ) {
        return fail(
          "invalid_state",
          `heartbeat sequence ${input.sequence} does not match expected ${session.nextHeartbeatSequence}`,
        );
      }
      const currentTime = now();
      const leaseTimeoutMs =
        session.leaseExpiresAtMs - session.lastHeartbeatAtMs;
      const leaseExpiresAtMs = currentTime + leaseTimeoutMs;
      if (!Number.isSafeInteger(leaseExpiresAtMs)) {
        throw new TypeError("lease expiration exceeds safe integer range");
      }
      return withSession(session, {
        nextHeartbeatSequence: session.nextHeartbeatSequence + 1,
        lastHeartbeatAtMs: currentTime,
        leaseExpiresAtMs,
      });
    });
  };

  const startDrain = (fence: SessionFence): WorkerSession => {
    return replace(fence, (session) => {
      if (session.phase !== "ready") {
        return fail("invalid_state", `cannot drain a ${session.phase} session`);
      }
      return withSession(session, { phase: "draining" });
    });
  };

  const markDrained = (fence: SessionFence): WorkerSession => {
    return replace(fence, (session) => {
      if (session.phase !== "draining") {
        return fail(
          "invalid_state",
          `cannot mark a ${session.phase} session drained`,
        );
      }
      if (session.reserved !== 0) {
        return fail(
          "invalid_state",
          "cannot drain a session with reserved work",
        );
      }
      return withSession(session, { phase: "drained" });
    });
  };

  const detach = (fence: SessionFence): WorkerSession | undefined => {
    const session = located(fence);
    if (session === undefined) return undefined;
    const wasCurrent = sessions.get(session.identity.workerId) === session;
    const removed = remove(session, "closed");
    if (wasCurrent) restore(session.identity.workerId);
    return removed;
  };

  const expireLeases = (): readonly WorkerSession[] => {
    scanExpired();
    const expired = expiredEvents.splice(0);
    return Object.freeze(expired);
  };

  const get = (workerIdInput: string): WorkerSession | undefined => {
    const workerId = expectIdentifier(workerIdInput, "workerId");
    const session = sessions.get(workerId);
    if (session === undefined) return undefined;
    if (expireOne(session, now()) !== undefined) return undefined;
    return view(session);
  };

  const list = (): readonly WorkerSession[] => {
    // Read views remove expired sessions from admission immediately but do not
    // consume the lifecycle events awaited by the Hypervisor lease sweep.
    scanExpired();
    return Object.freeze(Array.from(sessions.values(), view));
  };

  const lease = (fenceInput: SessionFence): SessionLease => {
    const fence = createSessionFence(fenceInput);
    assertCurrent(fence);
    return Object.freeze({
      fence,
      snapshot: () => assertCurrent(fence),
      isCurrent: () => isCurrent(fence),
      assertCurrent: () => assertCurrent(fence),
    });
  };

  const withCurrent = <T>(
    fence: SessionFence,
    operation: (session: WorkerSession) => T,
  ): T => {
    // The assertion and callback entry happen in one JavaScript turn. Callers
    // must not defer frame validation until after an await.
    return operation(assertCurrent(fence));
  };

  const reserve = (
    input: Parameters<SessionRegistry["reserve"]>[0],
  ): WorkerSession => {
    if (input === null || typeof input !== "object") {
      throw new TypeError("session reservation input must be an object");
    }
    const workload = expectWorkload(input.workload, "workload");
    const target =
      input.target === undefined
        ? undefined
        : createWorkDispatchTarget(input.target);
    scanExpired();
    // A retiring session still in `ready` keeps taking work until its
    // successor is ready, so a handoff never leaves a worker unroutable.
    const pool =
      target === undefined
        ? [...sessions.values(), ...retiring.values()]
        : [sessions.get(target.workerId), ...siblings(target.workerId)];
    const candidates = pool.filter(
      (session): session is WorkerSession =>
        session !== undefined &&
        session.phase === "ready" &&
        session.workloads.includes(workload) &&
        load(session.identity.workerId) < session.capacity,
    );
    candidates.sort(
      (left, right) =>
        load(left.identity.workerId) / left.capacity -
          load(right.identity.workerId) / right.capacity ||
        left.connectedAtMs - right.connectedAtMs ||
        left.identity.workerId.localeCompare(right.identity.workerId),
    );
    const selected = candidates[0];
    if (selected === undefined) {
      return fail(
        "capacity_exhausted",
        target === undefined
          ? `no ready session has capacity for workload ${workload}`
          : `target worker ${target.workerId} is unavailable for workload ${workload}`,
      );
    }
    const next = withSession(selected, { reserved: selected.reserved + 1 });
    store(next);
    notify(next);
    return next;
  };

  const release = (fence: SessionFence): WorkerSession => {
    return replace(fence, (session) => {
      if (session.reserved < 1) {
        return fail("invalid_state", "session has no reserved work to release");
      }
      return withSession(session, { reserved: session.reserved - 1 });
    });
  };

  const releaseIfCurrent = (fence: SessionFence): WorkerSession | undefined => {
    if (!isCurrent(fence)) return undefined;
    const session = assertCurrent(fence);
    if (session.reserved < 1) return session;
    return release(fence);
  };

  return Object.freeze({
    handoff: true,
    subscribe(listener: (session: WorkerSession) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    attach,
    markReady,
    heartbeat,
    startDrain,
    markDrained,
    detach,
    expireLeases,
    get,
    list,
    assertCurrent,
    withCurrent,
    isCurrent,
    lease,
    reserve,
    release,
    releaseIfCurrent,
  });
}

export function fenceForSession(session: WorkerSession): SessionFence {
  return sessionFence(session);
}
