# `jsr:@oxian/oxian-js@0.21.2/owner`

One owner, addressed by the store the caller provides. Commands are serialized
and committed in groups, each with its own receipt. The core defines the store
port; Postgres is a separate adapter. `createMemoryOwnerStore` is the
in-process store.

Exports: `createOwner`, `createMemoryOwnerStore`, `createOwnerError`,
`isOwnerError`, `CommandContext`, `CommandHandler`, `CommandIdentity`,
`CommandOutcome`, `CommandRequest`, `IdentityDomain`, `MemoryOwnerStore`,
`MemoryTables`, `Owner`, `OwnerError`, `OwnerErrorCode`, `OwnerOptions`,
`OwnerSnapshot`, `OwnerState`, `OwnerStore`, `OwnerStoreTransaction`, and
`Receipt`.

## Run commands

```ts
import { createMemoryOwnerStore, createOwner } from "jsr:@oxian/oxian-js@0.21.2/owner";

const store = createMemoryOwnerStore();
const owner = createOwner({
  store,
  commands: {
    put: (tx, input, context) => {
      tx.put("rows", context.identity.key, input);
      return input;
    },
  },
});
await owner.ready;

const outcome = await owner.submit({
  type: "put",
  identity: { domain: "logical", key: "step" },
  input: { n: 1 },
});
```

`owner.submit` resolves to a `CommandOutcome` after the group commit:
`committed`, `duplicate`, `conflict`, `refused`, `invalid`, or
`ownership_lost`. A `duplicate` returns the recorded `Receipt`. The same
identity in another `IdentityDomain` is a different command.

`context.afterCommit` runs only after that commit is durable.
`createOwnerError` reports `commit_unknown` or `ownership_lost`;
`isOwnerError` checks one.
