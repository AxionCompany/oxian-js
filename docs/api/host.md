# `jsr:@oxian/oxian-js@0.21.3/host`

One process runs the owners its shard map assigns. Another process with a
different shard cannot start those owners, so it cannot move their epochs.
`CONNECTION_BUDGET` is 1,000 open connections.

Exports: `createOwnerHost`, `createShardMap`, `CONNECTION_BUDGET`,
`HostOptions`, `HostSnapshot`, `OwnerConnection`, `OwnerHost`, and `ShardMap`.

## Assign owners

```ts
import { createOwnerHost, createShardMap } from "jsr:@oxian/oxian-js@0.21.3/host";
import { createMemoryOwnerStore, createOwner } from "jsr:@oxian/oxian-js@0.21.3/owner";

const host = createOwnerHost({
  map: createShardMap("shard-a", { "owner-1": "shard-a" }),
});

const owner = host.open("owner-1", () =>
  createOwner({
    store: createMemoryOwnerStore(),
    commands,
  }),
);
await owner.ready;
```

`createShardMap(shard, owners)` copies the assignment. `OwnerHost.owns` is
true only when `ShardMap.locate` returns this process's shard. `open` does not
call `start` for any other id, and a second `open` of the same id returns the
first instance.

`connect` takes one `OwnerConnection` and throws when `connections` in
`HostSnapshot` has reached the budget. `release` returns it. `close` rejects
later opens and connections.
