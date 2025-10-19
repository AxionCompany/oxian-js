/**
 * @fileoverview Oxian hypervisor for multi-worker request routing.
 * 
 * This module provides hypervisor functionality for managing multiple worker
 * processes and routing requests based on project configuration.
 * 
 * @module hypervisor
 */

export { startHypervisor } from "./lifecycle.ts";
export type { SelectedProject, WorkerHandle } from "./types.ts";
