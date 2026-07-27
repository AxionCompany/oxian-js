import { BINARY_PROTOCOL } from "../protocol/binary.ts";
import { WORKER_PROTOCOL_LIMITS } from "../protocol/limits.ts";

const MAX_TIMER_MS = 0x7fff_ffff;
const MAX_CONNECTIONS = 1_000_000;
const MAX_INBOUND_MESSAGES = 65_536;
const MAX_INBOUND_BYTES = 256 * 1_024 * 1_024;
const MAX_BUFFERED_AMOUNT_BYTES = 64 * 1_024 * 1_024;

export type HypervisorConfig = Readonly<{
  workerPath: string;
  handshakeTimeoutMs: number;
  readyTimeoutMs: number;
  heartbeatIntervalMs: number;
  leaseTimeoutMs: number;
  leaseSweepIntervalMs: number;
  shutdownTimeoutMs: number;
  cancellationAckTimeoutMs: number;
  maxConnectionAgeMs: number;
  proactiveDrainMarginMs: number;
  maxConnections: number;
  maxUnauthenticatedConnections: number;
  maxAuthenticatedConnections: number;
  maxPendingAcceptanceCommits: number;
  maxPendingAcceptanceCommitsPerWorker: number;
  maxInboundMessages: number;
  maxInboundBytes: number;
  maxBufferedAmountBytes: number;
  maxWorkerCapacity: number;
  maxLifetimeStreams: number;
  maxDataPayloadBytes: number;
  maxReceiveCreditBytes: number;
}>;

export const DEFAULT_HYPERVISOR_CONFIG: HypervisorConfig = Object
  .freeze({
    workerPath: "/_oxian/workers/connect",
    handshakeTimeoutMs: 10_000,
    readyTimeoutMs: 5 * 60_000,
    heartbeatIntervalMs: 10_000,
    leaseTimeoutMs: 30_000,
    leaseSweepIntervalMs: 1_000,
    shutdownTimeoutMs: 30_000,
    cancellationAckTimeoutMs: 10_000,
    maxConnectionAgeMs: 50 * 60_000,
    proactiveDrainMarginMs: 60_000,
    maxConnections: 10_000,
    maxUnauthenticatedConnections: 128,
    maxAuthenticatedConnections: 10_000,
    maxPendingAcceptanceCommits: 1_024,
    maxPendingAcceptanceCommitsPerWorker: 64,
    maxInboundMessages: 256,
    maxInboundBytes: 16 * 1_024 * 1_024,
    maxBufferedAmountBytes: 4 * 1_024 * 1_024,
    maxWorkerCapacity: WORKER_PROTOCOL_LIMITS.maxWorkerCapacity,
    maxLifetimeStreams: WORKER_PROTOCOL_LIMITS.maxLifetimeStreams,
    maxDataPayloadBytes: WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes,
    maxReceiveCreditBytes:
      WORKER_PROTOCOL_LIMITS.maxOutstandingStreamCreditBytes,
  });

function expectTimer(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_TIMER_MS
  ) {
    throw new TypeError(
      `${name} must be a positive integer no greater than ${MAX_TIMER_MS}`,
    );
  }
  return value;
}

function expectLimit(
  value: unknown,
  name: string,
  hardLimit: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > hardLimit
  ) {
    throw new TypeError(
      `${name} must be a positive integer no greater than ${hardLimit}`,
    );
  }
  return value;
}

function expectBoundedInteger(
  value: unknown,
  name: string,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    throw new TypeError(
      `${name} must be a positive integer no greater than ${maximum}`,
    );
  }
  return value;
}

function expectWorkerPath(value: unknown): string {
  let canonical = false;
  if (typeof value === "string") {
    try {
      const base = new URL("https://oxian.invalid/");
      const parsed = new URL(value, base);
      canonical = parsed.origin === base.origin && parsed.pathname === value &&
        parsed.search === "" && parsed.hash === "";
    } catch {
      canonical = false;
    }
  }
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value[0] !== "/" ||
    value.startsWith("//") ||
    value.endsWith("/") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\") ||
    !canonical
  ) {
    throw new TypeError(
      "workerPath must be an absolute path without a trailing slash, query, fragment, or backslash, and must be URL-canonical without dot segments or an authority",
    );
  }
  return value;
}

