/**
 * @fileoverview OxianPlugin — the default HypervisorPlugin for oxian-js.
 *
 * Builds SpawnSpecs that target `worker_entry.ts`, serialising config
 * via the OXIAN_CONFIG env var so the worker process does not need to
 * re-discover config. Also performs materialize and prepare steps
 * directly (no subprocess) when configured.
 *
 * @module hypervisor_plugin
 */

import denoJson from "../../deno.json" with { type: "json" };
import { createResolver } from "../resolvers/index.ts";
import type { Resolver } from "../resolvers/types.ts";
import type {
  HypervisorPlugin,
  PluginContext,
  ServiceDefinition,
  SpawnResult,
  SpawnSpec,
} from "../hypervisor/types.ts";
import type { EffectiveConfig } from "../config/index.ts";
import {
  buildImportMap,
  buildOtelEnv,
  buildPermissionArgs,
  buildReloadArgs,
  buildUnstableFlags,
  shouldReloadWorker,
} from "./spawn_args.ts";
import { materializeDirect, prepareDirect } from "./materialize.ts";
import { makeEnvDefaults } from "../cli/config_loader.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function detectHostDenoConfig(
  resolver: Resolver,
): Promise<string | undefined> {
  const candidates = ["deno.json", "deno.jsonc"];
  for (const name of candidates) {
    try {
      const resolved = await resolver.resolve(name);
      const { isFile } = await resolver.stat(resolved);
      if (isFile) return resolved.toString();
    } catch { /* no local deno config at this candidate */ }
  }
  return undefined;
}

