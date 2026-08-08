# Operations

## Startup checks

Run a route and configuration check before starting a worker or gateway:

```bash
deno run -A jsr:@oxian/oxian-js@0.20.0-rc.7/bin check --config oxian.config.ts
deno run -A jsr:@oxian/oxian-js@0.20.0-rc.7/bin routes --config oxian.config.ts
deno task verify
```

`check` compiles route modules and validates the optional application factory;
it does not invoke the factory. `verify` runs formatting, linting, type checks,
and the test suite.

## Gateway ownership

Build a deployed Hypervisor with an authority, repository, and an acceptance
commit that records the no-replay boundary. Compose `createHttpGateway` as its
HTTP fallback.

```ts
import { createHttpGateway } from "jsr:@oxian/oxian-js@0.20.0-rc.7/http";
import { createHypervisor } from "jsr:@oxian/oxian-js@0.20.0-rc.7/hypervisor";
import { serve } from "jsr:@oxian/oxian-js@0.20.0-rc.7/adapters/deno";

const hypervisor = createHypervisor({
  admission: {
    type: "registered",
    authority,
    repository,
  },
  persistAcceptance: async (commit) => {
    await storeAcceptedOperation(commit);
  },
  fallback: (request) => http(request),
});

const http = createHttpGateway({ dispatch: hypervisor.dispatch });
const listener = serve({
  hypervisor,
  hostname: "0.0.0.0",
  port: 8000,
});
await listener.finished;
```

`authority`, `repository`, and `storeAcceptedOperation` above are application
owned implementations. The repository must fence a worker by its complete
identity; the authority must atomically consume and rotate credentials.

## Observe and drain

Use `snapshot()` for process-local operational metrics. `drain()` gracefully
rotates one Worker connection or direct binding and lets that Worker rebind.
`shutdownWorker()` gracefully terminates one logical Worker. `shutdownSession()`
does the same only when an exact session fence is still current, so stale
attempt cleanup cannot stop a replacement. `shutdown()` terminates every bound
or connected Worker. The listener remains owned by its runtime adapter:

```ts
const snapshot = hypervisor.snapshot();
console.log(snapshot.sessions, snapshot.work);

await hypervisor.drain("orders-worker", "deployment");
await hypervisor.shutdownWorker("retired-worker", "worker_retired");
await hypervisor.shutdownSession(exactFence, "attempt_settled");
await hypervisor.shutdown("service_shutdown");
await listener.shutdown();
```

Both graceful worker operations stop new reservations and wait for active
streams. A maintenance drain replaces the current connection or binding;
terminal worker shutdown sends a remote Shutdown frame where applicable and
upgrades an already-running maintenance drain. Core shutdown stops accepting
Workers and settles its sessions after the configured drain timeout. Treat a
lost operation after the acceptance commit as indeterminate; record an
application-level operation ID when a caller needs durable outcome lookup.
`serve()` returns a separate listener capability; shutting down a Hypervisor
does not implicitly claim ownership of every adapter that may expose it.

## Limits and secure transport

Use `wss:` for deployed workers. The protocol caps control frames at 64 KiB,
data payloads at 1 MiB, stream-direction credit at 16 MiB, worker capacity at
1,024, and stream IDs at 65,536 per connection. Hypervisor settings may choose
smaller limits. Do not put credentials in a gateway URL; credentials are in the
WSS handshake.

See [workers](workers.md) for worker credential persistence and
[worker protocol v1](worker-protocol-v1.md) for all limits.
