import type { WorkerCredential, WorkerIdentity } from "../protocol/types.ts";
import {
  copyIdentity,
  expectFiniteTimestamp,
  expectIdentifier,
  expectPositiveInteger,
  fail,
  freeze,
  sameIdentity,
} from "./internal.ts";
import type {
  RegistrationAuthority,
  RegistrationAuthorityHooks,
  RegistrationExchange,
  RegistrationGrant,
} from "./types.ts";

const MAX_CAPABILITY_LENGTH = 16_384;
const DEFAULT_REGISTRATION_TTL_MS = 5 * 60_000;
const DEFAULT_RESUME_TTL_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_HANDSHAKE_REPLAY_TTL_MS = 30_000;

function expectCapability(capability: string): string {
  if (
    typeof capability !== "string" ||
    capability.length === 0 ||
    capability.length > MAX_CAPABILITY_LENGTH
  ) {
    throw new TypeError("capability must be a non-empty bounded string");
  }
  return capability;
}

function copyCredential(credential: WorkerCredential): WorkerCredential {
  if (credential.kind !== "registration" && credential.kind !== "resume") {
    throw new TypeError("credential kind must be registration or resume");
  }
  return freeze({
    kind: credential.kind,
    capability: expectCapability(credential.capability),
  });
}

function copyGrant(grant: RegistrationGrant): RegistrationGrant {
  return freeze({
    identity: copyIdentity(grant.identity),
    credential: copyCredential(grant.credential),
    expiresAtMs: expectFiniteTimestamp(grant.expiresAtMs, "expiresAtMs"),
  });
}

function copyExchange(exchange: RegistrationExchange): RegistrationExchange {
  if (
    exchange.authenticatedWith !== "registration" &&
    exchange.authenticatedWith !== "resume"
  ) {
    throw new TypeError(
      "authenticatedWith must be registration or resume",
    );
  }
  const identity = copyIdentity(exchange.identity);
  const resume = copyGrant(exchange.resume);
  if (!sameIdentity(identity, resume.identity)) {
    throw new TypeError("resume grant identity differs from exchange identity");
  }
  if (resume.credential.kind !== "resume") {
    throw new TypeError("exchange must issue a resume credential");
  }
  return freeze({
    identity,
    handshakeId: expectIdentifier(exchange.handshakeId, "handshakeId"),
    sessionGeneration: expectPositiveInteger(
      exchange.sessionGeneration,
      "sessionGeneration",
    ),
    authenticatedWith: exchange.authenticatedWith,
    resume,
  });
}

/**
 * Adapts durable or remote authority hooks to the supervisor contract.
 *
 * `hooks.exchange` is the security boundary: implementations must atomically
 * consume the presented capability, mint its replacement, and persist a bounded
 * replay keyed by exact credential, identity, and handshake ID in one
 * transaction. An exact retry returns the same exchange; any other handshake
 * remains invalid. Every newly consumed credential must monotonically increment
 * `sessionGeneration` for that worker attempt, while exact replay returns the
 * original generation. Durable authorities retain that high-watermark for the
 * lifetime of the attempt (not merely the replay TTL). Consuming the resume or
 * revoking the identity must invalidate the preceding replay. Oxian deliberately
 * treats capability contents as opaque so applications can use database-backed,
 * signed, or hardware-bound credentials without changing the worker protocol.
 */
export function createRegistrationAuthority(
  hooks: RegistrationAuthorityHooks,
): RegistrationAuthority {
  return Object.freeze({
    async issueRegistration(identity, options) {
      const requestedIdentity = copyIdentity(identity);
      const grant = copyGrant(
        await hooks.issueRegistration(requestedIdentity, options),
      );
      if (!sameIdentity(grant.identity, requestedIdentity)) {
        throw new TypeError(
          "registration grant identity differs from requested identity",
        );
      }
      if (grant.credential.kind !== "registration") {
        throw new TypeError(
          "issueRegistration must issue a registration credential",
        );
      }
      return grant;
    },
    async exchange(input) {
      const identity = copyIdentity(input.identity);
      const credential = copyCredential(input.credential);
      const handshakeId = expectIdentifier(input.handshakeId, "handshakeId");
      const exchange = copyExchange(
        await hooks.exchange({
          identity,
          credential,
          handshakeId,
        }),
      );
      if (!sameIdentity(exchange.identity, identity)) {
        throw new TypeError(
          "registration exchange identity differs from requested identity",
        );
      }
      if (exchange.authenticatedWith !== credential.kind) {
        throw new TypeError(
          "registration exchange used a different credential kind",
        );
      }
      if (exchange.handshakeId !== handshakeId) {
        throw new TypeError(
          "registration exchange used a different handshake ID",
        );
      }
      return exchange;
    },
    async revoke(identity) {
      await hooks.revoke(copyIdentity(identity));
    },
  });
}

