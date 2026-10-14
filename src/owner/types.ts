import type { JsonValue } from "../protocol/types.ts";

/**
 * Receipts are keyed per domain, so replaying one kind of step never returns
 * another kind's result.
 *
 * - `logical`: the same across attempts (invocation plus deterministic step).
 * - `incarnation`: new for every attempt (attempt plus step).
 * - `occurrence`: distinct by construction (source event plus time or sequence).
 */
export type IdentityDomain = "logical" | "incarnation" | "occurrence";

export type CommandIdentity = Readonly<{
  domain: IdentityDomain;
  key: string;
}>;

/** Callers send data, never closures: a registered command type plus input. */
export type CommandRequest = Readonly<{
  type: string;
  identity: CommandIdentity;
  input: JsonValue;
}>;

export type CommandOutcome =
  /** The command committed; its receipt is durable. */
  | Readonly<{ status: "committed"; result: JsonValue }>
  /** The identity already has a receipt for the same request. */
  | Readonly<{ status: "duplicate"; result: JsonValue }>
  /** Nothing happened; the same request may be retried. */
  | Readonly<{ status: "conflict"; reason: string }>
  /** Admission refused, by the command or by a full queue. Nothing happened. */
  | Readonly<{ status: "refused"; reason: string }>
  /** Validation failed, including an identity reused for a different request. */
  | Readonly<{ status: "invalid"; reason: string }>
  /**
   * This owner stopped before the outcome was known. Retry the same identity at
   * the current owner: a receipt means it committed; otherwise it runs once.
   */
  | Readonly<{ status: "ownership_lost" }>;

export type CommandContext = Readonly<{
  identity: CommandIdentity;
  epoch: number;
  /** This command's own timestamp; evaluate time predicates against it. */
  now: number;
  /** Runs only after the outer commit containing this command is durable. */
  afterCommit(callback: () => void | Promise<void>): void;
  /**
   * Appends one change and returns its sequence. A failed command, a rolled-back
   * group, and a compatible duplicate consume none.
   */
  append(body: JsonValue): Promise<number>;
  /** The sequence head visible to this command, including earlier commands in the group. */
  head(): Promise<number>;
  /** The owner's next wake-up. `undefined` clears it. */
  setAlarm(at: number | undefined): Promise<void>;
  refuse(reason: string): never;
  invalid(reason: string): never;
  conflict(reason: string): never;
}>;

/** The next time this owner should wake, and which write set it. */
export type OwnerAlarm = Readonly<{
  at: number;
  revision: number;
}>;

/** One live observer of the change sequence. A reset observer attaches again. */
export type ObserverState = Readonly<{
  cursor: number;
  applied: number | undefined;
  reset: boolean;
}>;

/** The committed sequence head. A client behind this head missed an update. */
export type Heartbeat = Readonly<{
  head: number;
}>;

/** A transaction program: reads current state, decides and writes. */
export type CommandHandler<Tx> = (
  tx: Tx,
  input: JsonValue,
  context: CommandContext,
) => JsonValue | Promise<JsonValue>;

export type Receipt = Readonly<{
  identity: CommandIdentity;
  /** Digest of the command type and input that produced this receipt. */
  fingerprint: string;
  result: JsonValue;
}>;

/**
 * One outer transaction. Commands run inside it in order, each between
 * `savepoint()` and either `release()` or `rollbackToSavepoint()`.
 */
export type OwnerStoreTransaction<Tx> = Readonly<{
  tx: Tx;
  savepoint(): Promise<void>;
  release(): Promise<void>;
  rollbackToSavepoint(): Promise<void>;
  readReceipt(identity: CommandIdentity): Promise<Receipt | undefined>;
  writeReceipt(receipt: Receipt): Promise<void>;
  append(body: JsonValue): Promise<number>;
  head(): Promise<number>;
  setAlarm(at: number | undefined): Promise<void>;
  /**
   * Rejects with an `OwnerError` coded `commit_unknown` when the outcome is
   * unknown, and with any other error when nothing was committed. The
   * transaction is finished either way: the store has committed or rolled
   * back, and released its fence.
   */
  commit(): Promise<void>;
  rollback(): Promise<void>;
}>;

