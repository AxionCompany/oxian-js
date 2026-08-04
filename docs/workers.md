# Workers

Workers can attach directly to an embeddable `WorkerHost` or connect outbound to
a Hypervisor over `ws:` loopback or `wss:`. Both paths expose the same workload
handler, metadata, byte-stream, cancellation, capacity, targeting, acceptance,
and drain semantics.

## Embedded in-process worker

Use the in-process host when a library or application owns both dispatch and
execution. It avoids socket and wire-protocol overhead while preserving the
worker lifecycle boundary.

```ts
import { createWorkerHost } from "jsr:@oxian/oxian-js@0.20.0-rc.6/host";

const host = createWorkerHost({
  persistAcceptance: () => Promise.resolve(),
});

const engine = host.attachInProcessWorker({
  workerId: "copilotz-engine",
  capacity: 4,
  workloads: {
    "agent.turn.v1": async ({ input, signal, sendMetadata }) => {
      signal.throwIfAborted();
      await sendMetadata({ channel: "audio" });
      return { body: input };
    },
  },
});

const turn = await host.dispatch({
  workload: "agent.turn.v1",
  body: microphoneStream,
});
await turn.output.pipeTo(speakerStream);
await turn.completed;

await engine.drain();
await host.shutdown();
```

Direct attachment schedules handlers on the same JavaScript event loop. It is
lighter than loopback WSS but does not isolate CPU, memory, crashes, or security
boundaries. The handler must cooperate with `AbortSignal`; JavaScript events
cannot forcibly interrupt an arbitrary promise. Live Web Streams are used for
the operation data plane instead of `EventTarget` payload events, preserving
backpressure and stream cancellation across runtimes that implement standard Web
APIs.

## Remote worker client

A remote worker offers `oxian.worker.v1`. It receives work only after its
credential is exchanged, its resume credential is persisted, and it sends
`ready`.

### Direct worker client

`createWorkerClient` accepts workload functions keyed by workload name. A
workload receives immutable metadata, a `ReadableStream<Uint8Array>` input, an
`AbortSignal`, and `sendMetadata` for its one response metadata frame.

```ts
import { createWorkerClient } from "jsr:@oxian/oxian-js@0.20.0-rc.6/worker";

const worker = createWorkerClient({
  url: "ws://127.0.0.1:8000/_oxian/workers/connect",
  allowInsecureLoopback: true,
  identity: {
    workerId: "thumbnail-worker",
    attemptId: crypto.randomUUID(),
    epoch: 1,
  },
  credential: { kind: "registration", capability: "issued-by-your-authority" },
  credentialPersistence: "ephemeral",
  workloads: {
    "thumbnail.v1": async ({ input, sendMetadata }) => {
      await sendMetadata({ schema: "thumbnail.response.v1" });
      return { body: input };
    },
  },
  capacity: 2,
});

const running = worker.run();
await worker.whenReady();
// await worker.stop("service_shutdown");
await running;
```

An indefinitely running worker should use `credentialPersistence: "durable"`
with an atomic `persistResumeCredential` function. Persist the credential,
replacement handshake ID, and expiry together. `ephemeral` deliberately loses
resume state at process exit.

### Authenticated socket factory

`createWebSocket` lets a worker obtain provider authentication before Oxian owns
the connection. It receives the already validated gateway `url`, the exact
`oxian.worker.v1` `protocol`, and a `signal` that covers both caller
cancellation and the connection deadline.

```ts
import type { WorkerWebSocketFactory } from "jsr:@oxian/oxian-js@0.20.0-rc.6/transport";

const createWebSocket: WorkerWebSocketFactory = async (
  { url, protocol, signal },
) => {
  signal.throwIfAborted();
  // Obtain provider-owned authentication here when the socket implementation
  // supports it, then return the unaffiliated WebSocket instance.
  return new WebSocket(url, protocol);
};
```

Pass it to `createWorkerClient({ createWebSocket, ... })`. The factory owns only
authentication and socket construction. Oxian owns the deadline, waits for
`open`, verifies the negotiated subprotocol, and closes the socket after it is
returned; the factory must not retain lifecycle ownership of that socket.

### HTTP worker manifest

The CLI `worker` command runs an HTTP application as an outbound worker. Its
manifest is a strict module with one `default` or `manifest` export.

```ts
// oxian.worker.ts
const attemptId = Deno.env.get("OXIAN_ATTEMPT_ID");
const initialHandshakeId = Deno.env.get("OXIAN_INITIAL_HANDSHAKE_ID");
if (!attemptId || !initialHandshakeId) {
  throw new Error("Oxian worker identity must be provisioned before startup");
}

export default {
  gatewayUrl: "wss://gateway.example.com/_oxian/workers/connect",
  identity: {
    workerId: "orders-worker",
    attemptId,
    epoch: 1,
  },
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

`attemptId` is a provisioned, durable identity for one Control-plane worker
attempt: do not generate it on process startup. Keep it stable across process
restarts for the complete attempt and change it only when the control plane
starts a new attempt. Likewise, the initial handshake ID is provisioned once.
When `credentialStore.mode` is `"durable"`, the store is authoritative after the
first successful rotation: it retains the resume capability and its replacement
handshake ID together, so a restart reuses that stored handshake ID for a
lost-Welcome replay rather than generating a new one.

Start it with:

```bash
deno run -A jsr:@oxian/oxian-js@0.20.0-rc.6/bin worker --manifest oxian.worker.ts
```

The manifest uses the application's route and factory configuration. It does not
describe an HTTP target for the worker.

### Remote lifecycle

1. Worker sends `hello` with identity, workload names, capacity, and a
   registration or resume capability.
2. Hypervisor sends `welcome` with a rotated resume capability and opaque
   bootstrap data.
3. Worker persists the rotation, applies optional `beforeReady` work, and sends
   `ready`.
4. Hypervisor durably commits and publishes readiness, then sends `ready_ack`.
   Only after `ready_ack` does `worker.whenReady()` resolve and the worker send
   heartbeats or accept work.
5. During `drain`, it rejects new work, settles active streams, and sends
   `drained`. `shutdown` stops reconnecting.

Capacity is reserved by `work.accepted`; workload code runs only after
`work.start`. See the [normative protocol](worker-protocol-v1.md) for the exact
frame and settlement rules.
