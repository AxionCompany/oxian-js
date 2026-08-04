import type { WorkerIdentity } from "../protocol/types.ts";
import {
  copyIdentity,
  expectIdentifier,
  fail,
  sameIdentity,
} from "./internal.ts";
import {
  createWorkerAttempt,
  createWorkerDefinition,
  isTerminalAttempt,
  transitionWorkerAttempt,
} from "./state.ts";
import type {
  WorkerAttempt,
  WorkerAttemptEvent,
  WorkerDefinition,
} from "./types.ts";

export type WorkerActivation = Readonly<{
  attempt: WorkerAttempt;
  created: boolean;
}>;

export type WorkerRepository = Readonly<{
  define(definition: WorkerDefinition): Promise<WorkerDefinition>;
  getDefinition(workerId: string): Promise<WorkerDefinition | undefined>;
  listDefinitions(): Promise<readonly WorkerDefinition[]>;
  activate(workerId: string): Promise<WorkerActivation>;
  transition(
    identity: WorkerIdentity,
    event: WorkerAttemptEvent,
  ): Promise<WorkerAttempt>;
  currentAttempt(workerId: string): Promise<WorkerAttempt | undefined>;
  getAttempt(identity: WorkerIdentity): Promise<WorkerAttempt | undefined>;
  listAttempts(workerId: string): Promise<readonly WorkerAttempt[]>;
  isCurrent(identity: WorkerIdentity): Promise<boolean>;
  assertCurrent(identity: WorkerIdentity): Promise<WorkerAttempt>;
}>;

/**
 * Creates the reference semantic repository.
 *
 * The asynchronous contract is intentional: durable implementations use a
 * transaction or compare-and-swap keyed by worker ID. `activate` must atomically
 * return the existing non-terminal attempt or create exactly one next epoch,
 * and `transition` must compare the complete attempt identity plus source phase.
 * This in-memory implementation mutates its closures before returning each
 * promise, preserving those semantics across concurrent calls in one process.
 */
export function createInMemoryWorkerRepository(
  options: Readonly<{
    clock?: () => number;
    createAttemptId?: () => string;
  }> = {},
): WorkerRepository {
  const clock = options.clock ?? Date.now;
  const createAttemptId = options.createAttemptId ??
    (() => crypto.randomUUID());
  const definitions = new Map<string, WorkerDefinition>();
  const attempts = new Map<string, WorkerAttempt[]>();
  const current = new Map<string, WorkerAttempt>();
  const usedAttemptIds = new Set<string>();

  const asPromise = <T>(operation: () => T): Promise<T> => {
    try {
      return Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const define = (
    definition: WorkerDefinition,
  ): Promise<WorkerDefinition> => {
    return asPromise(() => {
      const copy = createWorkerDefinition(definition);
      if (definitions.has(copy.workerId)) {
        return fail(
          "already_exists",
          `worker ${copy.workerId} is already defined`,
        );
      }
      definitions.set(copy.workerId, copy);
      return copy;
    });
  };

  const getDefinition = (
    workerId: string,
  ): Promise<WorkerDefinition | undefined> => {
    return asPromise(() =>
      definitions.get(expectIdentifier(workerId, "workerId"))
    );
  };

  const listDefinitions = (): Promise<readonly WorkerDefinition[]> => {
    return asPromise(() => Object.freeze(Array.from(definitions.values())));
  };

  const activate = (
    workerIdInput: string,
  ): Promise<WorkerActivation> => {
    return asPromise(() => {
      const workerId = expectIdentifier(workerIdInput, "workerId");
      if (!definitions.has(workerId)) {
        return fail("not_found", `worker ${workerId} is not defined`);
      }

      const existing = current.get(workerId);
      if (existing !== undefined && !isTerminalAttempt(existing)) {
        return Object.freeze({ attempt: existing, created: false });
      }

      const attemptId = expectIdentifier(createAttemptId(), "attemptId");
      if (usedAttemptIds.has(attemptId)) {
        return fail(
          "already_exists",
          `attempt ID ${attemptId} has already been used`,
        );
      }
      usedAttemptIds.add(attemptId);

      const attempt = createWorkerAttempt({
        identity: {
          workerId,
          attemptId,
          epoch: (existing?.identity.epoch ?? 0) + 1,
        },
        nowMs: clock(),
      });
      const history = attempts.get(workerId) ?? [];
      history.push(attempt);
      attempts.set(workerId, history);
      current.set(workerId, attempt);
      return Object.freeze({ attempt, created: true });
    });
  };

  const assertCurrentValue = (
    identityInput: WorkerIdentity,
  ): WorkerAttempt => {
    const identity = copyIdentity(identityInput);
    const active = current.get(identity.workerId);
    if (active === undefined) {
      return fail(
        "stale_attempt",
        `worker ${identity.workerId} has no current attempt`,
      );
    }
    if (!sameIdentity(active.identity, identity)) {
      return fail(
        "stale_attempt",
        `attempt ${identity.attemptId}/${identity.epoch} is not current for worker ${identity.workerId}`,
      );
    }
    return active;
  };

  const assertCurrent = (
    identity: WorkerIdentity,
  ): Promise<WorkerAttempt> => {
    return asPromise(() => assertCurrentValue(identity));
  };

  const replaceInHistory = (attempt: WorkerAttempt): void => {
    const history = attempts.get(attempt.identity.workerId);
    if (history === undefined) {
      return fail("not_found", "attempt history is missing");
    }
    const index = history.findIndex((candidate) =>
      sameIdentity(candidate.identity, attempt.identity)
    );
    if (index < 0) {
      return fail("not_found", "attempt history entry is missing");
    }
    history[index] = attempt;
  };

  const transition = (
    identity: WorkerIdentity,
    event: WorkerAttemptEvent,
  ): Promise<WorkerAttempt> => {
    return asPromise(() => {
      const previous = assertCurrentValue(identity);
      const next = transitionWorkerAttempt(previous, event, clock());
      replaceInHistory(next);
      current.set(next.identity.workerId, next);
      return next;
    });
  };

  const currentAttempt = (
    workerId: string,
  ): Promise<WorkerAttempt | undefined> => {
    return asPromise(() => current.get(expectIdentifier(workerId, "workerId")));
  };

  const getAttempt = (
    identity: WorkerIdentity,
  ): Promise<WorkerAttempt | undefined> => {
    return asPromise(() => {
      const copy = copyIdentity(identity);
      return attempts.get(copy.workerId)?.find((attempt) =>
        sameIdentity(attempt.identity, copy)
      );
    });
  };

  const listAttempts = (
    workerId: string,
  ): Promise<readonly WorkerAttempt[]> => {
    return asPromise(() => {
      const history = attempts.get(expectIdentifier(workerId, "workerId")) ??
        [];
      return Object.freeze([...history]);
    });
  };

  const isCurrent = (identity: WorkerIdentity): Promise<boolean> => {
    return asPromise(() => {
      const copy = copyIdentity(identity);
      const attempt = current.get(copy.workerId);
      return attempt !== undefined && sameIdentity(attempt.identity, copy);
    });
  };

  return Object.freeze({
    define,
    getDefinition,
    listDefinitions,
    activate,
    transition,
    currentAttempt,
    getAttempt,
    listAttempts,
    isCurrent,
    assertCurrent,
  });
}
