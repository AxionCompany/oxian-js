/**
 * Tests for the lifecycle manager's integration with the pluggable
 * store and plugin interfaces.
 *
 * Uses a mock plugin (no real processes) to verify that the lifecycle
 * manager correctly delegates to plugin.spawn/stop and persists state
 * through the store.
 */

/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert@1";
import { createLifecycleManager } from "../src/hypervisor/lifecycle.ts";
import { MemoryStore } from "../src/hypervisor/store.ts";
import type {
  HypervisorPlugin,
  HypervisorStore,
  PluginContext,
  ServiceDefinition,
  SpawnResult,
} from "../src/hypervisor/types.ts";
import type { EffectiveConfig } from "../src/config/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal config stub. */
function stubConfig(overrides?: Partial<EffectiveConfig>): EffectiveConfig {
  return {
    root: "file:///project/",
    server: { port: 8080 },
    runtime: { hv: { workerBasePort: 19000 } },
    ...overrides,
  } as EffectiveConfig;
}

/** Tracks spawn/stop calls for assertions. */
interface MockPluginLog {
  spawns: Array<{ service: string; port: number }>;
  stops: Array<unknown>;
  readyChecks: Array<string>;
}

/** Creates a mock plugin that doesn't spawn real processes. */
function mockPlugin(
  opts?: {
    readyResult?: boolean;
    spawnTarget?: string;
  },
): { plugin: HypervisorPlugin; log: MockPluginLog } {
  const log: MockPluginLog = {
    spawns: [],
    stops: [],
    readyChecks: [],
  };
  const readyResult = opts?.readyResult ?? true;

  const plugin: HypervisorPlugin = {
    async spawn(
      service: ServiceDefinition,
      _ctx: PluginContext,
      pluginOpts: { port: number; idx: number },
    ): Promise<SpawnResult> {
      log.spawns.push({ service: service.service, port: pluginOpts.port });
      const target = opts?.spawnTarget ?? `http://127.0.0.1:${pluginOpts.port}`;
      return { target, handle: { mockPid: log.spawns.length } };
    },

    async stop(handle: unknown): Promise<void> {
      log.stops.push(handle);
    },

    async checkReady(
      target: string,
      _opts: { timeoutMs: number },
    ): Promise<boolean> {
      log.readyChecks.push(target);
      return readyResult;
    },
  };

  return { plugin, log };
}

// ---------------------------------------------------------------------------
// spawn → store integration
// ---------------------------------------------------------------------------

Deno.test({
  name: "lifecycle: spawnWorker stores target in store",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const store = new MemoryStore();
  const { plugin, log } = mockPlugin();
  const manager = createLifecycleManager({
    config: stubConfig(),
    plugin,
    store,
  });
  manager.setBaseArgs([], []);

  await manager.spawnWorker({ service: "api" }, 0);

  // Target should be in store
  const target = await store.get<string>("pool:api:target");
  assertEquals(typeof target, "string");
  assertEquals(target!.startsWith("http://"), true);

  // Ready flag should be set
  assertEquals(await store.get<boolean>("ready:api"), true);

  // Timestamps should be set
  const lastLoad = await store.get<number>("lastLoad:api");
  assertEquals(typeof lastLoad, "number");
  assertEquals(lastLoad! > 0, true);

  // Plugin was called
  assertEquals(log.spawns.length, 1);
  assertEquals(log.spawns[0].service, "api");
  assertEquals(log.readyChecks.length, 1);

  manager.shutdown();
});

Deno.test({
  name: "lifecycle: spawnWorker stores ServiceDefinition in config",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const store = new MemoryStore();
  const { plugin } = mockPlugin();
  const manager = createLifecycleManager({
    config: stubConfig(),
    plugin,
    store,
  });
  manager.setBaseArgs([], []);

  const def: ServiceDefinition = {
    service: "web",
    source: "github:user/repo",
    idleTtlMs: 30000,
  };
  await manager.spawnWorker(def, 0);

  const stored = await store.get<ServiceDefinition>("config:web");
  assertEquals(stored?.service, "web");
  assertEquals(stored?.source, "github:user/repo");
  assertEquals(stored?.idleTtlMs, 30000);

  manager.shutdown();
});

// ---------------------------------------------------------------------------
// spawn failure
// ---------------------------------------------------------------------------

Deno.test({
  name: "lifecycle: spawnWorker marks not ready when checkReady fails",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const store = new MemoryStore();
  const { plugin } = mockPlugin({ readyResult: false });
  const manager = createLifecycleManager({
    config: stubConfig(),
    plugin,
    store,
  });
  manager.setBaseArgs([], []);

  await manager.spawnWorker({ service: "broken" }, 0);

  // Target should NOT be in store (not ready)
  assertEquals(await store.get<string>("pool:broken:target"), undefined);
  assertEquals(await store.get<boolean>("ready:broken"), false);

  manager.shutdown();
});

