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
  refuse(reason: string): never;
  invalid(reason: string): never;
  conflict(reason: string): never;
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
  snapshot(): OwnerSnapshot;
  /** Finishes the current group; queued commands end `ownership_lost`. */
  stop(): Promise<void>;
}>;

export type OwnerErrorCode = "ownership_lost" | "commit_unknown";

export type OwnerError = Error & Readonly<{ code: OwnerErrorCode }>;
