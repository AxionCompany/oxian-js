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
  attach(
    input: Readonly<{
      identity: WorkerIdentity;
      connectionId: string;
      sessionGeneration: number;
      workloads: readonly string[];
      capacity: number;
      leaseTimeoutMs: number;
      liveness?: "heartbeat" | "binding";
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
  const sessions = new Map<string, WorkerSession>();
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

  const remove = (
    session: WorkerSession,
    phase: "closed" | "expired",
  ): WorkerSession => {
    if (sessions.get(session.identity.workerId) === session) {
      sessions.delete(session.identity.workerId);
    }
    if (
      connectionOwners.get(session.connectionId) === session.identity.workerId
    ) {
      connectionOwners.delete(session.connectionId);
    }
    return closeSession(session, phase);
  };

  const expireOne = (
    session: WorkerSession,
    currentTime: number,
  ): WorkerSession | undefined => {
    // A directly bound session has process-local liveness and ends explicitly.
    if (session.liveness === "binding") return undefined;
    // A connected session is authenticated and fenced but deliberately not
    // routable yet. Its Ready handshake timer, owned by the Hypervisor, is the
    // sole startup deadline. The heartbeat lease begins only at markReady().
    if (session.phase === "connected") return undefined;
    if (currentTime < session.leaseExpiresAtMs) return undefined;
    const expired = remove(session, "expired");
    expiredEvents.push(expired);
    return expired;
  };

  const scanExpired = (): void => {
    const currentTime = now();
    for (const session of [...sessions.values()]) {
      expireOne(session, currentTime);
    }
  };

  const isFence = (
    session: WorkerSession | undefined,
    fence: SessionFence,
  ): session is WorkerSession => {
    return session !== undefined &&
      session.connectionId === fence.connectionId &&
      session.sessionGeneration === fence.sessionGeneration &&
      sameIdentity(session.identity, fence.identity);
  };

  const assertCurrent = (fenceInput: SessionFence): WorkerSession => {
    const fence = createSessionFence(fenceInput);
    const session = sessions.get(fence.identity.workerId);
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
      expiredExisting = expireOne(existing, now());
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

    const replaced = existing === undefined
      ? expiredExisting
      : remove(existing, "closed");
    sessions.set(incoming.identity.workerId, incoming);
    connectionOwners.set(incoming.connectionId, incoming.identity.workerId);
    highWatermarks.set(
      incoming.identity.workerId,
      freeze({
        identity: incoming.identity,
        sessionGeneration: incoming.sessionGeneration,
      }),
    );
    return freeze({
      session: incoming,
      ...(replaced === undefined ? {} : { replaced }),
    });
  };

  const replace = (
    fence: SessionFence,
    update: (session: WorkerSession) => WorkerSession,
  ): WorkerSession => {
    const previous = assertCurrent(fence);
    const next = update(previous);
    sessions.set(previous.identity.workerId, next);
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
      const leaseTimeoutMs = session.leaseExpiresAtMs -
        session.lastHeartbeatAtMs;
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
      if (session.liveness !== "heartbeat") {
        return fail("invalid_state", "cannot heartbeat a bound session");
      }
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
      const leaseTimeoutMs = session.leaseExpiresAtMs -
        session.lastHeartbeatAtMs;
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
        return fail(
          "invalid_state",
          `cannot drain a ${session.phase} session`,
        );
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
    const session = sessions.get(fence.identity.workerId);
    if (!isFence(session, fence)) return undefined;
    return remove(session, "closed");
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
    return expireOne(session, now()) === undefined ? session : undefined;
  };

  const list = (): readonly WorkerSession[] => {
    // Read views remove expired sessions from admission immediately but do not
    // consume the lifecycle events awaited by the Hypervisor lease sweep.
    scanExpired();
    return Object.freeze(Array.from(sessions.values()));
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
    const target = input.target === undefined
      ? undefined
      : createWorkDispatchTarget(input.target);
    scanExpired();
    const candidates = target === undefined
      ? Array.from(sessions.values()).filter((session) =>
        session.phase === "ready" &&
        session.workloads.includes(workload) &&
        session.reserved < session.capacity
      )
      : [sessions.get(target.workerId)].filter((
        session,
      ): session is WorkerSession =>
        session !== undefined &&
        session.phase === "ready" &&
        session.workloads.includes(workload) &&
        session.reserved < session.capacity
      );
    candidates.sort((left, right) =>
      left.reserved / left.capacity - right.reserved / right.capacity ||
      left.connectedAtMs - right.connectedAtMs ||
      left.identity.workerId.localeCompare(right.identity.workerId)
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
    sessions.set(selected.identity.workerId, next);
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

  const releaseIfCurrent = (
    fence: SessionFence,
  ): WorkerSession | undefined => {
    if (!isCurrent(fence)) return undefined;
    const session = assertCurrent(fence);
    if (session.reserved < 1) return session;
    return release(fence);
  };

  return Object.freeze({
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
