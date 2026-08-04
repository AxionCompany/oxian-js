import { assertEquals, assertThrows } from "@std/assert";
import { WORKER_PROTOCOL_LIMITS } from "../../src/protocol/limits.ts";
import {
  createHypervisorConfig,
  DEFAULT_HYPERVISOR_CONFIG,
} from "../../src/hypervisor/config.ts";

Deno.test("v0.20 hypervisor config has bounded immutable defaults", () => {
  const config = createHypervisorConfig();

  assertEquals(config, DEFAULT_HYPERVISOR_CONFIG);
  assertEquals(config.workerPath, "/_oxian/workers/connect");
  assertEquals(
    config.maxDataPayloadBytes,
    WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes,
  );
  assertEquals(Object.isFrozen(config), true);
});

Deno.test("v0.20 hypervisor config accepts stricter protocol admission limits", () => {
  const config = createHypervisorConfig({
    workerPath: "/workers/connect",
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

  assertEquals(config.workerPath, "/workers/connect");
  assertEquals(config.maxWorkerCapacity, 8);
  assertEquals(config.maxUnauthenticatedConnections, 4);
  assertEquals(config.maxPendingAcceptanceCommits, 12);
  assertEquals(config.maxPendingAcceptanceCommitsPerWorker, 3);
});

Deno.test("v0.20 hypervisor config rejects ambiguous paths and invalid timing", () => {
  for (
    const workerPath of [
      "",
      "/",
      "workers",
      "/workers/",
      "/workers?token=x",
      "/workers#fragment",
      "/workers\\connect",
      "//example.com/workers",
      "///example.com/workers",
      "/workers/./connect",
      "/workers/admin/../connect",
      "/workers/%2e/connect",
      "/workers/%2e%2e/connect",
    ]
  ) {
    assertThrows(
      () => createHypervisorConfig({ workerPath }),
      TypeError,
      "workerPath",
    );
  }

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

Deno.test("v0.20 hypervisor config cannot exceed wire hard limits", () => {
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