type StoredGrant = Readonly<{
  grant: RegistrationGrant;
}>;

type StoredReplay = Readonly<{
  exchange: RegistrationExchange;
  credential: WorkerCredential;
  expiresAtMs: number;
}>;

export function createInMemoryRegistrationAuthority(
  options: Readonly<{
    clock?: () => number;
    createCapability?: (
      kind: WorkerCredential["kind"],
      identity: WorkerIdentity,
    ) => string;
    registrationTtlMs?: number;
    resumeTtlMs?: number;
    handshakeReplayTtlMs?: number;
  }> = {},
): RegistrationAuthority {
  const clock = options.clock ?? Date.now;
  const createCapability = options.createCapability ??
    ((kind: WorkerCredential["kind"]) => `${kind}:${crypto.randomUUID()}`);
  const authorityNamespace = crypto.randomUUID();
  let mintSequence = 0;
  const registrationTtlMs = expectPositiveInteger(
    options.registrationTtlMs ?? DEFAULT_REGISTRATION_TTL_MS,
    "registrationTtlMs",
  );
  const resumeTtlMs = expectPositiveInteger(
    options.resumeTtlMs ?? DEFAULT_RESUME_TTL_MS,
    "resumeTtlMs",
  );
  const handshakeReplayTtlMs = expectPositiveInteger(
    options.handshakeReplayTtlMs ?? DEFAULT_HANDSHAKE_REPLAY_TTL_MS,
    "handshakeReplayTtlMs",
  );
  const grants = new Map<string, StoredGrant>();
  const replays = new Map<string, StoredReplay>();
  const resumeOrigins = new Map<string, string>();
  const sessionGenerations = new Map<string, number>();
  const tombstones = new Map<string, number>();

  const identityKey = (identity: WorkerIdentity): string =>
    `${identity.workerId.length}:${identity.workerId}:${identity.attemptId.length}:${identity.attemptId}:${identity.epoch}`;

  const expiresAt = (nowMs: number, ttlMs: number): number => {
    const value = nowMs + ttlMs;
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("capability expiration exceeds safe integer range");
    }
    return value;
  };

  const mint = (
    kind: WorkerCredential["kind"],
    identityInput: WorkerIdentity,
    ttlMs: number,
  ): RegistrationGrant => {
    const identity = copyIdentity(identityInput);
    const nowMs = expectFiniteTimestamp(clock(), "clock()");
    for (const [capability, tombstoneExpiresAtMs] of tombstones) {
      if (nowMs >= tombstoneExpiresAtMs) tombstones.delete(capability);
    }
    let capability = "";
    for (let attempt = 0; attempt < 8; attempt++) {
      const suffix = expectCapability(createCapability(kind, identity));
      const nextSequence = mintSequence + 1;
      if (!Number.isSafeInteger(nextSequence)) {
        throw new TypeError(
          "capability mint sequence exceeds safe integer range",
        );
      }
      capability = expectCapability(
        `${authorityNamespace}:${nextSequence}:${suffix}`,
      );
      if (
        !grants.has(capability) &&
        !replays.has(capability) &&
        !tombstones.has(capability) &&
        !Array.from(resumeOrigins.values()).includes(capability)
      ) {
        mintSequence = nextSequence;
        break;
      }
      capability = "";
    }
    if (capability.length === 0) {
      return fail(
        "already_exists",
        "capability generator repeatedly returned an active capability",
      );
    }

    const grant = freeze({
      identity,
      credential: freeze({ kind, capability }),
      expiresAtMs: expiresAt(nowMs, ttlMs),
    });
    grants.set(capability, { grant });
    return grant;
  };

  const deleteReplay = (capability: string): void => {
    const replay = replays.get(capability);
    if (replay !== undefined) {
      resumeOrigins.delete(replay.exchange.resume.credential.capability);
      replays.delete(capability);
      const nowMs = expectFiniteTimestamp(clock(), "clock()");
      tombstones.set(
        capability,
        expiresAt(nowMs, handshakeReplayTtlMs),
      );
    }
  };

  const revoke = (identity: WorkerIdentity): void => {
    for (const [capability, stored] of grants) {
      if (sameIdentity(stored.grant.identity, identity)) {
        grants.delete(capability);
        const nowMs = expectFiniteTimestamp(clock(), "clock()");
        tombstones.set(
          capability,
          expiresAt(nowMs, handshakeReplayTtlMs),
        );
      }
    }
    for (const [capability, replay] of replays) {
      if (sameIdentity(replay.exchange.identity, identity)) {
        deleteReplay(capability);
      }
    }
  };

  return createRegistrationAuthority({
    issueRegistration(identity, issueOptions) {
      revoke(identity);
      const ttlMs = issueOptions?.ttlMs === undefined
        ? registrationTtlMs
        : expectPositiveInteger(issueOptions.ttlMs, "ttlMs");
      return mint("registration", identity, ttlMs);
    },

    exchange(input) {
      const credential = copyCredential(input.credential);
      const handshakeId = expectIdentifier(input.handshakeId, "handshakeId");
      const stored = grants.get(credential.capability);
      if (stored === undefined) {
        const replay = replays.get(credential.capability);
        const replayNowMs = expectFiniteTimestamp(clock(), "clock()");
        if (replay !== undefined && replayNowMs >= replay.expiresAtMs) {
          deleteReplay(credential.capability);
        } else if (
          replay !== undefined &&
          replay.credential.kind === credential.kind &&
          replay.exchange.handshakeId === handshakeId &&
          sameIdentity(replay.exchange.identity, input.identity)
        ) {
          return replay.exchange;
        }
        return fail(
          "credential_invalid",
          "registration capability is invalid or has already been consumed",
        );
      }
      if (
        stored.grant.credential.kind !== credential.kind ||
        !sameIdentity(stored.grant.identity, input.identity)
      ) {
        return fail(
          "credential_invalid",
          "registration capability is invalid or has already been consumed",
        );
      }

      const nowMs = expectFiniteTimestamp(clock(), "clock()");
      if (nowMs >= stored.grant.expiresAtMs) {
        grants.delete(credential.capability);
        tombstones.set(
          credential.capability,
          expiresAt(nowMs, handshakeReplayTtlMs),
        );
        return fail(
          "credential_expired",
          "registration capability has expired",
        );
      }

      const priorReplayCapability = resumeOrigins.get(credential.capability);
      const generationKey = identityKey(input.identity);
      const previousGeneration = sessionGenerations.get(generationKey) ?? 0;
      const sessionGeneration = previousGeneration + 1;
      if (!Number.isSafeInteger(sessionGeneration)) {
        throw new TypeError("sessionGeneration exceeds safe integer range");
      }
      // Mint while the presented grant and its predecessor replay remain live.
      // If an injected suffix generator fails, the exchange has mutated no
      // credential, replay, origin, or generation state.
      const resume = mint("resume", input.identity, resumeTtlMs);
      const exchange = freeze({
        identity: copyIdentity(input.identity),
        handshakeId,
        sessionGeneration,
        authenticatedWith: credential.kind,
        resume,
      });
      grants.delete(credential.capability);
      if (priorReplayCapability !== undefined) {
        deleteReplay(priorReplayCapability);
        resumeOrigins.delete(credential.capability);
      }
      sessionGenerations.set(generationKey, sessionGeneration);
      replays.set(credential.capability, {
        exchange,
        credential,
        // The worker cannot learn the rotated credential until Welcome arrives.
        // Keep exactly this predecessor retryable for the issued resume's
        // lifetime; consuming/revoking that resume invalidates it sooner.
        expiresAtMs: resume.expiresAtMs,
      });
      resumeOrigins.set(
        resume.credential.capability,
        credential.capability,
      );
      return exchange;
    },

    revoke(identity) {
      revoke(identity);
    },
  });
}
