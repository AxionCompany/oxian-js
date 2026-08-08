# Workers

A Worker declares workloads. A Hypervisor hosts and routes them. Placement is a
declarative field on the Worker:

```ts
transport: { type: "in-process", hypervisor }
// or
transport: { type: "websocket", url: "wss://gateway.example/workers" }
```

There is no separate Host, Client, or transport-instance lifecycle to learn.
Both placements use the same workload handler, streaming work handle, capacity,
targeting, cancellation, acceptance, and drain semantics.

## Embedded in-process worker

Use the in-process transport when a library or application owns both dispatch
and execution:

```ts
import {
  createHypervisor,
  createWorker,
} from "jsr:@oxian/oxian-js@0.20.0-rc.7";

const hypervisor = createHypervisor({
  persistAcceptance: () => Promise.resolve(),
});

const worker = createWorker({
  id: "copilotz-engine",
  capacity: 4,
  transport: { type: "in-process", hypervisor },
  workloads: {
    "agent.turn.v1": async ({ input, signal, sendMetadata }) => {
      signal.throwIfAborted();
      await sendMetadata({ channel: "audio" });
      return { body: input };
    },
  },
});

const running = worker.run();
await worker.whenReady();

const turn = await hypervisor.dispatch({
  workload: "agent.turn.v1",
  body: microphoneStream,
});
await turn.output.pipeTo(speakerStream);
await turn.completed;

await worker.stop("application_shutdown");
await running;
await hypervisor.shutdown();
```

This path schedules handlers on the same JavaScript event loop. It avoids
socket, wire encoding, authentication, and reconnect overhead, but it does not
isolate CPU, memory, crashes, or permissions. The handler must cooperate with
`AbortSignal`; JavaScript events cannot interrupt arbitrary synchronous code.

Live Web Streams are passed directly, preserving backpressure and cancellation
on Deno, Node, Bun, browser, and Worker-style runtimes that implement the
standard APIs. No raw stream chunks are converted into `EventTarget` events. A
Hypervisor maintenance drain replaces the direct binding and reruns
`beforeReady` with `reconnecting: true`; explicit shutdown remains terminal.

## WebSocket worker

Use the WebSocket descriptor when the Worker must cross an isolate, process,
machine, or trust boundary. The Worker API stays the same; only transport and
remote admission data are added.

```ts
import { createWorker } from "jsr:@oxian/oxian-js@0.20.0-rc.7/worker";

const worker = createWorker({
  identity: {
    workerId: "thumbnail-worker",
    attemptId: provisionedAttemptId,
    epoch: 1,
  },
  credential: {
    kind: "registration",
    capability: provisionedCapability,
  },
  credentialPersistence: "ephemeral",
  capacity: 2,
  transport: {
    type: "websocket",
    url: "wss://gateway.example/_oxian/workers/connect",
  },
  workloads: {
    "thumbnail.v1": async ({ input, sendMetadata }) => {
      await sendMetadata({ schema: "thumbnail.response.v1" });
      return { body: input };
    },
  },
});

const running = worker.run();
await worker.whenReady();
await running;
```

An indefinitely running Worker should use `credentialPersistence: "durable"`
with an atomic `persistResumeCredential` function. Persist the resume
credential, replacement handshake ID, and expiry together. `"ephemeral"`
deliberately loses resume state when the process exits.

### Custom socket construction

When a provider must attach transport-level authentication, put its socket
capability directly on the transport descriptor:

```ts
import type { WorkerWebSocketFactory } from "jsr:@oxian/oxian-js@0.20.0-rc.7/transport";

const socket: WorkerWebSocketFactory = async ({ url, protocol, signal }) => {
  signal.throwIfAborted();
  return new WebSocket(url, protocol);
};

const worker = createWorker({
  // identity, credential, workloads, persistence...
  transport: {
    type: "websocket",
    url: gatewayUrl,
    socket,
  },
});
```

Oxian owns connection deadlines, protocol verification, and socket closure. The
provided function owns only authenticated socket construction.

## HTTP Worker manifest

The CLI `worker` command runs an HTTP application as an outbound Worker. Its
manifest is a strict module with one `default` or `manifest` export.

```ts
// oxian.worker.ts
const attemptId = Deno.env.get("OXIAN_ATTEMPT_ID");
const initialHandshakeId = Deno.env.get("OXIAN_INITIAL_HANDSHAKE_ID");
if (!attemptId || !initialHandshakeId) {
  throw new Error("Oxian Worker identity must be provisioned before startup");
}

export default {
  gatewayUrl: "wss://gateway.example.com/_oxian/workers/connect",
  identity: { workerId: "orders-worker", attemptId, epoch: 1 },
  credential: {
    kind: "registration",
    capability: Deno.env.get("OXIAN_REGISTRATION_CAPABILITY")!,
  },
  handshakeId: initialHandshakeId,
  capacity: 4,
  applicationConfig: "./oxian.config.ts",
  credentialStore: {
    mode: "durable",
    path: "./var/oxian-worker-resume.json",
  },
} as const;
```

`attemptId` identifies one provisioned control-plane attempt and must remain
stable across process restarts. The initial handshake ID is also provisioned
once. After the first successful durable rotation, the credential store is
authoritative and preserves both resume capability and replacement handshake ID.
A restart reuses that stored handshake ID so an exact lost-Welcome exchange can
be replayed safely.

```bash
deno run -A jsr:@oxian/oxian-js@0.20.0-rc.7/bin worker --manifest oxian.worker.ts
```

## Remote lifecycle

1. Worker sends `hello` with identity, workloads, capacity, and a registration
   or resume capability.
2. Hypervisor sends `welcome` with a rotated resume capability and bootstrap
   data.
3. Worker persists the rotation, runs optional `beforeReady`, and sends `ready`.
4. Hypervisor commits readiness and sends `ready_ack`. Only after `ready_ack`
   does `worker.whenReady()` resolve and the Worker become routable.
5. During drain, new work is rejected while active streams settle. A protocol
   `shutdown` stops reconnecting.

Capacity is reserved by `work.accepted`; workload code runs only after
`work.start`. See [worker protocol v1](worker-protocol-v1.md) for normative
frame and settlement rules.
