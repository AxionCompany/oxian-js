# `jsr:@oxian/oxian-js@0.21.3/adapters/postgres`

Postgres store for one owner. The owner id is opaque. `owner_epochs` fences
it: a takeover increments the epoch and waits until any open transaction on
that row has ended. Receipts then decide what committed.

Exports: `createPostgresOwnerStore`, `PostgresOwnerStoreOptions`, and
`PostgresQuery`.

## Open a store

```ts
import { createPostgresOwnerStore } from "jsr:@oxian/oxian-js@0.21.3/adapters/postgres";
import { createOwner } from "jsr:@oxian/oxian-js@0.21.3/owner";

const store = await createPostgresOwnerStore({
  pool,
  ownerId: "owner-1",
  holder: "host-a",
  schema: "app",
});
const owner = createOwner({ store, commands });
await owner.ready;
```

`createPostgresOwnerStore(options: PostgresOwnerStoreOptions)` creates
`owner_epochs` and `receipts` in `schema`. `assigned` returns false when this
host must not take the owner; acquire then fails without changing the epoch.

Command handlers receive a `PostgresQuery` bound to the fenced transaction.
`query` runs SQL there. The owner commits the transaction.
