# Chapter 6: Run it on another machine

Chapter 5 proved that Logwash does not need to execute in the gateway process.
The two processes still shared a filesystem and trusted loopback networking.

## The pain

A worker on a laptop, VM, or another provider cannot use plain `ws:`, read the
gateway's local provisioning file, or lose its resume credential whenever the
process restarts. Production also needs a real answer for who may enroll a
worker and which worker attempt is current.

## The solution

Keep the same outbound-worker shape, but replace each localhost shortcut at its
owning boundary:

```text
Google-authenticated enrollment
             |
             v
product Control ---- durable worker authority/repository
             |
             v
HTTPS gateway + Hypervisor  <----- outbound WSS -----  Logwash worker
       public :443                                  no inbound listener
```

Oxian owns the WSS session, readiness, heartbeat, work streams, and reconnect
loop. Your product owns user authentication, enrollment, durable worker state,
provider policy, and the no-replay acceptance record.

The worker half below is runnable after that enrollment boundary returns its
provisioned values. There is intentionally no fake in-memory replacement for the
production Control boundary.

## 1. Publish the gateway over HTTPS and WSS

The Hypervisor is a Fetch handler. In production, normally place the Chapter 5
gateway behind an HTTPS reverse proxy that supports WebSocket upgrades. Keep the
internal listener on loopback, and publish both normal HTTPS requests and
`/_oxian/workers/connect` through the same TLS origin.

You can also terminate TLS directly in Deno. Replace `hypervisor.listen(...)` in
`gateway.ts` with:

```ts
const [cert, key] = await Promise.all([
  Deno.readTextFile(Deno.env.get("TLS_CERT_FILE")!),
  Deno.readTextFile(Deno.env.get("TLS_KEY_FILE")!),
]);

const server = Deno.serve({
  hostname: "0.0.0.0",
  port: 443,
  cert,
  key,
}, hypervisor.fetch);

console.log("Logwash gateway: https://logwash.example.com/");
console.log(
  "Worker socket: wss://logwash.example.com/_oxian/workers/connect",
);

await server.finished;
```

Use a certificate valid for the public hostname. Do not expose the Chapter 5
plain `ws:` endpoint beyond loopback; the worker client rejects it.

## 2. Put worker authority where it belongs

The in-memory repository, authority, generated JSON file, and no-op acceptance
commit from Chapter 5 are not production components. Replace them with durable,
application-owned functions:

```ts
const hypervisor = createHypervisor({
  authority: {
    exchange: (input) => control.exchangeWorkerCredential(input),
  },
  repository: {
    getDefinition: (workerId) => control.getWorkerDefinition(workerId),
    assertCurrent: (identity) => control.assertCurrentAttempt(identity),
  },
  persistAcceptance: (commit) => control.persistAcceptance(commit),
  fallback: httpGateway,
});
```

Here `control` is your application boundary, not an Oxian global. Its credential
exchange must atomically consume and rotate capabilities, replay only the exact
same lost handshake, and issue a monotonically newer session generation. Its
repository fences the complete `{ workerId, attemptId, epoch }`. Its acceptance
commit records the point after which an accepted operation must never be
automatically replayed.

Oxian deliberately does not supply a database schema or a Google login flow for
these policies.

## 3. Enroll the machine

Use a normal HTTPS endpoint in your product to enroll the machine:

1. Authenticate the user with Compass or your product's Google login.
2. Verify that the user may attach a worker.
3. Define or select the logical `workerId`.
4. Create one durable attempt with an `attemptId` and fencing `epoch`.
5. Generate one initial `handshakeId`.
6. Issue a short-lived, one-time registration capability for that exact
   identity.
7. Return those values with the credential-free WSS URL.

This endpoint is the right place for Google authentication. The subsequent Oxian
`hello` authenticates the provisioned worker identity with its registration or
resume capability. Do not put either capability in the WSS URL, a query string,
or logs.

The attempt ID, epoch, and initial handshake ID are provisioned values. They
must stay unchanged across process restarts for that attempt; do not generate
them while evaluating the worker manifest.

## 4. Copy Logwash to the worker machine

Copy the application files, including:

```text
oxian.config.ts
application.ts
logwash.ts
routes/
```

The worker executes these files locally. It does not need the gateway source,
and it does not open a port.

## 5. Add a durable worker manifest

Create `oxian.worker.ts` on the worker machine:

```ts
function required(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const epoch = Number(required("OXIAN_EPOCH"));
if (!Number.isSafeInteger(epoch) || epoch < 1) {
  throw new Error("OXIAN_EPOCH must be a positive integer");
}

const capacity = Number(required("OXIAN_CAPACITY"));
if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1_024) {
  throw new Error("OXIAN_CAPACITY must be an integer from 1 through 1024");
}

export default {
  gatewayUrl: required("OXIAN_GATEWAY_URL"),
  identity: {
    workerId: required("OXIAN_WORKER_ID"),
    attemptId: required("OXIAN_ATTEMPT_ID"),
    epoch,
  },
  credential: {
    kind: "registration",
    capability: required("OXIAN_REGISTRATION_CAPABILITY"),
  },
  handshakeId: required("OXIAN_INITIAL_HANDSHAKE_ID"),
  capacity,
  applicationConfig: "./oxian.config.ts",
  credentialStore: {
    mode: "durable",
    path: "./var/oxian-worker-resume.json",
  },
} as const;
```

