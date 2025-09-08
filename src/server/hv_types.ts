/**
 * @fileoverview Hypervisor type definitions for the Oxian framework.
 * 
 * This module contains type definitions for Oxian's hypervisor system,
 * which provides multi-project hosting, request routing, and worker
 * management capabilities. The hypervisor enables advanced deployment
 * scenarios with project isolation and dynamic routing.
 * 
 * @module server/hv_types
 */

/**
 * Interface for hypervisor providers that handle multi-project routing.
 * 
 * HvProvider implementations determine which project should handle a request
 * and can provide project-specific configurations. This enables complex
 * multi-tenant or multi-application deployments.
 * 
 * @example
 * ```typescript
 * const provider: HvProvider = {
 *   pickProject: async (req) => {
 *     const host = req.headers.get("host");
 *     if (host?.startsWith("api.")) return { project: "api" };
 *     if (host?.startsWith("admin.")) return { project: "admin" };
 *     return { project: "default" };
 *   },
 *   getProjectConfig: (name) => ({
 *     source: `./projects/${name}`,
 *     worker: { kind: "process", pool: { min: 1, max: 3 } }
 *   })
 * };
 * ```
 */
export type HvProvider = {
  pickProject: (req: Request) => Promise<{ project: string; stripPathPrefix?: string } | { project: string }> | { project: string; stripPathPrefix?: string } | { project: string };
  getProjectConfig?: (name: string) => Promise<Partial<ProjectRuntime>> | Partial<ProjectRuntime>;
  admission?: (req: Request, project: string) => Promise<void> | void; // throw to reject
};

/**
 * Configuration for individual projects in a hypervisor setup.
 * 
 * ProjectRuntime defines the runtime configuration for a single project
 * within a multi-project Oxian deployment. It includes project metadata,
 * source location, configuration overrides, and worker settings.
 * 
 * @example
 * ```typescript
 * const apiProject: ProjectRuntime = {
 *   name: "api",
 *   source: "./api-routes",
 *   config: { basePath: "/api" },
 *   worker: {
 *     kind: "process",
 *     pool: { min: 2, max: 10, idleTtlMs: 30000 }
 *   }
 * };
 * ```
 */
export type ProjectRuntime = {
  name: string;
  source?: string; // future: support per-project source
  // Optional path or URL to a project-specific config file (e.g., oxian.config.ts|js|json)
  // When provided, the worker will be spawned with `--config=` pointing to this path/URL.
  // If not provided and the source is remote, the hypervisor may attempt remote discovery.
  configPath?: string;
  config?: Record<string, unknown>; // shallow overrides merged with root config
  worker?: {
    kind?: "process" | "thread"; // future: "isolate"
    pool?: { min?: number; max?: number; idleTtlMs?: number };
  };
}; 