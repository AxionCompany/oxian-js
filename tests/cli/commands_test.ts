import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { runCli } from "../../src/cli/index.ts";

const APP_MODULE_URL = new URL(
  "../../src/app/index.ts",
  import.meta.url,
).href;

function captureIo(): Readonly<{
  stdout: string[];
  stderr: string[];
  io: Readonly<{
    stdout(message: string): void;
    stderr(message: string): void;
  }>;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return Object.freeze({
    stdout,
    stderr,
    io: Object.freeze({
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
    }),
  });
}

Deno.test("init writes the minimal v0.20 project and never overwrites implicitly", async () => {
  const root = await Deno.makeTempDir();
  try {
    const capture = captureIo();
    assertEquals(
      await runCli(["init", "--root", root], { io: capture.io }),
      0,
    );
    const configPath = join(root, "oxian.config.ts");
    const routePath = join(root, "routes", "index.ts");
    const config = await Deno.readTextFile(configPath);
    const route = await Deno.readTextFile(routePath);
    assert(config.includes('routesRoot: "./routes"'));
    assert(config.includes('workerTransport: "in-process"'));
    assert(config.includes("workerCapacity: 32"));
    assert(config.includes('basePath: "/"'));
    assert(config.includes("port: 8000"));
    assert(route.includes("export function GET"));

    await Deno.writeTextFile(routePath, "// user-owned route\n");
    capture.stderr.length = 0;
    assertEquals(
      await runCli(["init", "--root", root], { io: capture.io }),
      1,
    );
    assert(capture.stderr[0].includes("refusing to overwrite"));
    assertEquals(
      await Deno.readTextFile(routePath),
      "// user-owned route\n",
    );

    assertEquals(
      await runCli(["init", "--root", root, "--force"], {
        io: capture.io,
      }),
      0,
    );
    assert((await Deno.readTextFile(routePath)).includes("Hello from Oxian"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("check validates the factory module without invoking it", async () => {
  const root = await Deno.makeTempDir();
  const routesRoot = join(root, "routes");
  const setupMarker = join(root, "setup.txt");
  try {
    await Deno.mkdir(routesRoot);
    await Deno.writeTextFile(
      join(routesRoot, "index.ts"),
      `export function GET(): Response { return new Response("ok"); }\n`,
    );
    await Deno.writeTextFile(
      join(root, "application.ts"),
      `import {
  createApplication,
  defineApplicationFactory,
} from ${JSON.stringify(APP_MODULE_URL)};

export default defineApplicationFactory(({ router, basePath, signal }) =>
  {
    void router;
    void basePath;
    void signal;
    Deno.writeTextFileSync(${JSON.stringify(setupMarker)}, "invoked");
    throw new Error("factory_must_not_run_during_check");
  }
);
`,
    );
    const configPath = join(root, "oxian.config.ts");
    await Deno.writeTextFile(
      configPath,
      `export default {
  application: {
    routesRoot: "./routes",
    basePath: "/api",
    factory: "./application.ts",
  },
};\n`,
    );

    const capture = captureIo();
    assertEquals(
      await runCli(["check", "--config", configPath], {
        io: capture.io,
      }),
      0,
    );
    assertEquals(capture.stdout, [
      "configuration, application entry, and 1 route are valid",
    ]);
    await assertRejects(
      () => Deno.readTextFile(setupMarker),
      Deno.errors.NotFound,
    );

    await Deno.writeTextFile(
      join(root, "invalid-application.ts"),
      `export const extra = true; export default () => ({});\n`,
    );
    await Deno.writeTextFile(
      join(root, "invalid.config.ts"),
      `export default {
  application: {
    routesRoot: "./routes",
    factory: "./invalid-application.ts",
  },
};\n`,
    );
    const invalidCapture = captureIo();
    assertEquals(
      await runCli(["check", "--config", join(root, "invalid.config.ts")], {
        io: invalidCapture.io,
      }),
      1,
    );
    assert(
      invalidCapture.stderr[0].includes(
        'found extra export "extra"',
      ),
    );

    await Deno.writeTextFile(
      join(root, "non-function-application.ts"),
      `export default Object.freeze({});\n`,
    );
    await Deno.writeTextFile(
      join(root, "non-function.config.ts"),
      `export default {
  application: {
    routesRoot: "./routes",
    factory: "./non-function-application.ts",
  },
};\n`,
    );
    const nonFunctionCapture = captureIo();
    assertEquals(
      await runCli([
        "check",
        "--config",
        join(root, "non-function.config.ts"),
      ], {
        io: nonFunctionCapture.io,
      }),
      1,
    );
    assert(
      nonFunctionCapture.stderr[0].includes(
        "application factory must be a function",
      ),
    );

    await Deno.writeTextFile(
      join(root, "missing.config.ts"),
      `export default {
  application: {
    routesRoot: "./routes",
    factory: "./missing-application.ts",
  },
};\n`,
    );
    const missingCapture = captureIo();
    assertEquals(
      await runCli(["check", "--config", join(root, "missing.config.ts")], {
        io: missingCapture.io,
      }),
      1,
    );
    assert(
      missingCapture.stderr[0].toLowerCase().includes("module not found"),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("routes and check load strict config and compile the same frozen router", async () => {
  const root = await Deno.makeTempDir();
  try {
    const initCapture = captureIo();
    assertEquals(
      await runCli(["init", "--root", root], { io: initCapture.io }),
      0,
    );
    const configPath = join(root, "oxian.config.ts");

    const routesCapture = captureIo();
    assertEquals(
      await runCli(["routes", "--config", configPath], {
        io: routesCapture.io,
      }),
      0,
    );
    assert(routesCapture.stdout[0].includes("GET"));
    assert(routesCapture.stdout[0].includes("/"));

    const checkCapture = captureIo();
    assertEquals(
      await runCli(["check", "--config", configPath], {
        io: checkCapture.io,
      }),
      0,
    );
    assertEquals(
      checkCapture.stdout,
      ["configuration, application entry, and 1 route are valid"],
    );

    const invalidRoot = join(root, "invalid");
    await Deno.mkdir(invalidRoot);
    const invalidConfig = join(invalidRoot, "invalid.config.ts");
    await Deno.writeTextFile(
      invalidConfig,
      'export default { unknown: true, application: { routesRoot: "../routes" } };\n',
    );
    const invalidCapture = captureIo();
    assertEquals(
      await runCli(["check", "--config", invalidConfig], {
        io: invalidCapture.io,
      }),
      1,
    );
    assert(invalidCapture.stderr[0].includes('unknown key "unknown"'));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
