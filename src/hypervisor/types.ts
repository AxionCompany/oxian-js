/**
 * @fileoverview Type definitions for Oxian hypervisor system.
 * 
 * @module hypervisor/types
 */

/**
 * Represents a selected project for routing in the hypervisor.
 * 
 * Contains project name and routing configuration for worker selection.
 */
export type SelectedProject = {
  project: string;
  source?: string;
  config?: string;
  githubToken?: string;
  stripPathPrefix?: string;
  isolated?: boolean;
  env?: Record<string, string>;
  materialize?: boolean | {
    mode?: "auto" | "always" | "never";
    dir?: string;
    refresh?: boolean;
  };
  invalidateCacheAt?: string | number | Date;
  idleTtlMs?: number;
  permissions?: {
    read?: boolean | string[];
    write?: boolean | string[];
    import?: boolean | string[];
    env?: boolean | string[];
    net?: boolean | string[];
    run?: boolean | string[];
    ffi?: boolean | string[];
    sys?: boolean | string[];
    all?: boolean;
  };
};

/**
 * Handle for managing a worker process.
 * 
 * Tracks the worker's port and process handle for lifecycle management.
 */
export type WorkerHandle = { 
  port: number; 
  proc: Deno.ChildProcess;
};

