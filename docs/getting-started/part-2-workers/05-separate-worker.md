# Chapter 5: Put work behind a Worker

## The pain

An HTTP or background handler that directly owns expensive execution cannot be
scheduled, capacity-limited, drained, or moved later without rewriting its
lifecycle.

## The solution

Keep the workload payload visible and put one declarative transport between a
Hypervisor and Worker. Start locally so there is no network setup:

```ts
import {
  createHypervisor,
  createWorker,
} from "jsr:@oxian/oxian-js@0.21.0-rc.4";

const transport = {
  type: "in-process",
  config: { topic: "tutorial.logwash" },
} as const;

const hypervisor = createHypervisor(
  { transports: [transport] },
  {
    onWorkAssigned({ operationId, assignment }) {
      console.log("assigned", operationId, assignment.fence.identity.workerId);
    },
    onWorkAccepted({ operationId }) {
      console.log("accepted", operationId);
    },
  },
);

const worker = createWorker({
  id: "logwash-worker",
  transport,
  workloads: {
    "logwash.clean": async ({ input, signal }) => {
      signal.throwIfAborted();
      const source = await new Response(input).text();
      return new TextEncoder().encode(
        source.replaceAll("secret", "[redacted]"),
      );
    },
  },
});

await worker.ready;

const work = await hypervisor.dispatch({
  workload: "logwash.clean",
  body: new TextEncoder().encode("token=secret"),
});

console.log(await new Response(work.output).text());
await work.done;

await worker.stop();
await hypervisor.shutdown();
```

The same `transport` record is deliberately visible on both sides. There is no
transport-construction helper and no hidden Hypervisor reference inside the
Worker declaration.

## Verify it

Run the module with Deno. Confirm the Worker reaches Ready, the result is
`token=[redacted]`, and shutdown settles without retained listeners.

Add an `onStart` Worker callback and assert it runs before the workload handler.
Then make Hypervisor `onWorkAssigned` throw: no handler invocation should occur.

## What happened

The topic registered a same-realm addressed event fabric. The Worker still sent
encoded Hello, Ready, heartbeat, work acceptance, Start, credit, body, and
terminal frames through the complete `oxian.worker.v1` state machine.

Construction started the Worker. `worker.ready` resolved only after the
Hypervisor acknowledged Ready. Work began only after the Worker ACK and
Hypervisor acceptance callback completed.

## What this unlocks

You now have one workload contract that can remain embedded, share an app-owned
Hypervisor, or move across WSS. Capacity, targeting, cancellation, streaming,
drain, and shutdown have the same semantics in every topology.

## What's next

[Chapter 6](06-another-machine.md) changes only the physical transport and adds
the durable activation/credential functions required across a trust boundary.