// ---------------------------------------------------------------------------
// spawn lock (concurrent guard)
// ---------------------------------------------------------------------------

Deno.test({
  name: "lifecycle: concurrent spawnWorker acquires lock",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const store = new MemoryStore();
  const { plugin, log } = mockPlugin();
  const manager = createLifecycleManager({
    config: stubConfig(),
    plugin,
    store,
  });
  manager.setBaseArgs([], []);

  // First spawn should succeed
  await manager.spawnWorker({ service: "api" }, 0);
  assertEquals(log.spawns.length, 1);

  // Lock should be released after spawn
  // Second spawn should also succeed (no deadlock)
  await manager.spawnWorker({ service: "api2" }, 1);
  assertEquals(log.spawns.length, 2);

  manager.shutdown();
});

// ---------------------------------------------------------------------------
// getTarget
// ---------------------------------------------------------------------------

Deno.test({
  name: "lifecycle: getTarget returns stored target after spawn",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const store = new MemoryStore();
  const { plugin } = mockPlugin();
  const manager = createLifecycleManager({
    config: stubConfig(),
    plugin,
    store,
  });
  manager.setBaseArgs([], []);

  assertEquals(await manager.getTarget("api"), undefined);
  await manager.spawnWorker({ service: "api" }, 0);
  const target = await manager.getTarget("api");
  assertEquals(typeof target, "string");

  manager.shutdown();
});

// ---------------------------------------------------------------------------
// restartService uses plugin.stop for old handle
// ---------------------------------------------------------------------------

Deno.test({
  name: "lifecycle: restartService calls plugin.stop on old handle",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const store = new MemoryStore();
  const { plugin, log } = mockPlugin();
  const manager = createLifecycleManager({
    config: stubConfig(),
    plugin,
    store,
  });
  manager.setBaseArgs([], []);

  // Initial spawn
  await manager.spawnWorker({ service: "api" }, 0);
  assertEquals(log.spawns.length, 1);

  // Restart should spawn new and stop old
  await manager.restartService("api");
  assertEquals(log.spawns.length, 2);
  assertEquals(log.stops.length, 1);
  // The stopped handle should be the first spawn's handle
  assertEquals((log.stops[0] as { mockPid: number }).mockPid, 1);

  manager.shutdown();
});

// ---------------------------------------------------------------------------
// inflight counter via store
// ---------------------------------------------------------------------------

Deno.test({
  name: "lifecycle: inflight counters go through store",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const store = new MemoryStore();
  const { plugin } = mockPlugin();
  const manager = createLifecycleManager({
    config: stubConfig(),
    plugin,
    store,
  });

  await manager.incrementServiceInflight("api");
  await manager.incrementServiceInflight("api");
  assertEquals(await store.get<number>("inflight:api"), 2);

  await manager.decrementServiceInflight("api");
  assertEquals(await store.get<number>("inflight:api"), 1);

  await manager.decrementServiceInflight("api");
  assertEquals(await store.get<number>("inflight:api"), 0);

  // Decrement below 0 clamps
  await manager.decrementServiceInflight("api");
  assertEquals(await store.get<number>("inflight:api"), 0);

  manager.shutdown();
});

// ---------------------------------------------------------------------------
// activity tracking via store
// ---------------------------------------------------------------------------

Deno.test({
  name: "lifecycle: markServiceActivity writes to store",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const store = new MemoryStore();
  const { plugin } = mockPlugin();
  const manager = createLifecycleManager({
    config: stubConfig(),
    plugin,
    store,
  });

  const before = Date.now();
  await manager.markServiceActivity("api");
  const ts = await store.get<number>("activity:api");
  assertEquals(typeof ts, "number");
  assertEquals(ts! >= before, true);

  manager.shutdown();
});

// ---------------------------------------------------------------------------
// shouldRestartForCacheInvalidation via store
// ---------------------------------------------------------------------------

Deno.test({
  name: "lifecycle: cache invalidation checks store for last config",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const store = new MemoryStore();
  const { plugin } = mockPlugin();
  const manager = createLifecycleManager({
    config: stubConfig(),
    plugin,
    store,
  });
  manager.setBaseArgs([], []);

  // Spawn with initial invalidation timestamp
  await manager.spawnWorker({
    service: "api",
    invalidateCacheAt: 1000,
  }, 0);

  // Same timestamp — no restart needed
  assertEquals(
    await manager.shouldRestartForCacheInvalidation("api", {
      service: "api",
      invalidateCacheAt: 1000,
    }),
    false,
  );

  // Newer timestamp — restart needed
  assertEquals(
    await manager.shouldRestartForCacheInvalidation("api", {
      service: "api",
      invalidateCacheAt: Date.now() + 10000,
    }),
    true,
  );

  manager.shutdown();
});

// ---------------------------------------------------------------------------
// onServiceReady callback
// ---------------------------------------------------------------------------

