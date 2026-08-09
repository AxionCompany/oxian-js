import { assertEquals, assertRejects } from "@std/assert";
import {
  createCredentialLifecycle,
  createEphemeralCredentialLifecycle,
} from "../../src/supervisor/credentials.ts";
import type { SupervisorError } from "../../src/supervisor/types.ts";

const IDENTITY = {
  workerId: "worker-1",
  attemptId: "attempt-1",
  epoch: 1,
} as const;

function capabilityFactory() {
  let sequence = 0;
  return (kind: "registration" | "resume") => `${kind}-${++sequence}`;
}

Deno.test("registration exchange replays only the exact lost-welcome handshake", async () => {
  const authority = createEphemeralCredentialLifecycle({
    clock: () => 100,
    createCapability: capabilityFactory(),
  });
  const registration = await authority.issueRegistration(IDENTITY);
  const exchange = await authority.exchange({
    identity: IDENTITY,
    credential: registration.credential,
    handshakeId: "handshake-1",
  });

  assertEquals(exchange.authenticatedWith, "registration");
  assertEquals(exchange.sessionGeneration, 1);
  assertEquals(exchange.resume.credential.kind, "resume");
  assertEquals(
    await authority.exchange({
      identity: IDENTITY,
      credential: registration.credential,
      handshakeId: "handshake-1",
    }),
    exchange,
  );
  await assertRejects(
    () =>
      authority.exchange({
        identity: IDENTITY,
        credential: registration.credential,
        handshakeId: "handshake-other",
      }),
    Error,
    "already been consumed",
  );

  const resumed = await authority.exchange({
    identity: IDENTITY,
    credential: exchange.resume.credential,
    handshakeId: "handshake-2",
  });
  assertEquals(resumed.authenticatedWith, "resume");
  assertEquals(resumed.sessionGeneration, 2);
  assertEquals(
    await authority.exchange({
      identity: IDENTITY,
      credential: exchange.resume.credential,
      handshakeId: "handshake-2",
    }),
    resumed,
  );
  await assertRejects(
    () =>
      authority.exchange({
        identity: IDENTITY,
        credential: registration.credential,
        handshakeId: "handshake-1",
      }),
    Error,
    "already been consumed",
  );
});

Deno.test("concurrent exact handshake exchanges return one stable resume credential", async () => {
  const authority = createEphemeralCredentialLifecycle({
    clock: () => 100,
    createCapability: capabilityFactory(),
  });
  const registration = await authority.issueRegistration(IDENTITY);

  const results = await Promise.allSettled([
    authority.exchange({
      identity: IDENTITY,
      credential: registration.credential,
      handshakeId: "handshake-1",
    }),
    authority.exchange({
      identity: IDENTITY,
      credential: registration.credential,
      handshakeId: "handshake-1",
    }),
  ]);

  assertEquals(
    results.filter((result) => result.status === "fulfilled").length,
    2,
  );
  if (results[0].status === "fulfilled" && results[1].status === "fulfilled") {
    assertEquals(results[0].value, results[1].value);
  }
});

Deno.test("registration authority expires and revokes exact attempt credentials", async () => {
  let nowMs = 10;
  const authority = createEphemeralCredentialLifecycle({
    clock: () => nowMs,
    createCapability: capabilityFactory(),
    registrationTtlMs: 5,
  });
  const expired = await authority.issueRegistration(IDENTITY);
  nowMs = 15;
  const expiration = await assertRejects(() =>
    authority.exchange({
      identity: IDENTITY,
      credential: expired.credential,
      handshakeId: "handshake-expired",
    })
  ) as SupervisorError;
  assertEquals(expiration.code, "credential_expired");

  nowMs = 20;
  const revoked = await authority.issueRegistration(IDENTITY);
  await authority.revoke(IDENTITY);
  const revocation = await assertRejects(() =>
    authority.exchange({
      identity: IDENTITY,
      credential: revoked.credential,
      handshakeId: "handshake-revoked",
    })
  ) as SupervisorError;
  assertEquals(revocation.code, "credential_invalid");
});

