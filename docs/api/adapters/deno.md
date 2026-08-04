# `jsr:@oxian/oxian-js@0.20.0-rc.5/adapters/deno`

[Back to the API reference](../../api-reference.md)

The Deno adapter owns the native WebSocket upgrade and optional HTTP listener
around a runtime-neutral Hypervisor core.

```ts
import {
  createDenoHypervisor,
  createDenoHypervisorFetch,
  type DenoHypervisor,
  type DenoHypervisorOptions,
} from "jsr:@oxian/oxian-js@0.20.0-rc.5/adapters/deno";
```

## Export summary

| Export                      | Purpose                                                        |
| --------------------------- | -------------------------------------------------------------- |
| `createDenoHypervisor`      | Compose the portable core, Deno upgrade bridge, and listeners. |
| `createDenoHypervisorFetch` | Adapt an existing core to a Deno Fetch handler.                |
| `DenoHypervisor`            | Core API plus Deno `fetch` and `listen` methods.               |
| `DenoHypervisorOptions`     | Alias of the portable `HypervisorOptions` contract.            |

## Complete Deno composition

```ts
const hypervisor = createDenoHypervisor({
  authority,
  repository,
  persistAcceptance,
  fallback: gateway,
});

const listener = hypervisor.listen({
  hostname: "0.0.0.0",
  port: 8000,
});
await listener.finished;
```

`createDenoHypervisor` preserves the complete v0.20 Deno server behavior while
keeping `Deno.serve` and `Deno.upgradeWebSocket` outside `/hypervisor` and the
package root. Its `shutdown()` first drains and closes core worker sessions,
then closes every listener created by that composition.

## Existing Deno server

Use `createDenoHypervisorFetch` when another Deno server owns binding or TLS:

```ts
import { createHypervisor } from "jsr:@oxian/oxian-js@0.20.0-rc.5/hypervisor";
import { createDenoHypervisorFetch } from "jsr:@oxian/oxian-js@0.20.0-rc.5/adapters/deno";

const hypervisor = createHypervisor({
  authority,
  repository,
  persistAcceptance,
  fallback: gateway,
});
const fetch = createDenoHypervisorFetch(hypervisor);

Deno.serve({ port: 8443, cert, key }, fetch);
```

The bridge calls `hypervisor.prepare(request)`, performs the native upgrade only
after admission succeeds, and attaches the upgraded socket through
`WorkerWireConnection`. Failed upgrades release their reserved admission slot.
