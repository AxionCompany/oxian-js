import type { JsonValue } from "../protocol/types.ts";
import {
  fingerprintRequest,
  isOwnerError,
  snapshotRequest,
} from "./primitives.ts";
import type {
  CommandContext,
  CommandIdentity,
  CommandOutcome,
  CommandRequest,
  Owner,
  OwnerOptions,
  OwnerState,
  OwnerStoreTransaction,
} from "./types.ts";

const DEFAULT_MAX_GROUP_COMMANDS = 1_024;
const DEFAULT_MAX_QUEUED_COMMANDS = 4_096;
const OWNERSHIP_LOST: CommandOutcome = Object.freeze({
  status: "ownership_lost",
});
const DOMAINS = new Set(["logical", "incarnation", "occurrence"]);
const DECLARED = Symbol("oxian.owner.declaredOutcome");

type Pending = {
  readonly request: CommandRequest;
  readonly fingerprint: Promise<string>;
  /** Set after a definitive rollback: the command is retried on its own. */
  solo: boolean;
  resolve(outcome: CommandOutcome): void;
  reject(error: unknown): void;
};

type Executed = Readonly<{
  pending: Pending;
  settle(): void;
  callbacks: readonly (() => void | Promise<void>)[];
}>;

/** Creates the single live owner of one store. */
export function createOwner<Tx>(options: OwnerOptions<Tx>): Owner {
  const { store, commands } = options;
  const clock = options.clock ?? Date.now;
  const maxGroup = positiveInteger(
    options.maxGroupCommands ?? DEFAULT_MAX_GROUP_COMMANDS,
    "maxGroupCommands",
  );
  const maxQueued = positiveInteger(
    options.maxQueuedCommands ?? DEFAULT_MAX_QUEUED_COMMANDS,
    "maxQueuedCommands",
  );
  const onError = options.onError ?? ((error) => console.error(error));

  const queue: Pending[] = [];
  let state: OwnerState = "activating";
  let epoch: number | undefined;
  let draining: Promise<void> | undefined;
  let resolveStopped!: (reason: unknown) => void;
  const stopped = new Promise<unknown>((resolve) => {
    resolveStopped = resolve;
  });

  const ready = (async () => {
    const acquired = await store.acquire();
    // `stop` may have run while acquire was in flight.
    if (hasStopped()) return;
    epoch = acquired;
    state = "active";
    schedule();
  })();
  ready.catch((error) => halt(error));

  function hasStopped(): boolean {
    return state === "stopped";
  }

  function submit(request: CommandRequest): Promise<CommandOutcome> {
    let submitted: CommandRequest;
    try {
      submitted = snapshotRequest(request);
    } catch {
      return Promise.resolve({
        status: "invalid",
        reason: "command input must be JSON",
      });
    }
    const problem = validate(submitted);
    if (problem !== undefined) {
      return Promise.resolve({ status: "invalid", reason: problem });
    }
    if (state === "stopped") return Promise.resolve(OWNERSHIP_LOST);
    if (queue.length >= maxQueued) {
      return Promise.resolve({ status: "refused", reason: "owner_overloaded" });
    }
    const fingerprint = fingerprintRequest(submitted.type, submitted.input);
    fingerprint.catch(() => undefined);
    return new Promise<CommandOutcome>((resolve, reject) => {
      queue.push({
        request: submitted,
        fingerprint,
        solo: false,
        resolve,
        reject,
      });
      schedule();
    });
  }

  function validate(request: CommandRequest): string | undefined {
    if (
      typeof request?.type !== "string" ||
      !Object.hasOwn(commands, request.type)
    ) {
      return `unknown command type ${String(request?.type)}`;
    }
    const identity = request.identity;
    if (
      !DOMAINS.has(identity?.domain) ||
      typeof identity.key !== "string" ||
      identity.key === ""
    ) {
      return "command identity needs a domain and a non-empty key";
    }
    return undefined;
  }

  function schedule(): void {
    if (draining !== undefined || state !== "active" || queue.length === 0) {
      return;
    }
    draining = (async () => {
      try {
        while (state === "active" && queue.length > 0) {
          await runGroup(takeGroup());
        }
      } finally {
        draining = undefined;
      }
      schedule();
    })();
  }

  function takeGroup(): Pending[] {
    if (queue[0]!.solo) return queue.splice(0, 1);
    let size = 0;
    while (size < queue.length && size < maxGroup && !queue[size]!.solo) {
      size++;
    }
    return queue.splice(0, size);
  }

  async function runGroup(group: Pending[]): Promise<void> {
    let transaction: OwnerStoreTransaction<Tx>;
    try {
      transaction = await store.begin(epoch!);
    } catch (error) {
      groupFailed(group, error);
      return;
    }
    const executed: Executed[] = [];
    try {
      for (const pending of group) {
        executed.push(await execute(transaction, pending));
      }
    } catch (error) {
      await transaction.rollback().catch(() => undefined);
      groupFailed(group, error);
      return;
    }
    try {
      await transaction.commit();
    } catch (error) {
      groupFailed(group, error);
      return;
    }
    for (const result of executed) result.settle();
    const callbacks = executed.flatMap((result) => result.callbacks);
    if (callbacks.length > 0) void runCallbacks(callbacks);
  }

  async function execute(
    transaction: OwnerStoreTransaction<Tx>,
    pending: Pending,
  ): Promise<Executed> {
    const { request } = pending;
    const fingerprint = await pending.fingerprint;
    const receipt = await transaction.readReceipt(request.identity);
    if (receipt !== undefined) {
      const outcome: CommandOutcome =
        receipt.fingerprint === fingerprint
          ? { status: "duplicate", result: receipt.result }
          : {
              status: "invalid",
              reason: "identity already used by a different request",
            };
      return settled(pending, outcome);
    }

    await transaction.savepoint();
    const callbacks: (() => void | Promise<void>)[] = [];
    let open = true;
    const context: CommandContext = Object.freeze({
      identity: request.identity,
      epoch: epoch!,
      now: clock(),
      afterCommit(callback: () => void | Promise<void>) {
        if (!open) throw new TypeError("command has already finished");
        if (typeof callback !== "function") {
          throw new TypeError("afterCommit needs a function");
        }
        callbacks.push(callback);
      },
      refuse: (reason: string) => declare("refused", reason),
      invalid: (reason: string) => declare("invalid", reason),
      conflict: (reason: string) => declare("conflict", reason),
    });

    let returned: JsonValue;
    try {
      returned =
        (await commands[request.type]!(
          transaction.tx,
          request.input,
          context,
        )) ?? null;
    } catch (error) {
      open = false;
      await transaction.rollbackToSavepoint();
      const declared = declaredOutcome(error);
      if (declared !== undefined) return settled(pending, declared);
      return Object.freeze({
        pending,
        settle: () => pending.reject(error),
        callbacks: [],
      });
    }
    let result: JsonValue;
    try {
      // Taken before the next await, so a later command cannot change it.
      result = structuredClone(returned);
    } catch {
      open = false;
      await transaction.rollbackToSavepoint();
      return settled(pending, {
        status: "invalid",
        reason: "command result must be JSON",
      });
    }
    open = false;
    await transaction.writeReceipt(
      Object.freeze({ identity: request.identity, fingerprint, result }),
    );
    await transaction.release();
    return Object.freeze({
      ...settled(pending, { status: "committed", result }),
      callbacks,
    });
  }

  function groupFailed(group: Pending[], error: unknown): void {
    if (
      isOwnerError(error, "ownership_lost") ||
      isOwnerError(error, "commit_unknown")
    ) {
      halt(error, group);
      return;
    }
    // A definitive rollback: no command happened. Each is retried on its own.
    if (state !== "active") {
      for (const pending of group) pending.resolve(OWNERSHIP_LOST);
      return;
    }
    const retry = group.filter((pending) => !pending.solo);
    for (const pending of group) {
      if (pending.solo) pending.reject(error);
      else pending.solo = true;
    }
    queue.unshift(...retry);
  }

  function halt(reason: unknown, inFlight: readonly Pending[] = []): void {
    if (state === "stopped") {
      for (const pending of inFlight) pending.resolve(OWNERSHIP_LOST);
      return;
    }
    state = "stopped";
    for (const pending of [...inFlight, ...queue.splice(0)]) {
      pending.resolve(OWNERSHIP_LOST);
    }
    resolveStopped(reason);
  }

  async function runCallbacks(
    callbacks: readonly (() => void | Promise<void>)[],
  ): Promise<void> {
    for (const callback of callbacks) {
      try {
        await callback();
      } catch (error) {
        onError(error);
      }
    }
  }

  return Object.freeze({
    ready,
    stopped,
    submit,
    lookupReceipt: (identity: CommandIdentity) => store.readReceipt(identity),
    snapshot: () => Object.freeze({ state, epoch, queued: queue.length }),
    async stop() {
      halt(undefined);
      await draining;
    },
  });
}

function settled(pending: Pending, outcome: CommandOutcome): Executed {
  return Object.freeze({
    pending,
    settle: () => pending.resolve(Object.freeze(outcome)),
    callbacks: [],
  });
}

function declare(
  status: "refused" | "invalid" | "conflict",
  reason: string,
): never {
  throw Object.assign(new Error(reason), {
    [DECLARED]: Object.freeze({ status, reason: String(reason) }),
  });
}

function declaredOutcome(error: unknown): CommandOutcome | undefined {
  if (typeof error !== "object" || error === null || !(DECLARED in error)) {
    return undefined;
  }
  return (error as { [DECLARED]: CommandOutcome })[DECLARED];
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}
