# Changesets

Stable versions of `@oxian/oxian-js` are cut here. `npx changeset` records the bump. `npx changeset version` updates `package.json`, and `node scripts/sync_deno_version.mjs` copies that stable version into `deno.json`.

A merge to `main` does not consume these files. It publishes `x.y.z-next.<shortsha>` on the npm `next` tag from the committed version. The package name stays `@oxian/oxian-js`. Publishing waits until an npm account exists.
