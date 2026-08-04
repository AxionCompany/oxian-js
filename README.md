# Oxian 0.20

Oxian is a Fetch-native framework for file-routed HTTP applications and worker
workloads. Work can run directly in the embedding JavaScript process or on
authenticated outbound WebSocket workers over `oxian.worker.v1`; workers never
need to expose an HTTP listener.

```bash
deno run -A jsr:@oxian/oxian-js@0.20.0-rc.6/bin init
deno run -A jsr:@oxian/oxian-js@0.20.0-rc.6/bin dev
```

`init` creates `oxian.config.ts` and `routes/index.ts`. `dev` starts a local
HTTP gateway and its HTTP workload in one process using the lightweight
in-process worker host by default. Visit `http://127.0.0.1:8000/`.

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

## Documentation

- [Progressive getting-started guide](docs/getting-started.md)
- [Application model](docs/application.md)
- [Workers, embedding, and the WSS boundary](docs/workers.md)
- [Operations](docs/operations.md)
- [Architecture](docs/architecture.md)
- [Runtime boundaries and adapters](docs/runtime-adapters.md)
- [API reference](docs/api-reference.md)
- [0.20 migration facts](docs/migration-0.20.md)
- [Worker protocol v1](docs/worker-protocol-v1.md)

## Package surface

The package root is the runtime-neutral execution core. Filesystem discovery,
local processes, listeners, and executable lifecycle require explicit
runtime/capability subpaths:

```ts
import { createApplication } from "jsr:@oxian/oxian-js@0.20.0-rc.6/app";
import { defineConfig } from "jsr:@oxian/oxian-js@0.20.0-rc.6/config";
import { createWorkerHost } from "jsr:@oxian/oxian-js@0.20.0-rc.6/host";
import { createWorkerClient } from "jsr:@oxian/oxian-js@0.20.0-rc.6/worker";
import { createDenoHypervisor } from "jsr:@oxian/oxian-js@0.20.0-rc.6/adapters/deno";
```

The executable is `jsr:@oxian/oxian-js@0.20.0-rc.6/bin`; the embeddable CLI API
is `jsr:@oxian/oxian-js@0.20.0-rc.6/cli`.

## Verification

```bash
deno task verify
npm run check:node
```

The release workflow runs this gate before publishing a tag or an explicitly
requested manual release.