Deno.test("pluggable registration authority cannot substitute identities or credential kinds", async () => {
  const authority = createCredentialLifecycle({
    issueRegistration() {
      return {
        identity: { ...IDENTITY, attemptId: "attempt-other" },
        credential: {
          kind: "registration",
          capability: "registration-1",
        },
        expiresAtMs: 100,
      };
    },
    exchange(input) {
      return {
        identity: input.identity,
        handshakeId: input.handshakeId,
        sessionGeneration: 1,
        authenticatedWith: input.credential.kind === "registration"
          ? "resume"
          : "registration",
        resume: {
          identity: input.identity,
          credential: { kind: "resume", capability: "resume-1" },
          expiresAtMs: 100,
        },
      };
    },
    revoke() {},
  });

  await assertRejects(
    () => authority.issueRegistration(IDENTITY),
    TypeError,
    "differs from requested identity",
  );
  await assertRejects(
    () =>
      authority.exchange({
        identity: IDENTITY,
        credential: {
          kind: "registration",
          capability: "registration-1",
        },
        handshakeId: "handshake-1",
      }),
    TypeError,
    "different credential kind",
  );
});

Deno.test("handshake replay is bounded and revocation removes a minted replay", async () => {
  let nowMs = 100;
  const authority = createEphemeralCredentialLifecycle({
    clock: () => nowMs,
    createCapability: capabilityFactory(),
    handshakeReplayTtlMs: 5,
    resumeTtlMs: 5,
  });
  const registration = await authority.issueRegistration(IDENTITY);
  await authority.exchange({
    identity: IDENTITY,
    credential: registration.credential,
    handshakeId: "handshake-1",
  });

  nowMs = 105;
  await assertRejects(
    () =>
      authority.exchange({
        identity: IDENTITY,
        credential: registration.credential,
        handshakeId: "handshake-1",
      }),
    Error,
    "already been consumed",
  );

  nowMs = 110;
  const next = await authority.issueRegistration(IDENTITY);
  await authority.exchange({
    identity: IDENTITY,
    credential: next.credential,
    handshakeId: "handshake-2",
  });
  await authority.revoke(IDENTITY);
  await assertRejects(
    () =>
      authority.exchange({
        identity: IDENTITY,
        credential: next.credential,
        handshakeId: "handshake-2",
      }),
    Error,
    "already been consumed",
  );
});

Deno.test("authority namespace and mint sequence prevent suffix reuse", async () => {
  let nowMs = 100;
  const authority = createEphemeralCredentialLifecycle({
    clock: () => nowMs,
    createCapability: () => "repeated-capability",
    handshakeReplayTtlMs: 5,
  });
  const registration = await authority.issueRegistration(IDENTITY);
  const first = await authority.exchange({
    identity: IDENTITY,
    credential: registration.credential,
    handshakeId: "handshake-1",
  });
  await authority.revoke(IDENTITY);
  nowMs = 1_000;
  const next = await authority.issueRegistration(IDENTITY);
  assertEquals(
    new Set([
      registration.credential.capability,
      first.resume.credential.capability,
      next.credential.capability,
    ]).size,
    3,
  );
});

Deno.test("resume mint cannot reuse a repeated generator suffix", async () => {
  const authority = createEphemeralCredentialLifecycle({
    clock: () => 100,
    createCapability: () => "same-suffix",
  });
  const registration = await authority.issueRegistration(IDENTITY);
  const exchange = await authority.exchange({
    identity: IDENTITY,
    credential: registration.credential,
    handshakeId: "handshake-1",
  });

  assertEquals(
    registration.credential.capability ===
      exchange.resume.credential.capability,
    false,
  );
  assertEquals(
    await authority.exchange({
      identity: IDENTITY,
      credential: registration.credential,
      handshakeId: "handshake-1",
    }),
    exchange,
  );
});

Deno.test("failed resume mint leaves current grant and predecessor replay intact", async () => {
  let calls = 0;
  let failMint = false;
  const authority = createEphemeralCredentialLifecycle({
    clock: () => 100,
    createCapability: () => {
      calls++;
      if (failMint) throw new Error("mint unavailable");
      return `capability-${calls}`;
    },
  });
  const registration = await authority.issueRegistration(IDENTITY);
  const first = await authority.exchange({
    identity: IDENTITY,
    credential: registration.credential,
    handshakeId: "handshake-1",
  });

  failMint = true;
  await assertRejects(
    () =>
      authority.exchange({
        identity: IDENTITY,
        credential: first.resume.credential,
        handshakeId: "handshake-2",
      }),
    Error,
    "mint unavailable",
  );
  assertEquals(
    await authority.exchange({
      identity: IDENTITY,
      credential: registration.credential,
      handshakeId: "handshake-1",
    }),
    first,
  );

  failMint = false;
  const second = await authority.exchange({
    identity: IDENTITY,
    credential: first.resume.credential,
    handshakeId: "handshake-2",
  });
  assertEquals(second.sessionGeneration, 2);
});
