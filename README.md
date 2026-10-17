# Oxian 0.22 (prerelease source)

Oxian is a Fetch-native framework for file-routed HTTP applications and worker
workloads. Workers connect through an addressed in-process event fabric or an
authenticated outbound WebSocket over `oxian.worker.v1`; Workers never need to
expose an HTTP listener.

The release channel for this revision is npm `next`: install with
`npm install oxianjs@next`. Successful main CI publishes
`0.22.0-next.<mergeSHA>` and mirrors that exact version to JSR. npm `latest`
remains on 0.21.3; no stable 0.22.0 release is implied. The versioned examples
below describe the 0.22.0 source API; when trying the prerelease through JSR,
substitute the exact published next version. See the
[0.22 migration notes](docs/migration-0.22.md) before upgrading.

```bash
deno run -A jsr:@oxian/oxian-js@0.22.0/bin init
deno run -A jsr:@oxian/oxian-js@0.22.0/bin dev
```

`init` creates `oxian.config.ts` and `routes/index.ts`. `dev` starts a local
HTTP gateway and its HTTP workload in one process using the lightweight
in-process transport by default. Visit `http://127.0.0.1:8000/`.

```ts
// routes/users/[id].ts
export function GET(_request: Request, context: {
  params: Readonly<Record<string, string | readonly string[]>>;
}): Response {
  return Response.json({ id: context.params.id });
}
```

Applications use native `Request`, `Response`, `ReadableStream`, and
`AbortSignal`. Route modules are compiled once during startup.

The local HTTP Worker admits 32 concurrent executions by default. Configure
`gateway.workerCapacity` to match a deployment's per-process HTTP concurrency;
temporary exhaustion returns retryable HTTP 503 rather than an opaque 500.

## Documentation

- [Progressive getting-started guide](docs/getting-started.md)
- [Application model](docs/application.md)
- [Workers, embedding, and the WSS boundary](docs/workers.md)
- [Optional worker-to-host calls](docs/worker-host-calls.md)
- [Operations](docs/operations.md)
- [Architecture](docs/architecture.md)
- [Runtime boundaries and adapters](docs/runtime-adapters.md)
- [Worker transport performance](docs/performance.md)
- [API reference](docs/api-reference.md)
- [Migrating to the 0.22 prerelease](docs/migration-0.22.md)
- [Migrating to 0.21](docs/migration-0.21.md)
- [0.20 migration facts](docs/migration-0.20.md)
- [Worker protocol v1](docs/worker-protocol-v1.md)

## Package surface

The package root is the runtime-neutral execution core. Filesystem discovery,
local processes, listeners, and executable lifecycle require explicit
runtime/capability subpaths:

```ts
import { createApplication } from "jsr:@oxian/oxian-js@0.22.0/app";
import { defineConfig } from "jsr:@oxian/oxian-js@0.22.0/config";
import { createHypervisor } from "jsr:@oxian/oxian-js@0.22.0/hypervisor";
import { createWorker } from "jsr:@oxian/oxian-js@0.22.0/worker";
import { serve } from "jsr:@oxian/oxian-js@0.22.0/adapters/deno";
```

The executable is `jsr:@oxian/oxian-js@0.22.0/bin`; the embeddable CLI API is
`jsr:@oxian/oxian-js@0.22.0/cli`.

### Node package (0.22 prerelease)

The npm build exposes the portable execution core as `oxianjs`, plus
`oxianjs/adapters/node`, `/http`, `/hypervisor`, `/protocol`, `/providers`,
`/router`, `/transport`, `/work`, and `/worker`. Node 24 or newer is required. The Node
listener uses the package's `ws` dependency; no database client is required. The
npm `/providers` export contains the portable providers only, without the Deno
local-process provider. The existing `createFileRouter` API is available from
`oxianjs/router`, with Node filesystem discovery and unchanged startup validation
and pathname matching. It also remains available in Deno/JSR. Filesystem app
factories, config loading, the local CLI and the other Deno-bound subpaths above
have not been ported into this npm build.

The unused generic `/owner`, `/host`, and `/adapters/postgres` APIs have been
removed from this source revision. Application-specific durable ownership
belongs in Copilotz; that replacement is not implemented by this removal.
Optional [worker-to-host calls](docs/worker-host-calls.md) now provide generic
reverse transport and admission; they do not implement durable owner semantics.
See [the retirement evidence](docs/owner-retirement.md) for retained guarantees
and immutable references to the former tests.

## Verification

```bash
deno task verify
npm run check:node
```

The release workflow runs this gate before publishing a tag or an explicitly
requested manual release.
