/**
 * @fileoverview Oxian hypervisor for multi-worker request routing.
 *
 * This module provides hypervisor functionality for managing multiple worker
 * processes and routing requests based on a provider function.
 *
 * @module hypervisor
 */

export { startHypervisor } from "./lifecycle.ts";
export { MemoryStore } from "./store.ts";
export type {
  HypervisorPlugin,
  HypervisorStore,
  MaterializeOpts,
  PermissionSet,
  PluginContext,
  ServiceDefinition,
  SpawnResult,
  SpawnSpec,
  WorkerHandle,
} from "./types.ts";
