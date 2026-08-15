import {
  createHelloFrame,
  type WelcomeFrame,
  type WorkerCredential,
  type WorkerIdentity,
} from "../../protocol/index.ts";
import type { WorkerResumeCredentialUpdate } from "../types.ts";
import type { WorkerCredentialPersistence } from "./session-options.ts";
import { runBoundedHandshakeStep, waitForTaskOrStop } from "./async.ts";
import { createWorkerError } from "./errors.ts";

type PendingRotationPersistence = {
  sourceCredential: WorkerCredential;
  sourceHandshakeId: string;
  resumeCapability: string;
  resumeExpiresAtMs: number;
  update: WorkerResumeCredentialUpdate;
  task?: Promise<void>;
};

export type CredentialState = Readonly<{
  credential: WorkerCredential;
  handshakeId: string;
  resumeExpiresAtMs?: number;
}>;

export type CredentialRotationCoordinator = Readonly<{
  current(): CredentialState;
  acceptWelcome(
    welcome: WelcomeFrame,
    source: Readonly<{
      credential: WorkerCredential;
      handshakeId: string;
    }>,
    signal: AbortSignal,
  ): Promise<void>;
  settlePending(signal: AbortSignal): Promise<void>;
}>;

type CredentialRotationCoordinatorOptions = Readonly<{
  initialCredential: WorkerCredential;
  initialHandshakeId: string;
  initialResumeExpiresAtMs?: number;
  persistence: WorkerCredentialPersistence;
  identity: WorkerIdentity;
  workloads: readonly string[];
  capacity: number;
  handshakeTimeoutMs: number;
  createHandshakeId(): string;
}>;

function sameCredential(
  left: WorkerCredential,
  right: WorkerCredential,
): boolean {
  return left.kind === right.kind && left.capability === right.capability;
}

/**
 * Owns the atomic credential/handshake pair and the one durable rotation that
 * may remain unsettled across reconnects.
 */
export function createCredentialRotationCoordinator(
  options: CredentialRotationCoordinatorOptions,
): CredentialRotationCoordinator {
  let credential = options.initialCredential;
  let handshakeId = options.initialHandshakeId;
  let resumeExpiresAtMs = options.initialResumeExpiresAtMs;
  let pending: PendingRotationPersistence | undefined;

  const current = (): CredentialState =>
    Object.freeze({
      credential,
      handshakeId,
      ...(resumeExpiresAtMs === undefined ? {} : { resumeExpiresAtMs }),
    });

  const createCandidate = (
    welcome: WelcomeFrame,
    source: Readonly<{
      credential: WorkerCredential;
      handshakeId: string;
    }>,
  ): PendingRotationPersistence => {
    const validatedNextHello = createHelloFrame({
      handshakeId: options.createHandshakeId(),
      identity: options.identity,
      credential: {
        kind: "resume",
        capability: welcome.resumeCapability,
      },
      workloads: options.workloads,
      capacity: options.capacity,
    });
    return {
      sourceCredential: source.credential,
      sourceHandshakeId: source.handshakeId,
      resumeCapability: welcome.resumeCapability,
      resumeExpiresAtMs: welcome.resumeExpiresAtMs,
      update: Object.freeze({
        credential: Object.freeze({
          kind: "resume",
          capability: validatedNextHello.credential.capability,
        }),
        replacesHandshakeId: source.handshakeId,
        handshakeId: validatedNextHello.handshakeId,
        resumeExpiresAtMs: welcome.resumeExpiresAtMs,
      }),
    };
  };

  const adopt = (candidate: PendingRotationPersistence): void => {
    if (pending !== candidate) {
      throw createWorkerError(
        "credential_persistence_failed",
        "Resume persistence completed for a stale rotation",
      );
    }
    credential = candidate.update.credential;
    handshakeId = candidate.update.handshakeId;
    resumeExpiresAtMs = candidate.update.resumeExpiresAtMs;
    pending = undefined;
  };

  const acceptWelcome = async (
    welcome: WelcomeFrame,
    source: Readonly<{
      credential: WorkerCredential;
      handshakeId: string;
    }>,
    signal: AbortSignal,
  ): Promise<void> => {
    if (options.persistence.credentialPersistence === "ephemeral") {
      const candidate = createCandidate(welcome, source);
      credential = candidate.update.credential;
      handshakeId = candidate.update.handshakeId;
      resumeExpiresAtMs = candidate.update.resumeExpiresAtMs;
      return;
    }
    const persistResumeCredential = options.persistence.persistResumeCredential;

    let candidate = pending;
    if (candidate === undefined) {
      candidate = createCandidate(welcome, source);
      pending = candidate;
    } else if (
      !sameCredential(candidate.sourceCredential, source.credential) ||
      candidate.sourceHandshakeId !== source.handshakeId ||
      candidate.resumeCapability !== welcome.resumeCapability ||
      candidate.resumeExpiresAtMs !== welcome.resumeExpiresAtMs
    ) {
      throw createWorkerError(
        "credential_rejected",
        "Hypervisor changed a replayed resume-credential rotation",
      );
    }

    if (candidate.task === undefined) {
      candidate.task = Promise.resolve().then(() =>
        persistResumeCredential(candidate.update, {
          signal,
          connectionId: welcome.connectionId,
          bootstrap: welcome.bootstrap,
          reconnecting: source.credential.kind === "resume",
        })
      );
    }
    try {
      await runBoundedHandshakeStep(
        "resume credential persistence",
        options.handshakeTimeoutMs,
        signal,
        () => candidate.task!,
      );
    } catch (error) {
      throw createWorkerError(
        "credential_persistence_failed",
        "Failed to persist rotated resume credential",
        error,
      );
    }
    // Adoption is atomic from the runtime's perspective and occurs only after
    // the underlying persistence Promise confirms durable commit.
    adopt(candidate);
  };

  const settlePending = async (signal: AbortSignal): Promise<void> => {
    const candidate = pending;
    if (candidate?.task === undefined) return;
    try {
      await waitForTaskOrStop(candidate.task, signal);
      adopt(candidate);
    } catch (error) {
      if (signal.aborted) throw error;
      if (pending === candidate) {
        // Retain the exact candidate, but permit one later idempotent attempt
        // only after this rejected Promise has fully settled.
        candidate.task = undefined;
      }
    }
  };

  return Object.freeze({
    current,
    acceptWelcome,
    settlePending,
  });
}
