import {
  copyIdentity,
  copyJsonObject,
  copyUniqueWorkloads,
  expectFiniteTimestamp,
  expectIdentifier,
  expectPositiveInteger,
  fail,
  freeze,
} from "./internal.ts";
import type {
  SessionFence,
  WorkDispatchTarget,
  WorkerAttempt,
  WorkerAttemptEvent,
  WorkerAttemptFailure,
  WorkerDefinition,
  WorkerSession,
} from "./types.ts";
import type { WorkerIdentity } from "../protocol/types.ts";

export function createWorkerDefinition(
  input: Readonly<{
    workerId: string;
    providerId: string;
    workloads: readonly string[];
    capacity: number;
    providerConfig?: WorkerDefinition["providerConfig"];
    labels?: WorkerDefinition["labels"];
  }>,
): WorkerDefinition {
  return freeze({
    workerId: expectIdentifier(input.workerId, "workerId"),
    providerId: expectIdentifier(input.providerId, "providerId"),
    workloads: copyUniqueWorkloads(input.workloads),
    capacity: expectPositiveInteger(input.capacity, "capacity"),
    providerConfig: copyJsonObject(input.providerConfig),
    labels: copyJsonObject(input.labels),
  });
}

export function createWorkerAttempt(
  input: Readonly<{
    identity: WorkerIdentity;
    nowMs: number;
  }>,
): WorkerAttempt {
  const nowMs = expectFiniteTimestamp(input.nowMs, "nowMs");
  return freeze({
    identity: copyIdentity(input.identity),
    phase: "requested",
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
}

function copyFailure(
  failure: WorkerAttemptFailure,
): WorkerAttemptFailure {
  return freeze({
    code: expectIdentifier(failure.code, "failure.code"),
    message: typeof failure.message === "string" && failure.message.length > 0
      ? failure.message
      : fail("invalid_state", "failure.message must be a non-empty string"),
  });
}

function attemptWith(
  attempt: WorkerAttempt,
  nowMs: number,
  changes: Partial<WorkerAttempt>,
): WorkerAttempt {
  const timestamp = expectFiniteTimestamp(nowMs, "nowMs");
  if (timestamp < attempt.updatedAtMs) {
    return fail("invalid_state", "attempt timestamps must be monotonic");
  }
  return freeze({
    ...attempt,
    ...changes,
    updatedAtMs: timestamp,
  });
}

export function transitionWorkerAttempt(
  attempt: WorkerAttempt,
  event: WorkerAttemptEvent,
  nowMs: number,
): WorkerAttempt {
  switch (event.type) {
    case "launching": {
      if (attempt.phase !== "requested") {
        return fail(
          "invalid_state",
          `cannot launch an attempt in phase ${attempt.phase}`,
        );
      }
      return attemptWith(attempt, nowMs, { phase: "launching" });
    }

    case "running": {
      if (attempt.phase !== "launching") {
        return fail(
          "invalid_state",
          `cannot mark an attempt running from ${attempt.phase}`,
        );
      }
      return attemptWith(attempt, nowMs, {
        phase: "running",
        providerInstanceId: expectIdentifier(
          event.providerInstanceId,
          "providerInstanceId",
        ),
      });
    }

    case "terminate": {
      if (
        attempt.phase !== "requested" &&
        attempt.phase !== "launching" &&
        attempt.phase !== "running"
      ) {
        return fail(
          "invalid_state",
          `cannot terminate an attempt in phase ${attempt.phase}`,
        );
      }
      return attemptWith(attempt, nowMs, { phase: "terminating" });
    }

    case "terminated": {
      if (attempt.phase !== "terminating") {
        return fail(
          "invalid_state",
          `cannot mark an attempt terminated from ${attempt.phase}`,
        );
      }
      return attemptWith(attempt, nowMs, { phase: "terminated" });
    }

    case "failed": {
      if (
        attempt.phase === "terminated" ||
        attempt.phase === "failed"
      ) {
        return fail(
          "invalid_state",
          `cannot fail an attempt in phase ${attempt.phase}`,
        );
      }
      return attemptWith(attempt, nowMs, {
        phase: "failed",
        failure: copyFailure(event),
      });
    }
  }
}

export function isTerminalAttempt(attempt: WorkerAttempt): boolean {
  return attempt.phase === "terminated" || attempt.phase === "failed";
}

export function createSessionFence(
  input: SessionFence,
): SessionFence {
  return freeze({
    identity: copyIdentity(input.identity),
    connectionId: expectIdentifier(input.connectionId, "connectionId"),
    sessionGeneration: expectPositiveInteger(
      input.sessionGeneration,
      "sessionGeneration",
    ),
  });
}

export function createWorkDispatchTarget(
  input: WorkDispatchTarget,
): WorkDispatchTarget {
  if (input === null || typeof input !== "object") {
    throw new TypeError("work dispatch target must be an object");
  }
  return freeze({
    workerId: expectIdentifier(input.workerId, "target.workerId"),
  });
}

export function createWorkerSession(
  input: Readonly<{
    identity: WorkerIdentity;
    connectionId: string;
    sessionGeneration: number;
    workloads: readonly string[];
    capacity: number;
    connectedAtMs: number;
    leaseTimeoutMs: number;
  }>,
): WorkerSession {
  const connectedAtMs = expectFiniteTimestamp(
    input.connectedAtMs,
    "connectedAtMs",
  );
  const leaseTimeoutMs = expectPositiveInteger(
    input.leaseTimeoutMs,
    "leaseTimeoutMs",
  );
  const leaseExpiresAtMs = connectedAtMs + leaseTimeoutMs;
  if (!Number.isSafeInteger(leaseExpiresAtMs)) {
    throw new TypeError("lease expiration exceeds safe integer range");
  }

  return freeze({
    identity: copyIdentity(input.identity),
    connectionId: expectIdentifier(input.connectionId, "connectionId"),
    sessionGeneration: expectPositiveInteger(
      input.sessionGeneration,
      "sessionGeneration",
    ),
    workloads: copyUniqueWorkloads(input.workloads),
    capacity: expectPositiveInteger(input.capacity, "capacity"),
    phase: "connected",
    reserved: 0,
    nextHeartbeatSequence: 0,
    connectedAtMs,
    lastHeartbeatAtMs: connectedAtMs,
    leaseExpiresAtMs,
  });
}

export function sessionFence(session: WorkerSession): SessionFence {
  return createSessionFence({
    identity: session.identity,
    connectionId: session.connectionId,
    sessionGeneration: session.sessionGeneration,
  });
}
