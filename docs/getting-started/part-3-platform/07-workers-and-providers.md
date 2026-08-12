# Chapter 7: Separate compute from Worker authority

## The pain

A process, container, or Cloud Run execution can exist without being an
authenticated, ready Worker. Treating provider compute as routing authority
creates stale assignment and cleanup races.

## The solution

Keep three records distinct:

1. a durable Worker definition and attempt identity;
2. a provider resource that represents compute existence; and
3. a live, fenced Hypervisor session that represents routability.

Provider APIs remain functional capabilities:

```ts
import {
  createCloudRunJobsProvider,
  type WorkerProvider,
} from "jsr:@oxian/oxian-js@0.21.0-rc.4/providers";

const provider = createCloudRunJobsProvider({
  project: "acme-workers",
  location: "us-central1",
  getAccessToken,
});

const attempt = await attempts.activate("logwash-worker");
const resource = await provider.provision({
  identity: attempt.identity,
  launch: { job: "logwash" },
});
```

Close Worker and Hypervisor lifecycle functions over your domain repositories:

```ts
const activate = ({ workerId }) => attempts.activate(workerId);
const register = ({ identity }) => credentials.issue(identity);

const admit = (context) =>
  database.transaction(async (tx) => {
    const attempt = await tx.attempts.assertCurrent(context.identity);
    const exchange = await tx.credentials.exchange(context);
    return {
      definition: attempt.definition,
      sessionGeneration: exchange.sessionGeneration,
      authenticatedWith: exchange.authenticatedWith,
      resume: exchange.resume,
      bootstrap: await tx.bootstrap.forWorker(context.identity),
    };
  });
```

Provider termination uses the exact attempt/resource identity. Hypervisor
`shutdownSession(fence)` uses the exact session fence. Neither stale cleanup
path can affect a replacement.

## Verify it

Provision a fake or local provider resource and delay Worker connection. Confirm
no dispatch succeeds before Ready. Then connect and dispatch successfully.

Create a replacement attempt/session and invoke cleanup for the old one. Confirm
the replacement remains routable. Finally, terminate provider compute and
observe that session disconnect is a separate event, not inferred state.

Use the CLI contracts as independent validation where appropriate:

```sh
deno run -A jsr:@oxian/oxian-js@0.21.0-rc.4/bin worker --manifest oxian.worker.ts
deno run -A jsr:@oxian/oxian-js@0.21.0-rc.4/bin check --config oxian.config.ts
deno run -A jsr:@oxian/oxian-js@0.21.0-rc.4/bin routes --config oxian.config.ts
```

## What happened

The provider reported compute state; the lifecycle functions established
identity and authority; the Hypervisor published only a Ready fenced session.
Each concept had one owner and one failure model.

Repositories still matter, but they are your domain contracts. Oxian receives
plain functions and immutable records instead of forcing manager construction
and method choreography.

## What this unlocks

You can use local processes, externally attached computers, Cloud Run Jobs, or a
custom provider without changing the Worker protocol. Durable applications can
implement activation, credentials, placement, and presence in one transaction
model suited to their infrastructure.

## What's next

[Chapter 8](08-failures-and-production.md) classifies crash boundaries and turns
the lifecycle callbacks into a production no-replay policy.
