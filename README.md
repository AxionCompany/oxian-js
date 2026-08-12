# Oxian 0.21

Oxian is a Fetch-native framework for file-routed HTTP applications and worker
workloads. Workers connect through an addressed in-process event fabric or an
authenticated outbound WebSocket over `oxian.worker.v1`; Workers never need to
expose an HTTP listener.

```bash
deno run -A jsr:@oxian/oxian-js@0.21.0-rc.5/bin init
deno run -A jsr:@oxian/oxian-js@0.21.0-rc.5/bin dev
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
- [Operations](docs/operations.md)
- [Architecture](docs/architecture.md)
- [Runtime boundaries and adapters](docs/runtime-adapters.md)
- [Worker transport performance](docs/performance.md)
- [API reference](docs/api-reference.md)
- [Migrating to 0.21](docs/migration-0.21.md)
- [0.20 migration facts](docs/migration-0.20.md)
- [Worker protocol v1](docs/worker-protocol-v1.md)

## Package surface

The package root is the runtime-neutral execution core. Filesystem discovery,
local processes, listeners, and executable lifecycle require explicit
runtime/capability subpaths:

```ts
import { createApplication } from "jsr:@oxian/oxian-js@0.21.0-rc.5/app";
import { defineConfig } from "jsr:@oxian/oxian-js@0.21.0-rc.5/config";
import { createHypervisor } from "jsr:@oxian/oxian-js@0.21.0-rc.5/hypervisor";
import { createWorker } from "jsr:@oxian/oxian-js@0.21.0-rc.5/worker";
import { serve } from "jsr:@oxian/oxian-js@0.21.0-rc.5/adapters/deno";
```

The executable is `jsr:@oxian/oxian-js@0.21.0-rc.5/bin`; the embeddable CLI API
is `jsr:@oxian/oxian-js@0.21.0-rc.5/cli`.

## Verification

```bash
deno task verify
npm run check:node
```

The release workflow runs this gate before publishing a tag or an explicitly
requested manual release.
