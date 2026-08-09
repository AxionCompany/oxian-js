import {
  createHypervisor as createPublicHypervisor,
  type Hypervisor,
  type HypervisorConfig,
  type HypervisorOptions,
  type HypervisorScheduler,
} from "../../src/hypervisor/index.ts";
import type { HypervisorLifecycleCallbacks } from "../../src/lifecycle/index.ts";
import type { InProcessTransport } from "../../src/transport/index.ts";
import type { JsonObject, WorkerIdentity } from "../../src/protocol/index.ts";
import type {
  AcceptanceCommit,
  CredentialLifecycle,
  RegistrationExchange,
  SessionRegistry,
  WorkerDefinition,
  WorkerStore,
} from "../../src/supervisor/index.ts";

export const TEST_WORKER_PATH = "/_oxian/workers/connect";
export type SessionLifecycleCallbacks = Pick<
  HypervisorLifecycleCallbacks,
  "onReady" | "onHeartbeat" | "onDisconnect"
>;
const localTransports = new WeakMap<Hypervisor, InProcessTransport>();

export function localTransportFor(hypervisor: Hypervisor): InProcessTransport {
  const transport = localTransports.get(hypervisor);
  if (transport === undefined) {
    throw new TypeError(
      "Hypervisor was not created by the protocol test adapter",
    );
  }
  return transport;
}

type TestControl = Readonly<{
  authority: Pick<CredentialLifecycle, "exchange">;
  repository: Pick<WorkerStore, "getDefinition" | "assertCurrent">;
  bootstrap?(
    input: Readonly<{
      identity: WorkerIdentity;
      definition: WorkerDefinition;
      exchange: RegistrationExchange;
      signal: AbortSignal;
    }>,
  ): JsonObject | Promise<JsonObject>;
  validateReady?(
    input: Readonly<{
      identity: WorkerIdentity;
      definition: WorkerDefinition;
      exchange: RegistrationExchange;
      sessionGeneration: number;
      connectionId: string;
      metadata: JsonObject;
      signal: AbortSignal;
    }>,
  ): void | Promise<void>;
}>;

export type ProtocolTestHypervisorOptions = Readonly<{
  control?: TestControl;
  commitAcceptedWork(commit: AcceptanceCommit): Promise<void>;
  sessionCallbacks?: SessionLifecycleCallbacks;
  config?: Partial<HypervisorConfig>;
  sessions?: SessionRegistry;
  fallback?: HypervisorOptions["fallback"];
  clock?: () => number;
  scheduler?: HypervisorScheduler;
  createConnectionId?: () => string;
}>;

/** Keeps v1 wire characterization tests independent from public DX cleanup. */
export function createProtocolTestHypervisor(
  options: ProtocolTestHypervisorOptions,
): Hypervisor {
  const control = options.control;
  const exchanges = new Map<string, RegistrationExchange>();
  const exchangeKey = (workerId: string, sessionGeneration: number): string =>
    `${workerId}:${sessionGeneration}`;

  const callbacks: HypervisorLifecycleCallbacks = {
    onWorkAccepted: async (context) => {
      await options.commitAcceptedWork(Object.freeze({
        operationId: context.operationId,
        workload: context.workload,
        metadata: context.metadata,
        deliveryCount: 1,
        assignment: Object.freeze({
          fence: context.fence,
          streamId: context.streamId,
        }),
        claimedAtMs: options.clock?.() ?? Date.now(),
      }));
    },
    onReady: async (context) => {
      const exchange = exchanges.get(exchangeKey(
        context.fence.identity.workerId,
        context.fence.sessionGeneration,
      ));
      if (exchange !== undefined) {
        if (control?.validateReady !== undefined) {
          await control.validateReady({
            identity: context.fence.identity,
            definition: context.definition,
            exchange,
            sessionGeneration: context.fence.sessionGeneration,
            connectionId: context.fence.connectionId,
            metadata: context.metadata,
            signal: context.signal,
          });
        }
        await control!.repository.assertCurrent(context.fence.identity);
      }
      await options.sessionCallbacks?.onReady?.(context);
    },
    onHeartbeat: async (context) => {
      if (
        control !== undefined &&
        exchanges.has(exchangeKey(
          context.fence.identity.workerId,
          context.fence.sessionGeneration,
        ))
      ) {
        await control.repository.assertCurrent(context.fence.identity);
      }
      await options.sessionCallbacks?.onHeartbeat?.(context);
    },
    onDisconnect: (context) => {
      return options.sessionCallbacks?.onDisconnect?.(context);
    },
  };

  const local = Object.freeze({
    type: "in-process" as const,
    config: Object.freeze({ topic: `test-${crypto.randomUUID()}` }),
  });
  const hypervisor = createPublicHypervisor({
    transports: [local, {
      type: "websocket",
      config: { path: TEST_WORKER_PATH },
    }],
    admit: control === undefined
      ? () => {
        throw Object.assign(new Error("remote control is not configured"), {
          code: "authentication_failed",
        });
      }
      : async (context) => {
        await control.repository.assertCurrent(context.identity);
        const definition = await control.repository.getDefinition(
          context.identity.workerId,
        );
        if (definition === undefined) {
          throw Object.assign(new Error("Worker definition is missing"), {
            code: "stale_attempt",
          });
        }
        const exchange = await control.authority.exchange({
          identity: context.identity,
          credential: context.credential,
          handshakeId: context.handshakeId,
        });
        const bootstrap = await control.bootstrap?.({
          identity: context.identity,
          definition,
          exchange,
          signal: context.signal,
        });
        exchanges.set(
          exchangeKey(context.identity.workerId, exchange.sessionGeneration),
          exchange,
        );
        return Object.freeze({
          definition,
          sessionGeneration: exchange.sessionGeneration,
          authenticatedWith: exchange.authenticatedWith,
          resume: Object.freeze({
            credential: exchange.resume.credential,
            expiresAtMs: exchange.resume.expiresAtMs,
          }),
          bootstrap: bootstrap ?? {},
        });
      },
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
    ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.scheduler === undefined
      ? {}
      : { scheduler: options.scheduler }),
    ...(options.createConnectionId === undefined
      ? {}
      : { createConnectionId: options.createConnectionId }),
  }, callbacks);
  localTransports.set(hypervisor, local);
  return hypervisor;
}
