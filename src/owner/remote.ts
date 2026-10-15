import { createOwnerError } from "./primitives.ts";
import type {
  CommandIdentity,
  CommandOutcome,
  CommandRequest,
  Owner,
  OwnerStore,
  Receipt,
} from "./types.ts";

/** Idle time before a snapshot expires. A read renews it. */
export const SNAPSHOT_IDLE_MS = 30_000;
/** A snapshot cannot outlive this, however often it is read. */
export const SNAPSHOT_LIFETIME_MS = 300_000;

/**
 * Who a remote session is. `ownerEpoch` is the owner's fence, not the worker
 * attempt epoch on the v1 hello frame.
 */
export type RemoteSessionIdentity = Readonly<{
  ownerId: string;
  ownerEpoch: number;
  connectionId: string;
}>;

export type CommandSession = Readonly<{
  identity: RemoteSessionIdentity;
  submit(request: CommandRequest): Promise<CommandOutcome>;
  lookupReceipt(identity: CommandIdentity): Promise<Receipt | undefined>;
}>;

export type SnapshotSession<Tx> = Readonly<{
  identity: RemoteSessionIdentity;
  read<T>(fn: (tx: Tx) => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
}>;

/** A session that may submit commands only while its owner epoch is current. */
export function createCommandSession(options: {
  owner: Owner;
  ownerId: string;
  connectionId: string;
}): CommandSession {
  const identity = sessionIdentity(options.owner, options);
  return Object.freeze({
    identity,
    submit(request: CommandRequest) {
      if (!current(options.owner, identity.ownerEpoch)) {
        return Promise.resolve({ status: "ownership_lost" as const });
      }
      return options.owner.submit(request);
    },
    lookupReceipt: (command: CommandIdentity) =>
      options.owner.lookupReceipt(command),
  });
}

/**
 * A read-only session. It closes on completion, a failed read, cancellation,
 * takeover, or expiry.
 */
export async function createSnapshotSession<Tx>(options: {
  owner: Owner;
  store: OwnerStore<Tx>;
  ownerId: string;
  connectionId: string;
  clock?: () => number;
  idleMs?: number;
  lifetimeMs?: number;
  signal?: AbortSignal;
}): Promise<SnapshotSession<Tx>> {
  const identity = sessionIdentity(options.owner, options);
  const clock = options.clock ?? Date.now;
  const idle = positive(options.idleMs ?? SNAPSHOT_IDLE_MS, "idleMs");
  const lifetime = positive(
    options.lifetimeMs ?? SNAPSHOT_LIFETIME_MS,
    "lifetimeMs",
  );
  const opened = clock();
  let lastRead = opened;
  let closed = false;
  let terminal: Error | undefined;
  let rejectPending: ((error: unknown) => void) | undefined;
  let cancelDeadline: (() => void) | undefined;
  let stopEpochWatch: () => void = () => undefined;
  const transaction = await options.store.beginSnapshot();

  function onAbort(): void {
    terminate(new Error("snapshot cancelled"));
  }

  function stopWatching(): void {
    cancelDeadline?.();
    cancelDeadline = undefined;
    stopEpochWatch();
    options.signal?.removeEventListener("abort", onAbort);
  }

  async function finish(): Promise<void> {
    if (closed) return;
    closed = true;
    stopWatching();
    await transaction.close();
  }

  function terminate(error: Error): void {
    terminal ??= error;
    const reject = rejectPending;
    rejectPending = undefined;
    void finish();
    reject?.(terminal);
  }

  function armDeadline(): void {
    if (closed) return;
    cancelDeadline?.();
    const delay = Math.min(
      Math.max(0, Math.min(lastRead + idle, opened + lifetime) - clock()),
      2_147_483_647,
    );
    const timer = setTimeout(() => {
      if (closed) return;
      if (clock() - opened >= lifetime || clock() - lastRead >= idle) {
        terminate(new Error("snapshot expired"));
        return;
      }
      armDeadline();
    }, delay);
    forget(timer);
    cancelDeadline = () => clearTimeout(timer);
  }

  async function failIfUnusable(): Promise<void> {
    if (terminal !== undefined) throw terminal;
    if (closed) throw new Error("snapshot closed");
    if (options.signal?.aborted) {
      throw new Error("snapshot cancelled");
    }
    const now = clock();
    if (now - opened >= lifetime || now - lastRead >= idle) {
      throw new Error("snapshot expired");
    }
    const epoch = await options.store.readEpoch();
    if (terminal !== undefined) throw terminal;
    if (closed) throw new Error("snapshot closed");
    if (
      epoch !== identity.ownerEpoch ||
      !current(options.owner, identity.ownerEpoch)
    ) {
      throw createOwnerError("ownership_lost", "owner epoch changed");
    }
  }

  const epochWatch = setInterval(() => {
    void options.store.readEpoch().then(
      (epoch) => {
        if (!closed && epoch !== identity.ownerEpoch) {
          terminate(createOwnerError("ownership_lost", "owner epoch changed"));
        }
      },
      () => undefined,
    );
  }, 200);
  forget(epochWatch);
  stopEpochWatch = () => clearInterval(epochWatch);

  options.signal?.addEventListener("abort", onAbort, { once: true });
  armDeadline();

  if (!current(options.owner, identity.ownerEpoch)) {
    await finish();
    throw createOwnerError("ownership_lost", "owner epoch changed");
  }

  return Object.freeze({
    identity,
    async read<T>(fn: (tx: Tx) => T | Promise<T>): Promise<T> {
      try {
        await failIfUnusable();
        lastRead = clock();
        armDeadline();
        return await new Promise<T>((resolve, reject) => {
          rejectPending = reject;
          Promise.resolve()
            .then(() => fn(transaction.tx))
            .then((value) => {
              if (closed) reject(new Error("snapshot closed"));
              else resolve(value);
            }, reject);
        });
      } catch (error) {
        await finish();
        throw error;
      } finally {
        rejectPending = undefined;
      }
    },
    close: finish,
  });
}

function sessionIdentity(
  owner: Owner,
  options: { ownerId: string; connectionId: string },
): RemoteSessionIdentity {
  if (options.ownerId === "" || options.connectionId === "") {
    throw new TypeError("owner id and connection id must be non-empty");
  }
  const live = owner.snapshot();
  if (live.epoch === undefined || live.state !== "active") {
    throw new Error("owner is not ready");
  }
  return Object.freeze({
    ownerId: options.ownerId,
    ownerEpoch: live.epoch,
    connectionId: options.connectionId,
  });
}

function current(owner: Owner, epoch: number): boolean {
  const live = owner.snapshot();
  return live.state === "active" && live.epoch === epoch;
}

function forget(timer: unknown): void {
  if (typeof timer !== "object" || timer === null || !("unref" in timer)) {
    return;
  }
  const { unref } = timer;
  if (typeof unref === "function") unref.call(timer);
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}
