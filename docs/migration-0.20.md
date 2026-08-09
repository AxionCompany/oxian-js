# Migrating to 0.20

Oxian 0.20 is a new worker architecture. Apply these facts when moving an
application or operational integration.

- Route handlers are Fetch handlers: `(request, context) => Response`. Parse
  request bodies with native `Request` methods and create responses with native
  `Response` APIs.
- Route modules export uppercase HTTP methods. Middleware default-exports a
  `(request, context, next)` function.
- Configuration is one strict `oxian.config.ts` module. It exports only
  `default` or `config` and contains application and gateway settings.
- Local `dev` and `start` attach the HTTP workload in process by default. Set
  `gateway.workerTransport: "websocket"` when a local run must test the complete
  loopback wire protocol.
- Embedded applications create one Hypervisor and one Worker with
  `transport: { type: "in-process", hypervisor }`. The same declarations can
  move remote by changing the transport descriptor and adding remote admission.
- `createWorkerHost()` and `createWorkerClient()` are removed. Replace both with
  `createHypervisor()` plus `createWorker({ transport: ... })`; import the
  generic `WorkInput`, `WorkHandle`, and `Dispatcher` contracts from `/work`.
- `createDenoHypervisor()` is removed. Create the Hypervisor independently, then
  pass it to `handler(hypervisor)` or `serve({ hypervisor, ... })` from
  `/adapters/deno`. Listener and Hypervisor shutdown are separately owned.
- The local configuration value `gateway.workerTransport: "worker-websocket"` is
  now the transport primitive `"websocket"`.
- The package root now contains only the runtime-neutral execution core. Import
  filesystem, process, CLI, and server capabilities from explicit subpaths.
- `createHypervisor` is the portable host and exposes `prepare(request)` for
  server adapters. Deno gateways import `handler` or `serve` from
  `/adapters/deno`; adapters do not create or own the Hypervisor.
- A worker attaches outbound through `oxian.worker.v1`. Remove worker target
  URLs, worker HTTP listeners, and readiness polling from deployment wiring.
- HTTP is carried as the `oxian.http.v1` workload. Preserve repeated headers and
  stream bodies instead of serializing them as JSON or base64.
- `work.accepted` is not permission to execute workload code. Execute only after
  `work.start`, which follows the Hypervisor's durable acceptance commit.
- After that commit, a disconnect makes the operation indeterminate. Oxian does
  not rerun it; applications needing outcome recovery own durable IDs and
  resumption semantics.
- Replace implicit process termination in command integrations with `runCli`,
  which returns an exit code. Use `bin` when the executable should own signals.

Start the migration with a clean local project and move one route tree at a
time:

```bash
deno run -A jsr:@oxian/oxian-js@0.21.0-rc.2/bin init --root ./new-service
deno run -A jsr:@oxian/oxian-js@0.21.0-rc.2/bin check --config ./new-service/oxian.config.ts
```

Then choose an [embedded in-process worker](workers.md#in-process-worker), a
[worker manifest](workers.md#manifest-worker-runtime), or the direct remote
Worker WebSocket boundary. Review the [protocol](worker-protocol-v1.md) before
implementing a non-HTTP remote workload.
