# Chapter 8: Make failure boundaries explicit

## The pain

A network disconnect does not tell you whether a Worker merely saw an offer,
accepted it, started it, or completed an external side effect. Retrying every
unknown operation can duplicate irreversible work.

## The solution

Persist lifecycle boundaries by stable stage/operation IDs and classify failure
according to the last confirmed transition.

```ts
import { createHypervisor } from "jsr:@oxian/oxian-js@0.21.0-rc.4/hypervisor";

const hypervisor = createHypervisor(
  { transports, admit },
  {
    async onReady(context) {
      await presence.compareAndSetReady(context.fence, context.stageId);
    },
    async onHeartbeat(context) {
      await presence.compareAndSetHeartbeat(context.fence, context.sequence);
    },
    async onWorkAssigned(context) {
      await deliveries.recordAssignment(context.operationId, context);
    },
    async onWorkAccepted(context) {
      await deliveries.commitNoReplay(context.operationId, context.stageId);
    },
    async onComplete(context) {
      await deliveries.complete(context.operationId, context);
    },
    onDisconnect(context) {
      void presence.enqueueDisconnect(context);
    },
  },
);
```

Use this classification:

| Last confirmed boundary                 | Meaning                               | Default policy                  |
| --------------------------------------- | ------------------------------------- | ------------------------------- |
| Assignment callback failed              | No `work.open` was sent               | Retry safely                    |
| Open sent, no acceptance ACK            | Worker did not cross Start            | Reschedule                      |
| ACK received, acceptance commit unknown | Durable no-replay result is ambiguous | Mark indeterminate; reconcile   |
| Acceptance committed, Start sent        | Execution may have side effects       | Never blind replay              |
| Terminal frame received                 | Protocol result is authoritative      | Persist completion idempotently |

## Verify it

Inject failures at each boundary:

- throw in `onWorkAssigned` and assert no Worker offer;
- disconnect after Open but before `work.accepted` and assert reschedulable;
- hold `onWorkAccepted`, disconnect, then resolve/reject it and assert
  indeterminate classification;
- disconnect after Start and assert no automatic replay;
- cancel while acceptance is in flight and assert no handler starts before the
  durable callback confirms; and
- crash after an idempotent side effect but before completion persistence and
  reconcile by operation ID.

Run the same tests through an in-process topic and loopback WSS. The expected
lifecycle transcript must match except for physical connect/close details.

## What happened

The Worker's real `work.accepted` frame separated “offered” from “accepted.” The
Hypervisor acceptance callback sat inside the canonical commit before
`work.start`. Connection loss therefore had an explicit reschedulable or
indeterminate meaning instead of a guess.

Ready and heartbeat callbacks used complete fences. A monotonic disconnect
tombstone prevented a late callback from resurrecting a replaced session.

## What this unlocks

You can operate at-least-once delivery around an at-most-once Start boundary,
with application-specific reconciliation for external tools. The same model
supports embedded engines, shared Hypervisors, and remotely provisioned Workers.

## What's next

Use [operations](../../operations.md) as the production checklist, review the
[architecture](../../architecture.md), and keep the
[protocol](../../worker-protocol-v1.md) as the normative wire contract.
