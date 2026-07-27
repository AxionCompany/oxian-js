const markerPath = Deno.env.get("OXIAN_PROVIDER_TEST_MARKER");
const expectedArgument = Deno.env.get("OXIAN_PROVIDER_TEST_ARGUMENT");
const ignoresSigterm =
  Deno.env.get("OXIAN_PROVIDER_TEST_IGNORE_SIGTERM") === "true";

if (!markerPath || !expectedArgument || Deno.args[0] !== expectedArgument) {
  Deno.exit(41);
}

if (ignoresSigterm) {
  Deno.addSignalListener("SIGTERM", () => {});
}

await Deno.writeTextFile(
  markerPath,
  JSON.stringify({
    argument: Deno.args[0],
    cwd: Deno.cwd(),
    env: expectedArgument,
    ignoresSigterm,
    inheritedPath: Deno.env.get("PATH") ?? null,
  }),
);

setInterval(() => {}, 60_000);
await new Promise<never>(() => {});