Deno.test({
  name: "lifecycle: onServiceReady fires after successful spawn",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const store = new MemoryStore();
  const { plugin } = mockPlugin();
  const readyServices: string[] = [];
  const manager = createLifecycleManager({
    config: stubConfig(),
    plugin,
    store,
    onServiceReady: async (service) => {
      readyServices.push(service);
    },
  });
  manager.setBaseArgs([], []);

  await manager.spawnWorker({ service: "web" }, 0);
  assertEquals(readyServices, ["web"]);

  manager.shutdown();
});

Deno.test({
  name: "lifecycle: onServiceReady does NOT fire when not ready",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const store = new MemoryStore();
  const { plugin } = mockPlugin({ readyResult: false });
  const readyServices: string[] = [];
  const manager = createLifecycleManager({
    config: stubConfig(),
    plugin,
    store,
    onServiceReady: async (service) => {
      readyServices.push(service);
    },
  });
  manager.setBaseArgs([], []);

  await manager.spawnWorker({ service: "broken" }, 0);
  assertEquals(readyServices, []);

  manager.shutdown();
});

// ---------------------------------------------------------------------------
// custom store implementation
// ---------------------------------------------------------------------------

Deno.test({
  name: "lifecycle: works with any HypervisorStore implementation",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  // Minimal custom store that wraps MemoryStore and tracks calls
  const inner = new MemoryStore();
  const calls: string[] = [];
  const customStore: HypervisorStore = {
    get: async <T>(key: string) => { calls.push(`get:${key}`); return inner.get<T>(key); },
    set: async <T>(key: string, value: T, ttl?: number) => { calls.push(`set:${key}`); return inner.set(key, value, ttl); },
    delete: async (key: string) => { calls.push(`del:${key}`); return inner.delete(key); },
    increment: async (key: string) => { calls.push(`inc:${key}`); return inner.increment(key); },
    decrement: async (key: string) => { calls.push(`dec:${key}`); return inner.decrement(key); },
    acquire: async (key: string, ttl: number) => { calls.push(`acq:${key}`); return inner.acquire(key, ttl); },
    release: async (key: string) => { calls.push(`rel:${key}`); return inner.release(key); },
    enqueue: async <T>(queue: string, item: T) => { calls.push(`enq:${queue}`); return inner.enqueue(queue, item); },
    drain: async <T>(queue: string) => { calls.push(`drn:${queue}`); return inner.drain<T>(queue); },
    waitFor: async <T>(id: string, timeout?: number) => { calls.push(`wf:${id}`); return inner.waitFor<T>(id, timeout); },
    resolve: async <T>(id: string, value: T) => { calls.push(`res:${id}`); return inner.resolve(id, value); },
  };

  const { plugin } = mockPlugin();
  const manager = createLifecycleManager({
    config: stubConfig(),
    plugin,
    store: customStore,
  });
  manager.setBaseArgs([], []);

  await manager.spawnWorker({ service: "api" }, 0);

  // Verify store was actually called
  assertEquals(calls.some((c) => c.startsWith("acq:spawn:api")), true);
  assertEquals(calls.some((c) => c === "set:pool:api:target"), true);
  assertEquals(calls.some((c) => c === "set:ready:api"), true);
  assertEquals(calls.some((c) => c === "set:lastLoad:api"), true);
  assertEquals(calls.some((c) => c === "set:config:api"), true);
  assertEquals(calls.some((c) => c.startsWith("rel:spawn:api")), true);

  manager.shutdown();
});

// ---------------------------------------------------------------------------
// listServices reflects local handles
// ---------------------------------------------------------------------------

Deno.test({
  name: "lifecycle: listServices returns spawned services",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const store = new MemoryStore();
  const { plugin } = mockPlugin();
  const manager = createLifecycleManager({
    config: stubConfig(),
    plugin,
    store,
  });
  manager.setBaseArgs([], []);

  assertEquals(manager.listServices(), []);

  await manager.spawnWorker({ service: "api" }, 0);
  await manager.spawnWorker({ service: "web" }, 1);

  const services = manager.listServices();
  assertEquals(services.includes("api"), true);
  assertEquals(services.includes("web"), true);

  manager.shutdown();
});

// ---------------------------------------------------------------------------
// custom target from plugin
// ---------------------------------------------------------------------------

Deno.test({
  name: "lifecycle: stores custom target from plugin spawn result",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const store = new MemoryStore();
  const { plugin } = mockPlugin({
    spawnTarget: "https://worker-api.run.app",
  });
  const manager = createLifecycleManager({
    config: stubConfig(),
    plugin,
    store,
  });
  manager.setBaseArgs([], []);

  await manager.spawnWorker({ service: "cloud-svc" }, 0);

  const target = await manager.getTarget("cloud-svc");
  assertEquals(target, "https://worker-api.run.app");

  manager.shutdown();
});
