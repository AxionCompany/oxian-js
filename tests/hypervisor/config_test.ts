import { test } from "node:test";
import assert from "node:assert/strict";
import { assertThrows } from "../support/assert.ts";
import { WORKER_PROTOCOL_LIMITS } from "../../src/protocol/limits.ts";
import {
  createHypervisorConfig,
  DEFAULT_HYPERVISOR_CONFIG,
} from "../../src/hypervisor/config.ts";

test("v0.21 hypervisor config has bounded immutable defaults", () => {
  const config = createHypervisorConfig();

  assert.deepStrictEqual(config, DEFAULT_HYPERVISOR_CONFIG);
  assert.deepStrictEqual(
    config.maxDataPayloadBytes,
    WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes,
  );
  assert.deepStrictEqual(Object.isFrozen(config), true);
});

test("v0.21 hypervisor config accepts stricter protocol admission limits", () => {
  const config = createHypervisorConfig({
    handshakeTimeoutMs: 2_000,
    readyTimeoutMs: 20_000,
    heartbeatIntervalMs: 3_000,
    leaseTimeoutMs: 9_000,
    leaseSweepIntervalMs: 500,
    shutdownTimeoutMs: 4_000,
    cancellationAckTimeoutMs: 500,
    maxConnectionAgeMs: 60_000,
    proactiveDrainMarginMs: 5_000,
    maxConnections: 20,
    maxUnauthenticatedConnections: 4,
    maxAuthenticatedConnections: 16,
    maxPendingAcceptanceCommits: 12,
    maxPendingAcceptanceCommitsPerWorker: 3,
    maxInboundMessages: 16,
    maxInboundBytes: 2 * 1_024 * 1_024,
    maxBufferedAmountBytes: 1_024 * 1_024,
    maxWorkerCapacity: 8,
    maxLifetimeStreams: 100,
    maxDataPayloadBytes: 64 * 1_024,
    maxReceiveCreditBytes: 1_024 * 1_024,
  });

  assert.deepStrictEqual(config.maxWorkerCapacity, 8);
  assert.deepStrictEqual(config.maxUnauthenticatedConnections, 4);
  assert.deepStrictEqual(config.maxPendingAcceptanceCommits, 12);
  assert.deepStrictEqual(config.maxPendingAcceptanceCommitsPerWorker, 3);
});

test("v0.21 hypervisor config rejects invalid timing", () => {
  assertThrows(
    () =>
      createHypervisorConfig({
        heartbeatIntervalMs: 10,
        leaseTimeoutMs: 10,
      }),
    TypeError,
    "greater than heartbeatIntervalMs",
  );
  assertThrows(
    () =>
      createHypervisorConfig({
        heartbeatIntervalMs: 10,
        leaseTimeoutMs: 100,
        leaseSweepIntervalMs: 100,
      }),
    TypeError,
    "less than leaseTimeoutMs",
  );
  assertThrows(
    () =>
      createHypervisorConfig({
        maxConnections: 2,
        maxUnauthenticatedConnections: 3,
      }),
    TypeError,
    "must not exceed maxConnections",
  );
  assertThrows(
    () =>
      createHypervisorConfig({
        maxConnectionAgeMs: 10,
        proactiveDrainMarginMs: 10,
      }),
    TypeError,
    "less than maxConnectionAgeMs",
  );
  assertThrows(
    () =>
      createHypervisorConfig({
        maxPendingAcceptanceCommits: 2,
        maxPendingAcceptanceCommitsPerWorker: 3,
      }),
    TypeError,
    "must not exceed maxPendingAcceptanceCommits",
  );
});

test("v0.21 hypervisor config cannot exceed wire hard limits", () => {
  assertThrows(
    () =>
      createHypervisorConfig({
        maxWorkerCapacity: WORKER_PROTOCOL_LIMITS.maxWorkerCapacity + 1,
      }),
    TypeError,
    "maxWorkerCapacity",
  );
  assertThrows(
    () =>
      createHypervisorConfig({
        maxLifetimeStreams: WORKER_PROTOCOL_LIMITS.maxLifetimeStreams + 1,
      }),
    TypeError,
    "maxLifetimeStreams",
  );
  assertThrows(
    () => createHypervisorConfig({ handshakeTimeoutMs: 0 }),
    TypeError,
    "handshakeTimeoutMs",
  );
  assertThrows(
    () => createHypervisorConfig({ maxPendingAcceptanceCommits: 0 }),
    TypeError,
    "maxPendingAcceptanceCommits",
  );
});

test("Hypervisor dispatch queue limits are opt-in and bounded", () => {
  assert.deepStrictEqual(createHypervisorConfig().maxQueuedDispatches, 0);
  assert.deepStrictEqual(
    createHypervisorConfig().dispatchQueueTimeoutMs,
    30_000,
  );
  assert.deepStrictEqual(
    createHypervisorConfig({ maxQueuedDispatches: 100 }).maxQueuedDispatches,
    100,
  );
  for (const maxQueuedDispatches of [-1, 0.5, NaN, Infinity, 1_000_001]) {
    assertThrows(
      () => createHypervisorConfig({ maxQueuedDispatches }),
      TypeError,
      "maxQueuedDispatches",
    );
  }
  for (const dispatchQueueTimeoutMs of [
    0,
    -1,
    0.5,
    NaN,
    Infinity,
    0x8000_0000,
  ]) {
    assertThrows(
      () => createHypervisorConfig({ dispatchQueueTimeoutMs }),
      TypeError,
      "dispatchQueueTimeoutMs",
    );
  }
});
