import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  createAtomicResumeCredentialStore,
} from "../../src/local/credential_store.ts";
import { loadWorkerManifest } from "../../src/local/worker_manifest.ts";

const identity = Object.freeze({
  workerId: "manifest-worker",
  attemptId: "attempt-1",
  epoch: 1,
});

Deno.test("worker manifest is strict and rebases only local application/store paths", async () => {
  const root = await Deno.makeTempDir();
  try {
    const manifestPath = join(root, "worker.ts");
    await Deno.writeTextFile(
      manifestPath,
      `export default {
  gatewayUrl: "ws://127.0.0.1:8080/_oxian/workers/connect",
  identity: {
    workerId: "manifest-worker",
    attemptId: "attempt-1",
    epoch: 1,
  },
  credential: {
    kind: "registration",
    capability: "registration-secret",
  },
  handshakeId: "handshake-1",
  capacity: 2,
  applicationConfig: "./application.ts",
  credentialStore: {
    mode: "durable",
    path: "./state/resume.json",
  },
} as const;
`,
    );
    const manifest = await loadWorkerManifest(manifestPath);
    assertEquals(
      manifest.gatewayUrl,
      "ws://127.0.0.1:8080/_oxian/workers/connect",
    );
    assertEquals(
      manifest.applicationConfig,
      new URL(
        `file://${join(root, "application.ts")}`,
      ).href,
    );
    assertEquals(manifest.credentialStore, {
      mode: "durable",
      path: join(root, "state", "resume.json"),
    });

    const unknownPath = join(root, "unknown.ts");
    await Deno.writeTextFile(
      unknownPath,
      `export default {
  gatewayUrl: "wss://gateway.example/workers",
  identity: { workerId: "w", attemptId: "a", epoch: 1 },
  credential: { kind: "registration", capability: "secret" },
  handshakeId: "h",
  capacity: 1,
  applicationConfig: "./application.ts",
  credentialStore: { mode: "ephemeral" },
  module: "./do-not-load.ts",
};
`,
    );
    await assertRejects(
      () => loadWorkerManifest(unknownPath),
      TypeError,
      'unknown key "module"',
    );

    const insecurePath = join(root, "insecure.ts");
    await Deno.writeTextFile(
      insecurePath,
      `export default {
  gatewayUrl: "ws://gateway.example/workers",
  identity: { workerId: "w", attemptId: "a", epoch: 1 },
  credential: { kind: "registration", capability: "secret" },
  handshakeId: "h",
  capacity: 1,
  applicationConfig: "./application.ts",
  credentialStore: { mode: "ephemeral" },
};
`,
    );
    await assertRejects(
      () => loadWorkerManifest(insecurePath),
      TypeError,
      "only for a loopback host",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resume credentials use locked atomic compare-and-set persistence", async () => {
  const root = await Deno.makeTempDir();
  const path = join(root, "state", "resume.json");
  const initialHandshakeId = "handshake-initial";
  const store = createAtomicResumeCredentialStore({
    path,
    identity,
    initialHandshakeId,
  });
  try {
    assertEquals(await store.load(), undefined);
    const competing = createAtomicResumeCredentialStore({
      path,
      identity,
      initialHandshakeId,
    });
    await assertRejects(
      () => competing.load(),
      Error,
      "already owned by this process",
    );
    await competing.close();

    const update = Object.freeze({
      credential: Object.freeze({
        kind: "resume" as const,
        capability: "resume-secret-1",
      }),
      replacesHandshakeId: initialHandshakeId,
      handshakeId: "handshake-next",
      resumeExpiresAtMs: 4_000_000_000_000,
    });
    await store.persist(update, { signal: new AbortController().signal });
    await store.persist(update, { signal: new AbortController().signal });
    const serialized = JSON.parse(await Deno.readTextFile(path));
    assertEquals(serialized.schema, "oxian.worker-resume.v1");
    assertEquals(serialized.handshakeId, "handshake-next");
    assertEquals(serialized.credential.kind, "resume");

    const stat = await Deno.stat(path);
    if (stat.mode !== null) {
      assertEquals(stat.mode & 0o777, 0o600);
    }
    await assertRejects(
      async () => {
        await store.persist({
          credential: {
            kind: "resume",
            capability: "resume-secret-stale",
          },
          replacesHandshakeId: initialHandshakeId,
          handshakeId: "handshake-stale",
          resumeExpiresAtMs: 4_000_000_000_001,
        }, { signal: new AbortController().signal });
      },
      Error,
      "predecessor does not match",
    );

    await store.close();
    await store.close();
    const reopened = createAtomicResumeCredentialStore({
      path,
      identity,
      initialHandshakeId,
    });
    assertEquals((await reopened.load())?.handshakeId, "handshake-next");
    await reopened.close();
  } finally {
    await store.close().catch(() => undefined);
    await Deno.remove(root, { recursive: true });
  }
});
