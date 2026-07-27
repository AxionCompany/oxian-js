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
deno run -A jsr:@oxian/oxian-js@0.20.0-rc.1/bin init --root ./new-service
deno run -A jsr:@oxian/oxian-js@0.20.0-rc.1/bin check --config ./new-service/oxian.config.ts
```

Then move the gateway and worker deployment to the
[worker manifest](workers.md#http-worker-manifest) or direct worker-client
boundary. Review the [protocol](worker-protocol-v1.md) before implementing a
non-HTTP workload.
