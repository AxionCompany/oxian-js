import type { HypervisorConfig } from "../config.ts";
import type { ConnectionRecord } from "./model.ts";

export type AdmissionSnapshot = Readonly<{
  unauthenticatedConnections: number;
  authenticatedConnections: number;
  handshakeOperations: number;
  readyOperations: number;
}>;

export type AdmissionController = Readonly<{
  admit(record: ConnectionRecord): void;
  assertAuthenticatedAvailable(): void;
  reserveAuthenticated(record: ConnectionRecord): void;
  completeAuthentication(record: ConnectionRecord): void;
  releaseClosed(record: ConnectionRecord): void;
  awaitExternal<T>(
    record: ConnectionRecord,
    kind: "handshake" | "ready",
    operation: () => T | PromiseLike<T>,
  ): Promise<T>;
  snapshot(): AdmissionSnapshot;
}>;

/**
 * Owns connection and external-hook admission counters.
 *
 * Underlying integration hooks remain counted after a socket abort until their
 * own promises settle, so a hanging authority/repository adapter cannot evade
 * the process admission limits.
 */
export function createAdmissionController(
  config: HypervisorConfig,
): AdmissionController {
  let unauthenticatedConnections = 0;
  let authenticatedConnections = 0;
  let handshakeOperations = 0;
  let readyOperations = 0;

  const releaseClosed = (record: ConnectionRecord): void => {
    if (record.phase !== "closed") return;
    if (
      record.unauthenticatedSlot &&
      record.handshakeExternalOperations === 0
    ) {
      record.unauthenticatedSlot = false;
      unauthenticatedConnections--;
    }
    if (
      record.authenticatedSlot &&
      record.handshakeExternalOperations === 0 &&
      record.readyExternalOperations === 0
    ) {
      record.authenticatedSlot = false;
      authenticatedConnections--;
    }
  };

  const admit = (record: ConnectionRecord): void => {
    if (record.unauthenticatedSlot) {
      throw new TypeError("connection already owns an unauthenticated slot");
    }
    record.unauthenticatedSlot = true;
    unauthenticatedConnections++;
  };

  const assertAuthenticatedAvailable = (): void => {
    if (authenticatedConnections >= config.maxAuthenticatedConnections) {
      throw Object.assign(
        new Error("authenticated worker connection limit reached"),
        { code: "connection_limit" },
      );
    }
  };

  const reserveAuthenticated = (record: ConnectionRecord): void => {
    assertAuthenticatedAvailable();
    if (record.authenticatedSlot) {
      throw new TypeError("connection already owns an authenticated slot");
    }
    record.authenticatedSlot = true;
    authenticatedConnections++;
  };

  const completeAuthentication = (record: ConnectionRecord): void => {
    if (!record.unauthenticatedSlot) {
      throw new TypeError("connection has no unauthenticated slot");
    }
    record.unauthenticatedSlot = false;
    unauthenticatedConnections--;
  };

  const awaitExternal = <T>(
    record: ConnectionRecord,
    kind: "handshake" | "ready",
    operation: () => T | PromiseLike<T>,
  ): Promise<T> => {
    record.abort.signal.throwIfAborted();
    if (kind === "handshake") {
      handshakeOperations++;
      record.handshakeExternalOperations++;
    } else {
      readyOperations++;
      record.readyExternalOperations++;
    }
    const underlying = Promise.resolve().then(() => {
      record.abort.signal.throwIfAborted();
      return operation();
    });
    const settled = (): void => {
      if (kind === "handshake") {
        handshakeOperations--;
        record.handshakeExternalOperations--;
      } else {
        readyOperations--;
        record.readyExternalOperations--;
      }
      releaseClosed(record);
    };
    const tracked = underlying.then(
      (value) => {
        settled();
        return value;
      },
      (error) => {
        settled();
        throw error;
      },
    );
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        record.abort.signal.removeEventListener("abort", abort);
        reject(record.abort.signal.reason);
      };
      record.abort.signal.addEventListener("abort", abort, { once: true });
      tracked.then(
        (value) => {
          record.abort.signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error) => {
          record.abort.signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  };

  const snapshot = (): AdmissionSnapshot =>
    Object.freeze({
      unauthenticatedConnections,
      authenticatedConnections,
      handshakeOperations,
      readyOperations,
    });

  return Object.freeze({
    admit,
    assertAuthenticatedAvailable,
    reserveAuthenticated,
    completeAuthentication,
    releaseClosed,
    awaitExternal,
    snapshot,
  });
}