The manifest is a strict TypeScript module with exactly one export. Supply the
enrollment result through your service manager or secret store:

```bash
export OXIAN_GATEWAY_URL='wss://logwash.example.com/_oxian/workers/connect'
export OXIAN_WORKER_ID='logwash-http'
export OXIAN_ATTEMPT_ID='value-returned-by-control'
export OXIAN_EPOCH='1'
export OXIAN_CAPACITY='2'
export OXIAN_REGISTRATION_CAPABILITY='secret-returned-by-control'
export OXIAN_INITIAL_HANDSHAKE_ID='value-returned-by-control'
```

For a real service, do not keep the registration capability in shell history or
a committed environment file.

## 6. Start the remote worker

Run:

```bash
deno run -A jsr:@oxian/oxian-js@0.20.0-rc.3/bin \
  worker --manifest ./oxian.worker.ts
```

The command prints that `logwash-http` is ready only after `ready_ack`. Leave it
running under the machine's service manager. Network policy needs outbound TCP
443 to the gateway; it needs no inbound rule and no HTTP worker port.

On the first successful handshake, the Hypervisor rotates the registration into
a resume capability. Before advertising readiness, the worker atomically writes
that capability, its replacement handshake ID, and its expiry to
`var/oxian-worker-resume.json`. The file is authoritative on later starts, even
though the unchanged manifest still contains the already-consumed initial
registration.

Do not run two worker daemons against the same credential path. The built-in
store holds an advisory lock and rejects a competing process.

## Verify it

Call the public HTTPS gateway from either machine:

```bash
curl --fail-with-body --silent --show-error \
  --request POST \
  --header 'content-type: application/json' \
  --data '{"message":"token=sk-demo"}' \
  https://logwash.example.com/redactions/strict
```

The response schema and output remain the same as Chapter 2.

Then verify durable restart:

1. Confirm that `var/oxian-worker-resume.json` exists and is readable only by
   the worker account.
2. Stop the worker cleanly.
3. Start the same command with the same attempt and initial-handshake
   environment.
4. Wait for the ready message and call Logwash again.

The restarted process loads the stored resume credential and stored replacement
handshake ID. It reconnects as the same attempt but receives a newer fenced
session generation.

To test the normal reconnect path, interrupt outbound connectivity without
stopping the process, then restore it. The default worker client retries with
bounded exponential backoff and keeps retrying unless it is stopped, shut down,
or told that re-enrollment is required. Accepted work is never replayed across
that reconnect.

## The socket-authentication seam

The protocol capability may be sufficient when WSS reaches the Hypervisor
directly. Some platforms additionally require a short-lived identity token in
the HTTP WebSocket upgrade. That policy remains outside Oxian's protocol.

The lower-level `createWorkerClient` accepts a public `createWebSocket` factory
for this case:

```ts
import type {
  WorkerWebSocketFactory,
} from "jsr:@oxian/oxian-js@0.20.0-rc.3/transport";

const createWebSocket: WorkerWebSocketFactory = async (
  { url, protocol, signal },
) => {
  signal.throwIfAborted();
  const token = await productIdentityToken({
    audience: url.origin,
    signal,
  });
  return await productWebSocketAdapter.connect({
    url,
    protocol,
    headers: {
      authorization: `Bearer ${token}`,
    },
    signal,
  });
};
```

`productIdentityToken` and `productWebSocketAdapter` are deliberately
application-owned. The adapter must return a WebSocket-compatible object. The
native Deno `WebSocket` constructor cannot attach arbitrary request headers.

The 0.20 manifest CLI does not expose this socket factory. If your edge requires
upgrade headers, compose `createWorkerClient` directly and pass
`createWebSocket`; keep the same manifest values and use
`createAtomicResumeCredentialStore` from the public `/local` export for durable
rotation. Do not smuggle a bearer token into the gateway URL.

## What happened

The worker still executes the same `oxian.http.v1` workload. Distance changed
the transport from explicitly allowed loopback `ws:` to authenticated `wss:`; it
did not change the route tree or add an HTTP server to the worker.

There are two authentication moments with different owners. Product enrollment
uses Google identity to authorize creation of an attempt and issue its first
registration. Each Oxian connection then exchanges that registration or a
persisted resume capability and is fenced to the current attempt.

Readiness and heartbeats are connection state, not durable worker identity. They
tell this Hypervisor process that the current socket can receive work. The
attempt and credential store are what let a restarted machine reconnect safely.

## What this unlocks

Logwash can now run on a user's computer, a VM, or another provider behind
outbound-only networking. Every provider can use the same worker client and wire
protocol while keeping enrollment, compute lifecycle, and secrets in the system
that owns them.

## What's next

In
[Chapter 7: Workers and providers](../part-3-platform/07-workers-and-providers.md),
we will add several kinds of compute without adding another worker transport.
Production work then becomes explicit provider lifecycle, durable acceptance,
revocation, and operational visibility.
