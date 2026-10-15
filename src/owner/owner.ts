import type { JsonValue } from "../protocol/types.ts";
import {
  createOwnerError,
  fingerprintRequest,
  isOwnerError,
  snapshotRequest,
} from "./primitives.ts";
import type {
  CommandContext,
  CommandIdentity,
  CommandOutcome,
  CommandRequest,
  Heartbeat,
  ObserverState,
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

type CommandPending = {
  readonly kind: "command";
  readonly request: CommandRequest;
  readonly fingerprint: Promise<string>;
  /** Set after a definitive rollback: the command is retried on its own. */
  solo: boolean;
  resolve(outcome: CommandOutcome): void;
  reject(error: unknown): void;
};

type AttachPending = {
  readonly kind: "attach";
  readonly observer: string;
  readonly generation: number;
  solo: boolean;
  resolve(cursor: number): void;
  reject(error: unknown): void;
};

type Pending = CommandPending | AttachPending;

type LiveObserver = {
  cursor: number;
  applied: number | undefined;
  reset: boolean;
  generation: number;
};

type Executed = Readonly<{
  pending: Pending;
  settle(): void;
  /** Records the group's sequence head before commit. Attach uses it. */
  capture(head: number): void;
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
  const onAlarm = options.onAlarm;
  const scheduleAlarm =
    options.scheduleAlarm ??
    ((at: number, run: () => void) => {
      const delay = Math.min(Math.max(0, at - clock()), 2_147_483_647);
      const timer = setTimeout(run, delay);
      return () => clearTimeout(timer);
    });

  const queue: Pending[] = [];
  const observers = new Map<string, LiveObserver>();
  let cancelAlarm: (() => void) | undefined;
  let arming = 0;
  let lastFired: number | undefined;
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
    arm();
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
        kind: "command",
        request: submitted,
        fingerprint,
        solo: false,
        resolve,
        reject,
      });
      schedule();
    });
  }

  function attach(observer: string): Promise<{ cursor: number }> {
    if (observer === "") {
      return Promise.reject(new TypeError("observer needs a name"));
    }
    if (state === "stopped") {
      return Promise.reject(
        createOwnerError("ownership_lost", "owner stopped"),
      );
    }
    if (queue.length >= maxQueued) {
      return Promise.reject(new Error("owner_overloaded"));
    }
    const generation = observers.get(observer)?.generation ?? 0;
    return new Promise<{ cursor: number }>((resolve, reject) => {
      queue.push({
        kind: "attach",
        observer,
        generation,
        solo: false,
        resolve: (cursor) => resolve({ cursor }),
        reject,
      });
      schedule();
    });
  }

  function acknowledge(observer: string, seq: number): void {
    const current = observers.get(observer);
    if (current === undefined || current.reset) return;
    if (!Number.isSafeInteger(seq) || seq < (current.applied ?? -1)) return;
    observers.set(observer, { ...current, applied: seq });
  }

  function resetObserver(observer: string): void {
    const current = observers.get(observer);
    observers.set(observer, {
      cursor: current?.cursor ?? 0,
      applied: undefined,
      reset: true,
      generation: (current?.generation ?? 0) + 1,
    });
  }

  function observer(observer: string): ObserverState | undefined {
    const current = observers.get(observer);
    if (current === undefined) return undefined;
    return Object.freeze({
      cursor: current.cursor,
      applied: current.applied,
      reset: current.reset,
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
      if (executed.some((result) => result.pending.kind === "attach")) {
        const head = await transaction.head();
        for (const result of executed) result.capture(head);
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
    arm();
    const callbacks = executed.flatMap((result) => result.callbacks);
    if (callbacks.length > 0) void runCallbacks(callbacks);
  }

  async function execute(
    transaction: OwnerStoreTransaction<Tx>,
    pending: Pending,
  ): Promise<Executed> {
    if (pending.kind === "attach") return executeAttach(pending);
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
      async append(body: JsonValue) {
        if (!open) throw new TypeError("command has already finished");
        return await transaction.append(structuredClone(body));
      },
      async head() {
        if (!open) throw new TypeError("command has already finished");
        return await transaction.head();
      },
      async setAlarm(at: number | undefined) {
        if (!open) throw new TypeError("command has already finished");
        if (at !== undefined && !Number.isSafeInteger(at)) {
          throw new TypeError("alarm time must be an integer");
        }
        await transaction.setAlarm(at);
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
        capture() {},
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

  function executeAttach(pending: AttachPending): Executed {
    let cursor = 0;
    return Object.freeze({
      pending,
      capture(head: number) {
        cursor = head;
      },
      settle() {
        const current = observers.get(pending.observer);
        if (
          current !== undefined &&
          current.generation !== pending.generation
        ) {
          pending.reject(new Error("observer reset"));
          return;
        }
        observers.set(pending.observer, {
          cursor,
          applied: cursor,
          reset: false,
          generation: pending.generation,
        });
        pending.resolve(cursor);
      },
      callbacks: [],
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
      for (const pending of group) lose(pending);
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
    cancelAlarm?.();
    cancelAlarm = undefined;
    arming += 1;
    if (state === "stopped") {
      for (const pending of inFlight) lose(pending);
      return;
    }
    state = "stopped";
    for (const pending of [...inFlight, ...queue.splice(0)]) lose(pending);
    resolveStopped(reason);
  }

  function arm(): void {
    const ticket = ++arming;
    cancelAlarm?.();
    cancelAlarm = undefined;
    void store.readAlarm().then(
      (alarm) => {
        if (ticket !== arming || state !== "active") return;
        if (alarm === undefined) {
          lastFired = undefined;
          return;
        }
        if (alarm.revision === lastFired) return;
        if (alarm.at > clock()) {
          cancelAlarm = scheduleAlarm(alarm.at, () => {
            if (ticket !== arming || state !== "active") return;
            if (alarm.at > clock()) {
              arm();
              return;
            }
            if (alarm.revision === lastFired) return;
            lastFired = alarm.revision;
            void Promise.resolve(onAlarm?.(alarm.at)).catch(onError);
          });
          return;
        }
        lastFired = alarm.revision;
        void Promise.resolve(onAlarm?.(alarm.at)).catch(onError);
      },
      (error) => {
        onError(error);
        if (ticket !== arming || state !== "active") return;
        cancelAlarm = scheduleAlarm(clock() + 1_000, () => {
          if (ticket === arming && state === "active") arm();
        });
      },
    );
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

  function heartbeat(): Promise<Heartbeat> {
    return store.readHead().then((head) => Object.freeze({ head }));
  }

  return Object.freeze({
    ready,
    stopped,
    submit,
    lookupReceipt: (identity: CommandIdentity) => store.readReceipt(identity),
    heartbeat,
    attach,
    acknowledge,
    resetObserver,
    observer,
    snapshot: () => Object.freeze({ state, epoch, queued: queue.length }),
    async stop() {
      halt(undefined);
      await draining;
    },
  });
}

function settled(pending: CommandPending, outcome: CommandOutcome): Executed {
  return Object.freeze({
    pending,
    capture() {},
    settle: () => pending.resolve(Object.freeze(outcome)),
    callbacks: [],
  });
}

function lose(pending: Pending): void {
  if (pending.kind === "attach") {
    pending.reject(createOwnerError("ownership_lost", "owner stopped"));
    return;
  }
  pending.resolve(OWNERSHIP_LOST);
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