/** One owner's durable state, addressed by whatever id the caller stored it under. */
export type OwnerStore<Tx> = Readonly<{
  /**
   * Takes ownership by incrementing the epoch. Waits until no transaction of
   * an older epoch is open, so an uncertain commit is resolved first.
   */
  acquire(): Promise<number>;
  /**
   * Opens a transaction fenced to `epoch`. Rejects with an `OwnerError` coded
   * `ownership_lost` once a newer epoch exists.
   */
  begin(epoch: number): Promise<OwnerStoreTransaction<Tx>>;
  /** Reads a committed receipt. Allowed for any epoch. */
  readReceipt(identity: CommandIdentity): Promise<Receipt | undefined>;
  /** The committed sequence head. 0 before any change. */
  readHead(): Promise<number>;
  /** The committed alarm, if one is set. */
  readAlarm(): Promise<OwnerAlarm | undefined>;
  /**
   * A read-only view of committed state. Later commits are not visible.
   * `close` ends it.
   */
  beginSnapshot(): Promise<OwnerReadTransaction<Tx>>;
  /** The committed epoch, without acquiring. 0 before the first acquire. */
  readEpoch(): Promise<number>;
}>;

/** A read-only transaction outside the command loop. */
export type OwnerReadTransaction<Tx> = Readonly<{
  tx: Tx;
  close(): Promise<void>;
}>;

export type OwnerOptions<Tx> = Readonly<{
  store: OwnerStore<Tx>;
  commands: Readonly<Record<string, CommandHandler<Tx>>>;
  clock?: () => number;
  /** Commands per outer transaction. Defaults to 1,024. */
  maxGroupCommands?: number;
  /** Commands waiting for a group. Further submissions are refused. Defaults to 4,096. */
  maxQueuedCommands?: number;
  /** Receives errors thrown by `afterCommit` callbacks. Defaults to `console.error`. */
  onError?: (error: unknown) => void;
  /** Wakes the owner when its alarm is due, including after a takeover. */
  onAlarm?: (at: number) => void | Promise<void>;
  /**
   * Schedules `run` at absolute time `at`. Returns a cancel function.
   * Defaults to `setTimeout`.
   */
  scheduleAlarm?: (at: number, run: () => void) => () => void;
}>;

export type OwnerState = "activating" | "active" | "stopped";

export type OwnerSnapshot = Readonly<{
  state: OwnerState;
  epoch: number | undefined;
  queued: number;
}>;

export type Owner = Readonly<{
  /** Resolves once the epoch is acquired; rejects if activation fails. */
  ready: Promise<void>;
  /** Settles after the owner stops, with the reason it stopped. */
  stopped: Promise<unknown>;
  submit(request: CommandRequest): Promise<CommandOutcome>;
  lookupReceipt(identity: CommandIdentity): Promise<Receipt | undefined>;
  /** The committed sequence head. */
  heartbeat(): Promise<Heartbeat>;
  /**
   * Captures the sequence head for `observer`, in the command queue so the
   * cursor commits atomically with the changes it includes.
   */
  attach(observer: string): Promise<{ cursor: number }>;
  /** Records the last sequence `observer` has applied. Ignored after a reset. */
  acknowledge(observer: string, seq: number): void;
  /** A failed or dropped push. The observer must attach again. */
  resetObserver(observer: string): void;
  observer(observer: string): ObserverState | undefined;
  snapshot(): OwnerSnapshot;
  /** Finishes the current group; queued commands end `ownership_lost`. */
  stop(): Promise<void>;
}>;

export type OwnerErrorCode = "ownership_lost" | "commit_unknown";

export type OwnerError = Error & Readonly<{ code: OwnerErrorCode }>;
