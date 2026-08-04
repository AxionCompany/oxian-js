# Operations

## Startup checks

Run a route and configuration check before starting a worker or gateway:

```bash
deno run -A jsr:@oxian/oxian-js@0.20.0-rc.5/bin check --config oxian.config.ts
deno run -A jsr:@oxian/oxian-js@0.20.0-rc.5/bin routes --config oxian.config.ts
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
import { createHttpGateway } from "jsr:@oxian/oxian-js@0.20.0-rc.5/http";
import { createDenoHypervisor } from "jsr:@oxian/oxian-js@0.20.0-rc.5/adapters/deno";

const hypervisor = createDenoHypervisor({
  authority,
  repository,
  persistAcceptance: async (commit) => {
    await storeAcceptedOperation(commit);
  },
  fallback: createHttpGateway({
    dispatch: (input) => hypervisor.dispatch(input),
  }),
});

const listener = hypervisor.listen({ hostname: "0.0.0.0", port: 8000 });
await listener.finished;
```

`authority`, `repository`, and `storeAcceptedOperation` above are application
owned implementations. The repository must fence a worker by its complete
identity; the authority must atomically consume and rotate credentials.

## Observe and drain

Use `snapshot()` for process-local operational metrics. `drain()` gracefully
rotates one worker connection and lets its `WorkerClient` reconnect.
`shutdownWorker()` gracefully terminates the current client for one logical
worker. `shutdownSession()` does the same only when an exact session fence is
still current, so stale attempt cleanup cannot stop a replacement. `shutdown()`
terminates every connected worker and the Deno composition:

```ts
const snapshot = hypervisor.snapshot();
console.log(snapshot.sessions, snapshot.work);

await hypervisor.drain("orders-worker", "deployment");
await hypervisor.shutdownWorker("retired-worker", "worker_retired");
await hypervisor.shutdownSession(exactFence, "attempt_settled");
await hypervisor.shutdown("service_shutdown");
```

Both graceful worker operations stop new reservations and wait for active
streams. A maintenance drain closes the current connection without a Shutdown
frame; terminal worker shutdown sends one before closing and upgrades an
already-running maintenance drain. Core shutdown stops accepting connections;
`createDenoHypervisor` additionally closes the listeners owned by that adapter
after the configured drain timeout. Treat a lost operation after the acceptance
commit as indeterminate; record an application-level operation ID when a caller
needs durable outcome lookup.

## Limits and secure transport

Use `wss:` for deployed workers. The protocol caps control frames at 64 KiB,
data payloads at 1 MiB, stream-direction credit at 16 MiB, worker capacity at
1,024, and stream IDs at 65,536 per connection. Hypervisor settings may choose
smaller limits. Do not put credentials in a gateway URL; credentials are in the
WSS handshake.

See [workers](workers.md) for worker credential persistence and
[worker protocol v1](worker-protocol-v1.md) for all limits.
