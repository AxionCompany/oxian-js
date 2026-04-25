# CLI & Hypervisor Decomposition — Walkthrough

## Problem

The CLI (`src/cli/index.ts`, 669 lines) was the root coupling problem. It
handled 9 responsibilities in one function and created a recursive invocation
pattern:

```
cli.ts → hypervisor → spawns cli.ts --hypervisor=false
                     → spawns cli.ts materialize
                     → spawns cli.ts prepare
```

This caused config to load 3 times per worker start, resolver creation to
repeat 6 times across code paths, and made the hypervisor inseparable from
oxian-js. The `doSpawnWorker` function alone was ~565 lines of mixed concerns:
pure config transformations tangled with process spawning, readiness polling,
and materialize/prepare subprocess orchestration.

## What Changed

### Phase 0: CLI Decomposition

The monolithic CLI was split into focused modules. The `main()` function went
from 669 lines to ~160 lines — a thin dispatcher that parses args, discovers
config once, and delegates.

```
src/cli/
├── index.ts              # Thin dispatcher (~160 lines, was 669)
├── banner.ts             # (unchanged)
├── config_loader.ts      # NEW: makeEnvDefaults, discoverConfig, makeDefaultConfig
└── commands/
    ├── init.ts           # NEW: runInit + helpers (readLocalLLM, writeJsonWithPrompt, etc.)
    ├── materialize.ts    # NEW: runMaterialize
    ├── prepare.ts        # NEW: runPrepare
    └── routes.ts         # NEW: runRoutes
```

**Key improvement**: `makeEnvDefaults()` replaces the identical 8-line block
that was copy-pasted 6 times. `discoverConfig()` consolidates the config
discovery + overlay logic that was spread across the main function.

### Phase 1: Pure Function Extraction

Six pure functions were carved out of `doSpawnWorker` and placed in a new
module with 32 unit tests:

```
src/hypervisor_plugin/
└── spawn_args.ts         # NEW: pure, testable, side-effect free
```

| Function | What it does | Was (lifecycle.ts lines) |
|---|---|---|
| `buildImportMap` | Merge framework + host import maps, resolve relative specifiers | ~55 lines inline |
| `buildUnstableFlags` | `["kv","net"]` → `["--unstable-kv","--unstable-net"]` | 3 lines inline |
| `buildPermissionArgs` | Global + project permission maps → `--allow-`/`--deny-` flags | ~40 lines inline |
| `shouldReloadWorker` | Decide reload from `invalidateCacheAt` vs last-load timestamp | ~25 lines inline |
| `buildReloadArgs` | Build `--reload=<targets>` with resolved URLs | ~22 lines inline |
| `buildOtelEnv` | Build OTEL env vars for worker processes | ~60 lines inline |

Each function is deterministic and takes explicit inputs — no closure captures,
no `Deno.env` reads, no resolver calls (except `buildImportMap` and
`buildReloadArgs` which take a resolver as a parameter).

### Phase 2: Plugin Interface + Worker Entry

This is the architectural change. The hypervisor is now application-agnostic
through a plugin interface:

```
src/hypervisor/types.ts           # MODIFIED: added HypervisorPlugin, SpawnSpec, PluginContext
src/hypervisor/lifecycle.ts       # MODIFIED: doSpawnWorker delegates to plugin when available
src/hypervisor_plugin/
├── index.ts                      # NEW: OxianPlugin (default HypervisorPlugin implementation)
├── materialize.ts                # NEW: direct materialize/prepare (no subprocess)
└── spawn_args.ts                 # (from Phase 1)
src/worker_entry.ts               # NEW: lightweight worker (~35 lines)
```

#### The Plugin Interface

```typescript
interface HypervisorPlugin {
  init?(ctx: PluginContext): Promise<void>;
  buildSpawnSpec(project, ctx, opts): Promise<SpawnSpec>;
  checkReady(port, opts): Promise<boolean>;
  transformProxyHeaders?(headers, req, project): void;
}

interface SpawnSpec {
  execPath: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}
```

The hypervisor handles generic concerns (proxy, queue, process lifecycle,
readiness tracking, idle reaping). The plugin handles application-specific
concerns (how to build the spawn command, how to check readiness, what
pre-spawn steps to run).

#### Config Flow: 1 Load Instead of 3

Before:
```
CLI loads config → hypervisor → spawns CLI with --hypervisor=false → CLI loads config again
                              → spawns CLI with materialize → CLI loads config again
                              → spawns CLI with prepare → CLI loads config again
```

After:
```
CLI loads config → hypervisor → plugin.buildSpawnSpec():
    (once)                        1. materializeDirect() — no subprocess
                                  2. prepareDirect() — no subprocess
                                  3. Serialise config → OXIAN_CONFIG env var
                                  4. Return SpawnSpec targeting worker_entry.ts

                                worker_entry.ts:
                                  1. Read OXIAN_CONFIG (base64 JSON)
                                  2. JSON.parse → config
                                  3. startServer(config) directly
```

#### Backward Compatibility

- When no plugin is provided to `startHypervisor()`, the legacy inline code
  path runs unchanged (subprocess-based materialize/prepare, cli.ts entry point).
- `worker_entry.ts` falls back to `import("./cli/index.ts").main()` when
  `OXIAN_CONFIG` is not set.
- The CLI's `startHypervisor` call now passes an `OxianPlugin` instance, so
  the new path is the default.

## File-by-File Summary

| File | Change | Lines |
|---|---|---|
| `src/cli/index.ts` | Rewritten as thin dispatcher | 669 → ~160 |
| `src/cli/config_loader.ts` | New: centralised config discovery | ~170 |
| `src/cli/commands/init.ts` | New: init wizard extracted | ~175 |
| `src/cli/commands/materialize.ts` | New: materialize command | ~30 |
| `src/cli/commands/prepare.ts` | New: prepare command | ~65 |
| `src/cli/commands/routes.ts` | New: routes command | ~20 |
| `src/hypervisor_plugin/spawn_args.ts` | New: 6 pure functions | ~260 |
| `src/hypervisor_plugin/index.ts` | New: OxianPlugin class | ~310 |
| `src/hypervisor_plugin/materialize.ts` | New: direct mat/prep calls | ~40 |
| `src/worker_entry.ts` | New: lightweight worker entry | ~35 |
| `src/hypervisor/types.ts` | Added plugin interface types | 50 → ~140 |
| `src/hypervisor/lifecycle.ts` | Plugin delegation in doSpawnWorker | ~1676 (refactored) |
| `src/hypervisor/index.ts` | Re-exports new types | ~12 |
| `tests/spawn_args_test.ts` | New: 32 unit tests | ~340 |

## Verification

- `deno check cli.ts` — passes (transitively checks entire CLI + hypervisor chain)
- `deno check src/worker_entry.ts` — passes
- All 45 unit tests pass (11 pipeline + 32 spawn_args + 2 router)
