# `jsr:@oxian/oxian-js@0.21.3/owner`

One owner, addressed by the store the caller provides. Commands are serialized
and committed in groups, each with its own receipt. The core defines the store
port; Postgres is a separate adapter. `createMemoryOwnerStore` is the
in-process store.

Exports: `createOwner`, `createMemoryOwnerStore`, `createCommandSession`,
`createSnapshotSession`, `createOwnerError`, `isOwnerError`,
`CommandContext`, `CommandHandler`, `CommandIdentity`, `CommandOutcome`,
`CommandRequest`, `CommandSession`, `Heartbeat`, `IdentityDomain`,
`MemoryOwnerStore`, `MemoryTables`, `ObserverState`, `Owner`, `OwnerAlarm`,
`OwnerError`, `OwnerErrorCode`, `OwnerOptions`, `OwnerReadTransaction`,
`OwnerSnapshot`, `OwnerState`, `OwnerStore`, `OwnerStoreTransaction`,
`Receipt`, `RemoteSessionIdentity`, `SNAPSHOT_IDLE_MS`, `SNAPSHOT_LIFETIME_MS`,
and `SnapshotSession`.

## Run commands

```ts
import { createMemoryOwnerStore, createOwner } from "jsr:@oxian/oxian-js@0.21.3/owner";

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

## Changes, observers, and alarms

`context.append` adds one change and returns its sequence. A failed command,
a rolled-back group, and a compatible duplicate consume none. `owner.heartbeat`
returns the committed `Heartbeat` head, so a client whose applied sequence is
behind that head has missed an update even when nothing further is appended.

`owner.attach` captures that head for one observer. The cursor commits with
the group, so it cannot sit between two commits. `owner.acknowledge` records
what the observer has applied. `owner.resetObserver` drops that observer after
a failed or dropped push; it attaches again. `owner.observer` returns the
`ObserverState`.

`context.setAlarm` stores the owner's next wake-up, an `OwnerAlarm`. When it
is due, `onAlarm` runs. A takeover reads the same alarm and wakes too.

## Remote sessions

`createCommandSession` stamps a `RemoteSessionIdentity` with the owner's
current epoch. That epoch is not the worker attempt epoch. `submit` does
nothing once the owner has stopped or a successor holds a newer epoch.
`lookupReceipt` still reads the recorded result.

`createSnapshotSession` opens an `OwnerReadTransaction`: a read-only view that
later commits do not change. It closes when `close` is called, when a read
throws, when its signal aborts, when the owner epoch changes, or when it
expires. A read renews the idle time (`SNAPSHOT_IDLE_MS`, 30 seconds). The
session cannot outlive `SNAPSHOT_LIFETIME_MS` (5 minutes).
