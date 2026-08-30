# Chapter 6: Move the Worker across WSS

## The pain

A remote Worker needs authentication, reconnect-safe identity, credential
rotation, and a native listener boundary. Those concerns should not create a
second execution architecture.

## The solution

Declare a host path and Worker URL, then implement lifecycle decisions as plain
functions over your own stores.

Hypervisor side:

```ts
import { createHypervisor } from "jsr:@oxian/oxian-js@0.21.1/hypervisor";
import { serve } from "jsr:@oxian/oxian-js@0.21.1/adapters/deno";

const hypervisor = createHypervisor(
  {
    transports: [{
      type: "websocket",
      config: { path: "/_oxian/workers/connect" },
    }],
    admit: (context) => control.admit(context),
  },
  {
    onReady: (context) => control.commitReady(context),
    onHeartbeat: (context) => control.commitHeartbeat(context),
    onWorkAccepted: (context) => control.commitAcceptance(context),
    onDisconnect: (context) => void control.enqueueDisconnect(context),
  },
);

const listener = serve({ hypervisor, port: 8080 });
```

Worker side:

```ts
import { createWorker } from "jsr:@oxian/oxian-js@0.21.1/worker";

const worker = createWorker({
  id: "logwash-worker",
  transport: {
    type: "websocket",
    config: { url: "wss://control.example.com/_oxian/workers/connect" },
  },
  workloads,
  activate: ({ workerId }) => attempts.activate(workerId),
  register: ({ identity }) => credentials.issue(identity),
  handshake: ({ rotation, bootstrap }) =>
    localState.persistRotationAndBootstrap(rotation, bootstrap),
}, {
  onReady: ({ snapshot }) => console.log("ready", snapshot.connectionId),
});

await worker.ready;
await worker.closed;
```

`control.admit` validates the full attempt identity, consumes the credential,
rotates it, asserts current declarations, increments the session generation, and
returns
`{ definition, sessionGeneration, authenticatedWith, resume, bootstrap }`.

## Verify it

Use WSS in production. For a local loopback exercise, use a `ws://127.0.0.1` URL
plus `config.allowInsecureLoopback: true`.

Start the Hypervisor, then the Worker. Stop the socket without stopping the
Worker and verify reconnect reuses the same attempt identity with the persisted
resume/handshake state. Revoke that credential and verify the Worker settles as
`reenrollment_required` instead of looping.

## What happened

Native WebSocket events became the same bounded `FrameConnection` used by the
local fabric. The same codec, ordering, credit, cancellation, acceptance, drain,
and shutdown code ran unchanged.

The application owned durable decisions through functions. Oxian never required
a prescribed repository or authority manager object.

## What this unlocks

You can run Workers in Deno, Node, Bun, browser-like runtimes, or
edge-compatible adapters while preserving one workload API. A provider-specific
socket factory can add transport authentication without exposing protocol frames
to the app.

## What's next

[Chapter 7](../part-3-platform/07-workers-and-providers.md) separates provider
compute from Worker session authority and shows where durable repositories fit.