export function createHypervisorConfig(
  input: Partial<HypervisorConfig> = {},
): HypervisorConfig {
  const defaults = DEFAULT_HYPERVISOR_CONFIG;
  const config = {
    workerPath: expectWorkerPath(
      input.workerPath ?? defaults.workerPath,
    ),
    handshakeTimeoutMs: expectTimer(
      input.handshakeTimeoutMs ??
        defaults.handshakeTimeoutMs,
      "handshakeTimeoutMs",
    ),
    readyTimeoutMs: expectTimer(
      input.readyTimeoutMs ??
        defaults.readyTimeoutMs,
      "readyTimeoutMs",
    ),
    heartbeatIntervalMs: expectTimer(
      input.heartbeatIntervalMs ??
        defaults.heartbeatIntervalMs,
      "heartbeatIntervalMs",
    ),
    leaseTimeoutMs: expectTimer(
      input.leaseTimeoutMs ?? defaults.leaseTimeoutMs,
      "leaseTimeoutMs",
    ),
    leaseSweepIntervalMs: expectTimer(
      input.leaseSweepIntervalMs ??
        defaults.leaseSweepIntervalMs,
      "leaseSweepIntervalMs",
    ),
    shutdownTimeoutMs: expectTimer(
      input.shutdownTimeoutMs ??
        defaults.shutdownTimeoutMs,
      "shutdownTimeoutMs",
    ),
    cancellationAckTimeoutMs: expectTimer(
      input.cancellationAckTimeoutMs ??
        defaults.cancellationAckTimeoutMs,
      "cancellationAckTimeoutMs",
    ),
    maxConnectionAgeMs: expectTimer(
      input.maxConnectionAgeMs ??
        defaults.maxConnectionAgeMs,
      "maxConnectionAgeMs",
    ),
    proactiveDrainMarginMs: expectTimer(
      input.proactiveDrainMarginMs ??
        defaults.proactiveDrainMarginMs,
      "proactiveDrainMarginMs",
    ),
    maxConnections: expectBoundedInteger(
      input.maxConnections ?? defaults.maxConnections,
      "maxConnections",
      MAX_CONNECTIONS,
    ),
    maxUnauthenticatedConnections: expectBoundedInteger(
      input.maxUnauthenticatedConnections ??
        defaults.maxUnauthenticatedConnections,
      "maxUnauthenticatedConnections",
      MAX_CONNECTIONS,
    ),
    maxAuthenticatedConnections: expectBoundedInteger(
      input.maxAuthenticatedConnections ??
        defaults.maxAuthenticatedConnections,
      "maxAuthenticatedConnections",
      MAX_CONNECTIONS,
    ),
    maxPendingAcceptanceCommits: expectBoundedInteger(
      input.maxPendingAcceptanceCommits ??
        defaults.maxPendingAcceptanceCommits,
      "maxPendingAcceptanceCommits",
      MAX_CONNECTIONS,
    ),
    maxPendingAcceptanceCommitsPerWorker: expectBoundedInteger(
      input.maxPendingAcceptanceCommitsPerWorker ??
        defaults.maxPendingAcceptanceCommitsPerWorker,
      "maxPendingAcceptanceCommitsPerWorker",
      MAX_CONNECTIONS,
    ),
    maxInboundMessages: expectBoundedInteger(
      input.maxInboundMessages ??
        defaults.maxInboundMessages,
      "maxInboundMessages",
      MAX_INBOUND_MESSAGES,
    ),
    maxInboundBytes: expectBoundedInteger(
      input.maxInboundBytes ??
        defaults.maxInboundBytes,
      "maxInboundBytes",
      MAX_INBOUND_BYTES,
    ),
    maxBufferedAmountBytes: expectBoundedInteger(
      input.maxBufferedAmountBytes ??
        defaults.maxBufferedAmountBytes,
      "maxBufferedAmountBytes",
      MAX_BUFFERED_AMOUNT_BYTES,
    ),
    maxWorkerCapacity: expectLimit(
      input.maxWorkerCapacity ??
        defaults.maxWorkerCapacity,
      "maxWorkerCapacity",
      WORKER_PROTOCOL_LIMITS.maxWorkerCapacity,
    ),
    maxLifetimeStreams: expectLimit(
      input.maxLifetimeStreams ??
        defaults.maxLifetimeStreams,
      "maxLifetimeStreams",
      WORKER_PROTOCOL_LIMITS.maxLifetimeStreams,
    ),
    maxDataPayloadBytes: expectLimit(
      input.maxDataPayloadBytes ??
        defaults.maxDataPayloadBytes,
      "maxDataPayloadBytes",
      WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes,
    ),
    maxReceiveCreditBytes: expectLimit(
      input.maxReceiveCreditBytes ??
        defaults.maxReceiveCreditBytes,
      "maxReceiveCreditBytes",
      WORKER_PROTOCOL_LIMITS.maxOutstandingStreamCreditBytes,
    ),
  };

  if (config.leaseTimeoutMs <= config.heartbeatIntervalMs) {
    throw new TypeError(
      "leaseTimeoutMs must be greater than heartbeatIntervalMs",
    );
  }
  if (config.leaseSweepIntervalMs >= config.leaseTimeoutMs) {
    throw new TypeError(
      "leaseSweepIntervalMs must be less than leaseTimeoutMs",
    );
  }
  if (config.maxUnauthenticatedConnections > config.maxConnections) {
    throw new TypeError(
      "maxUnauthenticatedConnections must not exceed maxConnections",
    );
  }
  if (config.maxAuthenticatedConnections > config.maxConnections) {
    throw new TypeError(
      "maxAuthenticatedConnections must not exceed maxConnections",
    );
  }
  if (
    config.maxPendingAcceptanceCommitsPerWorker >
      config.maxPendingAcceptanceCommits
  ) {
    throw new TypeError(
      "maxPendingAcceptanceCommitsPerWorker must not exceed maxPendingAcceptanceCommits",
    );
  }
  if (config.proactiveDrainMarginMs >= config.maxConnectionAgeMs) {
    throw new TypeError(
      "proactiveDrainMarginMs must be less than maxConnectionAgeMs",
    );
  }
  if (
    config.maxInboundBytes <
      config.maxDataPayloadBytes + BINARY_PROTOCOL.headerBytes
  ) {
    throw new TypeError(
      "maxInboundBytes must fit one configured binary data frame",
    );
  }
  if (
    config.maxBufferedAmountBytes <
      config.maxDataPayloadBytes + BINARY_PROTOCOL.headerBytes
  ) {
    throw new TypeError(
      "maxBufferedAmountBytes must fit one configured binary data frame",
    );
  }

  return Object.freeze(config);
}