async function hashString(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function ensureDir(path: string) {
  try {
    Deno.mkdirSync(path, { recursive: true });
  } catch { /* ignore */ }
}

/**
 * Serialise config for the worker process, stripping non-serialisable
 * values (functions) and the hv subtree (workers don't need it).
 */
function serialiseConfig(config: EffectiveConfig): string {
  const stripped = { ...config };
  // Workers don't need the hypervisor config subtree
  if (stripped.runtime) {
    stripped.runtime = { ...stripped.runtime };
    delete (stripped.runtime as Record<string, unknown>).hv;
  }
  const json = JSON.stringify(stripped, (_key, value) => {
    // Strip functions — they can't be serialised
    if (typeof value === "function") return undefined;
    return value;
  });
  return btoa(json);
}

// ---------------------------------------------------------------------------
// OxianPlugin
// ---------------------------------------------------------------------------

export class OxianPlugin implements HypervisorPlugin {
  /** Per-service last-load timestamps for reload decisions. */
  private serviceLastLoad = new Map<string, number>();

  async init(_ctx: PluginContext): Promise<void> {
    // Nothing to do yet — reserved for future pre-spawn setup
  }

  async spawn(
    svc: ServiceDefinition,
    ctx: PluginContext,
    opts: { port: number; idx: number },
  ): Promise<SpawnResult> {
    const spec = await this._buildSpawnSpec(svc, ctx, opts);
    const DEBUG = !!Deno.env.get("OXIAN_DEBUG");

    if (DEBUG) {
      console.log("[plugin] spawn spec", {
        args: spec.args,
        cwd: spec.cwd,
      });
    }

    const proc = new Deno.Command(spec.execPath, {
      args: spec.args,
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
      env: spec.env,
      cwd: spec.cwd,
    }).spawn();

    const target = `http://127.0.0.1:${opts.port}`;
    this.serviceLastLoad.set(svc.service, Date.now());
    return { target, handle: proc };
  }

  async stop(handle: unknown): Promise<void> {
    const proc = handle as Deno.ChildProcess;
    try {
      proc.kill();
    } catch { /* ignore */ }
  }

  async checkReady(
    target: string,
    opts: { timeoutMs: number },
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < opts.timeoutMs) {
      try {
        const r = await fetch(`${target}/_health`, {
          method: "HEAD",
          signal: AbortSignal.timeout(500),
        });
        if (r.ok || r.status >= 200) return true;
      } catch { /* ignore until ready */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  /** Internal: build the spawn spec for a local Deno subprocess. */
  private async _buildSpawnSpec(
    svc: ServiceDefinition,
    ctx: PluginContext,
    opts: { port: number; idx: number },
  ): Promise<SpawnSpec> {
    const { config, denoOptions, scriptArgs } = ctx;
    const hv = config.runtime?.hv ?? {};
    const DEBUG = !!Deno.env.get("OXIAN_DEBUG");

    const workerEntryPoint = import.meta.resolve("../worker_entry.ts")
      .toString();

    const forceReload = denoOptions.some((arg) =>
      arg === "--reload" || arg === "-r" || arg.startsWith("--reload=")
    );

    const resolver = createResolver(svc.source || config.root, {
      tokenEnv: "GITHUB_TOKEN",
      tokenValue: svc.auth?.github,
      forceReload,
    });

    // ── Deno args ──────────────────────────────────────────────────────

    const denoArgs: string[] = ["run", ...denoOptions];

    // Detect host deno config
    const hostDenoCfg =
      (denoOptions.find((a) => a.startsWith("--deno-config="))?.split(
        "=",
      )[1]) ||
      (hv as { denoConfig?: string }).denoConfig ||
      await detectHostDenoConfig(resolver);

    const effectiveDenoCfg = svc.denoConfig ?? hostDenoCfg;

    if (DEBUG) console.log("[plugin] effectiveDenoCfg", effectiveDenoCfg);

    if (!denoOptions.includes("--config") && effectiveDenoCfg) {
      // Load host deno config for import map merging
      let hostImports: Record<string, string> = {};
      let hostScopes: Record<string, Record<string, string>> | undefined;
      try {
        const resolved = await resolver.resolve(effectiveDenoCfg);
        const loaded = await resolver.load(resolved, { encoding: "utf-8" });
        const parsed = JSON.parse(loaded as string);
        if (parsed && typeof parsed === "object") {
          hostImports = parsed.imports ?? {};
          hostScopes = parsed.scopes;
          if (DEBUG) console.log("[plugin] hostDenoConfig", parsed);
        }
      } catch (e) {
        console.error("[plugin] error loading host deno config", {
          error: (e as Error)?.message,
        });
      }

      const libSrcBase = new URL("../", import.meta.url);
      const mergedImportMap = await buildImportMap({
        frameworkImports: denoJson?.imports || {},
        frameworkScopes: (denoJson as unknown as {
          scopes?: Record<string, Record<string, string>>;
        })?.scopes,
        hostImports,
        hostScopes,
        libSrcBaseHref: libSrcBase.href,
        resolver,
      });

      const jsonStr = JSON.stringify(mergedImportMap);
      const dataUrl = `data:application/json;base64,${btoa(jsonStr)}`;
      denoArgs.push(`--import-map=${dataUrl}`);

      // Unstable flags from framework's deno.json
      denoArgs.push(...buildUnstableFlags((denoJson as unknown as { unstable?: string[] })?.unstable));

      // Permissions
      denoArgs.push(
        ...buildPermissionArgs(
          config.permissions as
            | Record<string, boolean | string | string[]>
            | undefined,
          svc.permissions as
            | Record<string, boolean | string | string[]>
            | undefined,
        ),
      );
    } else {
      denoArgs.push("-A");
    }

    // ── Reload ─────────────────────────────────────────────────────────

    const doReload = shouldReloadWorker({
      invalidateCacheAt: svc.invalidateCacheAt,
      lastLoadMs: this.serviceLastLoad.get(svc.service) ?? 0,
      hotReload: config.runtime?.hotReload,
    });
    if (doReload) {
      denoArgs.push(
        ...await buildReloadArgs({
          resolver,
          serviceConfig: svc.config,
        }),
      );
    }

    // ── Effective source/config ────────────────────────────────────────

    const globalSource = Deno.args.find((a) => a.startsWith("--source="))
      ?.split("=")[1];
    const globalConfig = Deno.args.find((a) => a.startsWith("--config="))
      ?.split("=")[1];
    const effectiveSource = svc.source ?? globalSource;
    const effectiveConfig = svc.config ?? globalConfig;

    // ── Service directory ─────────────────────────────────────────────

    const svcHash = await hashString(svc.service);
    const svcDir = svc.isolated
      ? `./.services/${svcHash}`
      : Deno.cwd();
    if (svc.isolated) ensureDir(svcDir);

    // ── Materialize + Prepare (direct, no subprocess) ─────────────────

    const envDefaults = makeEnvDefaults({ reload: forceReload });
    if (svc.auth?.github) {
      envDefaults.tokenValue = svc.auth?.github;
    }

    await this.runMaterializeIfNeeded({
      config,
      service: svc,
      effectiveSource,
      doReload,
      envDefaults,
      svcDir,
    });

    // Always run prepare (it no-ops for remote sources)
    const prepareSource = effectiveSource || svcDir;
    const savedCwd = Deno.cwd();
    try {
      // prepareDirect reads config relative to cwd, so chdir to service dir
      if (svcDir !== savedCwd) Deno.chdir(svcDir);
      await prepareDirect({ source: prepareSource, envDefaults });
    } finally {
      if (svcDir !== savedCwd) Deno.chdir(savedCwd);
    }

    // ── Env ────────────────────────────────────────────────────────────

    const spawnEnv: Record<string, string> = {
      ...(svc.env || {}),
      ...(svc.auth?.github
        ? { GITHUB_TOKEN: svc.auth?.github }
        : {}),
    };

    // OTEL
    try {
      Object.assign(
        spawnEnv,
        buildOtelEnv({
          otelConfig: config.logging?.otel,
          otelProxy: config.runtime?.hv?.otelProxy,
          service: svc.service,
        }),
      );
    } catch { /* ignore otel env errors */ }

    // DENO_AUTH_TOKENS
    spawnEnv.DENO_AUTH_TOKENS = `${
      spawnEnv.DENO_AUTH_TOKENS ? spawnEnv.DENO_AUTH_TOKENS + ";" : ""
    }${
      svc.auth?.github
        ? `${svc.auth?.github}@raw.githubusercontent.com`
        : ""
    }`;

    // Serialise config for the worker
    const workerConfig = {
      ...config,
      server: { ...config.server, port: opts.port },
    } as EffectiveConfig;
    spawnEnv.OXIAN_CONFIG = serialiseConfig(workerConfig);

    // ── Isolated mode sandbox ──────────────────────────────────────────

    if (svc.isolated) {
      spawnEnv.DENO_DIR = `./.deno/DENO_DIR`;

      // Replace -A with sandboxed permissions
      const aIdx = denoArgs.indexOf("-A");
      if (aIdx !== -1) denoArgs.splice(aIdx, 1);

      const allowRead = denoArgs.find((a) =>
        a.startsWith("--allow-read=")
      )?.split("=")[1] ?? "";
      const allowWrite = denoArgs.find((a) =>
        a.startsWith("--allow-write=")
      )?.split("=")[1] ?? "";

      denoArgs.push(`--allow-read=${allowRead ? allowRead + `,./` : `./`}`);
      denoArgs.push(
        `--allow-write=${allowWrite ? allowWrite + "./" + `,./` : `./`}`,
      );
      denoArgs.push(`--allow-net`);
      denoArgs.push(`--allow-ffi`);
      denoArgs.push(`--allow-sys`);
      denoArgs.push(`--allow-import`);
      denoArgs.push(`--allow-env`);
      denoArgs.push(`--allow-run`);
      denoArgs.push(`--allow-hrtime`);
    }

    // ── Script args ────────────────────────────────────────────────────

    denoArgs.push(workerEntryPoint);

    const finalScriptArgs = [
      `--port=${opts.port}`,
      ...scriptArgs.filter((a) => !a.startsWith("--port=")),
      ...Deno.args.filter((a) =>
        !a.startsWith("--source=") && !a.startsWith("--config=") &&
        !a.startsWith("--hypervisor=")
      ),
      ...(effectiveSource && !svc.materialize
        ? [`--source=${effectiveSource}`]
        : []),
      ...(effectiveConfig ? [`--config=${effectiveConfig}`] : []),
    ];

    if (DEBUG) {
      console.log("[plugin] spawning worker", [
        ...denoArgs,
        ...finalScriptArgs,
      ]);
    }

    return {
      execPath: Deno.execPath(),
      args: [...denoArgs, ...finalScriptArgs],
      env: spawnEnv,
      cwd: svcDir,
    };
  }

  transformProxyHeaders(
    _headers: Headers,
    _req: Request,
    _service: string,
  ): void {
    // Default: no-op. The hypervisor already handles x-forwarded-* headers.
  }

  // ── Private ──────────────────────────────────────────────────────────

  private async runMaterializeIfNeeded(opts: {
    config: EffectiveConfig;
    service: ServiceDefinition;
    effectiveSource: string | undefined;
    doReload: boolean;
    envDefaults: { tokenEnv?: string; tokenValue?: string; forceReload?: boolean };
    svcDir: string;
  }): Promise<void> {
    const hv = opts.config.runtime?.hv ?? {};
    const hvMat = (hv as { materialize?: unknown })?.materialize as
      | boolean
      | { mode?: string; dir?: string; refresh?: boolean }
      | undefined;
    const mat = opts.service.materialize ?? hvMat;

    const shouldMat = !!(mat &&
      (typeof mat === "boolean"
        ? mat
        : (mat.mode === "always" || mat.mode === "auto")) &&
      opts.effectiveSource);

    if (!shouldMat || !opts.effectiveSource) return;

    const m = typeof mat === "boolean"
      ? { mode: "always" as const, refresh: false }
      : (mat as { mode?: string; dir?: string; refresh?: boolean });

    const savedCwd = Deno.cwd();
    try {
      if (opts.svcDir !== savedCwd) Deno.chdir(opts.svcDir);
      await materializeDirect({
        source: opts.effectiveSource,
        dir: ".",
        refresh: !!(m.refresh || opts.doReload),
        envDefaults: opts.envDefaults,
      });
    } finally {
      if (opts.svcDir !== savedCwd) Deno.chdir(savedCwd);
    }
  }
}
