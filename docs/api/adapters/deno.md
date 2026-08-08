# `jsr:@oxian/oxian-js@0.20.0-rc.7/adapters/deno`

The Deno adapter performs native WebSocket upgrades and optional listener
binding for an application-owned Hypervisor. It does not create, configure, or
own the Hypervisor.

```ts
import {
  type DenoServeOptions,
  handler,
  serve,
} from "jsr:@oxian/oxian-js@0.20.0-rc.7/adapters/deno";
```

## Exports

| Export             | Purpose                                                   |
| ------------------ | --------------------------------------------------------- |
| `handler`          | Adapt `Hypervisor.prepare()` to Deno's Fetch API.         |
| `serve`            | Start one `Deno.serve` listener for a Hypervisor.         |
| `DenoServeOptions` | Hypervisor plus hostname, port, and cancellation options. |

## Start a listener

```ts
import { createHypervisor } from "jsr:@oxian/oxian-js@0.20.0-rc.7/hypervisor";
import { serve } from "jsr:@oxian/oxian-js@0.20.0-rc.7/adapters/deno";

const hypervisor = createHypervisor({
  persistAcceptance: (commit) => operations.accept(commit),
});

const listener = serve({
  hypervisor,
  hostname: "127.0.0.1",
  port: 8000,
});

await listener.finished;
```

`serve()` returns a separate `HypervisorListener`. The owner shuts down both
capabilities explicitly:

```ts
await hypervisor.shutdown("service_shutdown");
await listener.shutdown();
```

## Compose an existing server

```ts
import { handler } from "jsr:@oxian/oxian-js@0.20.0-rc.7/adapters/deno";

const fetch = handler(hypervisor);
const server = Deno.serve({
  hostname: "0.0.0.0",
  port: 8443,
  cert,
  key,
}, fetch);
```

The returned Fetch function upgrades only one-shot admissions produced by
`Hypervisor.prepare()`. If Deno rejects the native upgrade, the adapter cancels
the reserved admission slot.

```ts
type DenoServeOptions = Readonly<{
  hypervisor: Hypervisor;
  hostname?: string;
  port?: number;
  signal?: AbortSignal;
}>;
```
