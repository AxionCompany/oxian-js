import { basename, dirname, resolve } from "@std/path";
import { createHelloFrame } from "../protocol/control.ts";
import type { WorkerIdentity } from "../protocol/types.ts";
import { HTTP_WORKLOAD } from "../http/types.ts";
import type {
  AtomicResumeCredentialStore,
  WorkerResumeCredentialState,
} from "./types.ts";

const STORE_SCHEMA = "oxian.worker-resume.v1" as const;
const ownedStorePaths = new Set<string>();

type UnknownRecord = Record<string, unknown>;

function expectRecord(value: unknown, path: string): UnknownRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${path} must be a plain object`);
  }
  return value as UnknownRecord;
}

function expectExactKeys(
  value: UnknownRecord,
  keys: readonly string[],
  path: string,
): void {
  const expected = new Set(keys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !expected.has(key)) {
      throw new TypeError(`${path} contains unknown key "${String(key)}"`);
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`${path} is missing "${key}"`);
    }
  }
}

function sameIdentity(
  left: WorkerIdentity,
  right: WorkerIdentity,
): boolean {
  return left.workerId === right.workerId &&
    left.attemptId === right.attemptId &&
    left.epoch === right.epoch;
}

function parseStoredState(
  value: unknown,
  expectedIdentity: WorkerIdentity,
): WorkerResumeCredentialState {
  const record = expectRecord(value, "resume credential store");
  expectExactKeys(record, [
    "schema",
    "identity",
    "credential",
    "handshakeId",
    "resumeExpiresAtMs",
  ], "resume credential store");
  if (record.schema !== STORE_SCHEMA) {
    throw new TypeError(
      `resume credential store schema must be "${STORE_SCHEMA}"`,
    );
  }
  const credentialRecord = expectRecord(
    record.credential,
    "resume credential store.credential",
  );
  expectExactKeys(
    credentialRecord,
    ["kind", "capability"],
    "resume credential store.credential",
  );
  if (credentialRecord.kind !== "resume") {
    throw new TypeError(
      'resume credential store.credential.kind must be "resume"',
    );
  }
  if (
    typeof record.resumeExpiresAtMs !== "number" ||
    !Number.isSafeInteger(record.resumeExpiresAtMs) ||
    record.resumeExpiresAtMs < 0
  ) {
    throw new TypeError(
      "resume credential store.resumeExpiresAtMs must be a non-negative safe integer",
    );
  }

  const hello = createHelloFrame({
    handshakeId: record.handshakeId as string,
    identity: record.identity as WorkerIdentity,
    credential: credentialRecord as {
      kind: "resume";
      capability: string;
    },
    workloads: [HTTP_WORKLOAD],
    capacity: 1,
  });
  if (!sameIdentity(hello.identity, expectedIdentity)) {
    throw new TypeError(
      "resume credential store identity does not match the worker manifest",
    );
  }

  return Object.freeze({
    schema: STORE_SCHEMA,
    identity: hello.identity,
    credential: Object.freeze({
      kind: "resume" as const,
      capability: hello.credential.capability,
    }),
    handshakeId: hello.handshakeId,
    resumeExpiresAtMs: record.resumeExpiresAtMs,
  });
}

function sameState(
  left: WorkerResumeCredentialState,
  right: WorkerResumeCredentialState,
): boolean {
  return sameIdentity(left.identity, right.identity) &&
    left.credential.capability === right.credential.capability &&
    left.handshakeId === right.handshakeId &&
    left.resumeExpiresAtMs === right.resumeExpiresAtMs;
}

async function writeAll(
  file: Deno.FsFile,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await file.write(bytes.subarray(offset));
    if (written === 0) {
      throw new Error("resume credential store write made no progress");
    }
    offset += written;
  }
}

async function writeAtomic(
  path: string,
  state: WorkerResumeCredentialState,
): Promise<void> {
  const directory = dirname(path);
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(
    directory,
    `.${basename(path)}.${crypto.randomUUID()}.tmp`,
  );
  let opened: Deno.FsFile | undefined;
  try {
    opened = await Deno.open(temporary, {
      write: true,
      createNew: true,
      mode: 0o600,
    });
    const bytes = new TextEncoder().encode(
      JSON.stringify(state, null, 2) + "\n",
    );
    await writeAll(opened, bytes);
    await opened.sync();
    opened.close();
    opened = undefined;
    await Deno.rename(temporary, path);
    // Directory fsync is supported on the Unix targets used by Oxian
    // deployments. Some platforms reject opening directories, so retain the
    // atomic rename even when this final durability barrier is unavailable.
    let directoryFile: Deno.FsFile | undefined;
    try {
      directoryFile = await Deno.open(directory, { read: true });
      await directoryFile.sync();
    } catch {
      // Best effort for platforms without directory fsync.
    } finally {
      directoryFile?.close();
    }
  } finally {
    try {
      opened?.close();
    } catch {
      // The file was already closed after a successful flush.
    }
    await Deno.remove(temporary).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
}

/**
 * Creates a single-daemon resume store. An advisory lock remains held until
 * `close()` so another daemon cannot concurrently rotate the same credential
 * path. Commits are process-serialized, written to a same-directory temporary
 * file, flushed, atomically renamed, and followed by a directory fsync where
 * the platform supports it.
 */
export function createAtomicResumeCredentialStore(
  options: Readonly<{
    path: string;
    identity: WorkerIdentity;
    initialHandshakeId: string;
  }>,
): AtomicResumeCredentialStore {
  const path = resolve(options.path);
  const identity = createHelloFrame({
    handshakeId: options.initialHandshakeId,
    identity: options.identity,
    credential: { kind: "registration", capability: "validation" },
    workloads: [HTTP_WORKLOAD],
    capacity: 1,
  }).identity;
  let stored: WorkerResumeCredentialState | undefined;
  let loaded = false;
  let closingRequested = false;
  let ownsPath = false;
  let ownership: Promise<void> | undefined;
  let lockFile: Deno.FsFile | undefined;
  let loading: Promise<WorkerResumeCredentialState | undefined> | undefined;
  let serial = Promise.resolve();

  const ensureOwnership = (): Promise<void> => {
    if (ownership !== undefined) return ownership;
    ownership = (async () => {
      if (ownedStorePaths.has(path)) {
        throw new Error(
          "resume credential store path is already owned by this process",
        );
      }
      ownedStorePaths.add(path);
      ownsPath = true;
      try {
        await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
        lockFile = await Deno.open(`${path}.lock`, {
          read: true,
          write: true,
          create: true,
          mode: 0o600,
        });
        await lockFile.lock(true);
      } catch (error) {
        try {
          lockFile?.close();
        } catch {
          // Ignore cleanup failure while preserving the acquisition error.
        }
        lockFile = undefined;
        if (ownsPath) {
          ownedStorePaths.delete(path);
          ownsPath = false;
        }
        throw error;
      }
    })();
    return ownership;
  };

  const loadOnce = async (): Promise<
    WorkerResumeCredentialState | undefined
  > => {
    if (loaded) return stored;
    await ensureOwnership();
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        loaded = true;
        return undefined;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TypeError("resume credential store must contain valid JSON");
    }
    stored = parseStoredState(parsed, identity);
    loaded = true;
    return stored;
  };

  const loadCurrent = (): Promise<WorkerResumeCredentialState | undefined> => {
    if (loaded) return Promise.resolve(stored);
    loading ??= loadOnce();
    return loading;
  };

  const load = (): Promise<WorkerResumeCredentialState | undefined> => {
    if (closingRequested) {
      return Promise.reject(new Error("resume credential store is closed"));
    }
    return loadCurrent();
  };

  const persist: AtomicResumeCredentialStore["persist"] = (
    update,
  ): Promise<void> => {
    if (closingRequested) {
      return Promise.reject(new Error("resume credential store is closed"));
    }
    const operation = serial.then(async () => {
      const current = await loadCurrent();
      const candidate = parseStoredState({
        schema: STORE_SCHEMA,
        identity,
        credential: update.credential,
        handshakeId: update.handshakeId,
        resumeExpiresAtMs: update.resumeExpiresAtMs,
      }, identity);

      if (current !== undefined) {
        if (current.handshakeId === candidate.handshakeId) {
          if (!sameState(current, candidate)) {
            throw new Error(
              "resume credential compare-and-set replay differs from the stored state",
            );
          }
          return;
        }
        if (current.handshakeId !== update.replacesHandshakeId) {
          throw new Error(
            "resume credential compare-and-set predecessor does not match",
          );
        }
      } else if (update.replacesHandshakeId !== options.initialHandshakeId) {
        throw new Error(
          "resume credential compare-and-set initial predecessor does not match",
        );
      }

      await writeAtomic(path, candidate);
      stored = candidate;
      loaded = true;
    });
    serial = operation.catch(() => undefined);
    return operation;
  };

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    closingRequested = true;
    closing = serial.then(async () => {
      if (ownership !== undefined) await ownership.catch(() => undefined);
      if (lockFile !== undefined) {
        try {
          await lockFile.unlock();
        } finally {
          lockFile.close();
          lockFile = undefined;
        }
      }
      if (ownsPath) {
        ownedStorePaths.delete(path);
        ownsPath = false;
      }
    });
    return closing;
  };

  return Object.freeze({ path, load, persist, close });
}
