import type {
  JsonObject,
  WorkerCredential,
  WorkerIdentity,
} from "../protocol/index.ts";
import type { SessionFence, WorkerDefinition } from "../supervisor/types.ts";
import type {
  HypervisorDisconnectEvent,
  HypervisorHeartbeatContext,
  HypervisorReadyContext,
} from "../hypervisor/types.ts";
import type {
  WorkerResumeCredentialUpdate,
  WorkerSnapshot,
  WorkerWorkContext,
} from "../worker/types.ts";

export type LifecycleStage =
  | "activate"
  | "register"
  | "connect"
  | "admit"
  | "handshake"
  | "ready"
  | "heartbeat"
  | "assign"
  | "work_assigned"
  | "work_accepted"
  | "start"
  | "complete"
  | "disconnect";

export type LifecycleContext = Readonly<{
  stage: LifecycleStage;
  stageId: string;
  callbackAttempt: number;
  signal: AbortSignal;
}>;

export type WorkerActivationContext =
  & LifecycleContext
  & Readonly<{
    stage: "activate";
    workerId: string;
    workloads: readonly string[];
    capacity: number;
  }>;

export type WorkerActivationResult = Readonly<{
  identity: WorkerIdentity;
}>;

export type WorkerActivate = (
  context: WorkerActivationContext,
) =>
  | WorkerActivationResult
  | WorkerIdentity
  | Promise<WorkerActivationResult | WorkerIdentity>;

export type WorkerRegistrationContext =
  & LifecycleContext
  & Readonly<{
    stage: "register";
    identity: WorkerIdentity;
  }>;

export type WorkerRegistration = Readonly<{
  credential: WorkerCredential;
  expiresAtMs: number;
  handshakeId?: string;
  resumeExpiresAtMs?: number;
}>;

export type WorkerRegister = (
  context: WorkerRegistrationContext,
) => WorkerRegistration | Promise<WorkerRegistration>;

export type WorkerHandshakeContext =
  & LifecycleContext
  & Readonly<{
    stage: "handshake";
    identity: WorkerIdentity;
    connectionId: string;
    bootstrap: JsonObject;
    reconnecting: boolean;
    rotation: WorkerResumeCredentialUpdate;
  }>;

export type WorkerHandshake = (
  context: WorkerHandshakeContext,
) => JsonObject | void | Promise<JsonObject | void>;

export type HypervisorAdmitContext =
  & LifecycleContext
  & Readonly<{
    stage: "admit";
    identity: WorkerIdentity;
    credential: WorkerCredential;
    handshakeId: string;
    workloads: readonly string[];
    capacity: number;
  }>;

export type HypervisorAdmission = Readonly<{
  definition: WorkerDefinition;
  sessionGeneration: number;
  authenticatedWith: WorkerCredential["kind"];
  resume: WorkerRegistration;
  bootstrap?: JsonObject;
}>;

export type HypervisorAdmit = (
  context: HypervisorAdmitContext,
) => HypervisorAdmission | Promise<HypervisorAdmission>;

export type HypervisorAssignContext =
  & LifecycleContext
  & Readonly<{
    stage: "assign";
    operationId: string;
    workload: string;
    metadata: JsonObject;
    target?: Readonly<{ workerId: string }>;
    available: readonly SessionFence[];
  }>;

export type HypervisorAssign = (
  context: HypervisorAssignContext,
) => SessionFence | undefined | Promise<SessionFence | undefined>;

export type WorkerWorkLifecycleContext =
  & LifecycleContext
  & Readonly<{
    identity: WorkerIdentity;
    connectionId: string;
    streamId: string;
    workload: string;
    metadata: JsonObject;
  }>;

export type HypervisorWorkLifecycleContext =
  & WorkerWorkLifecycleContext
  & Readonly<{
    operationId: string;
  }>;

export type HypervisorWorkAssignedContext =
  & LifecycleContext
  & Readonly<{
    stage: "work_assigned";
    operationId: string;
    workload: string;
    target?: Readonly<{ workerId: string }>;
    metadata: JsonObject;
    deadlineAtMs?: number;
    deliveryCount: number;
    assignment: Readonly<{
      fence: SessionFence;
      streamId: string;
    }>;
    assignedAtMs: number;
  }>;

export type WorkerWorkAcceptedContext =
  & WorkerWorkLifecycleContext
  & Readonly<{ stage: "work_accepted" }>;

export type WorkerStartContext =
  & WorkerWorkLifecycleContext
  & Readonly<{
    stage: "start";
    work: WorkerWorkContext;
  }>;

export type WorkerCompleteContext =
  & WorkerWorkLifecycleContext
  & Readonly<{
    stage: "complete";
    outcome: "completed" | "cancelled" | "failed";
    error?: unknown;
  }>;

export type HypervisorWorkAcceptedContext =
  & HypervisorWorkLifecycleContext
  & Readonly<{
    stage: "work_accepted";
    fence: SessionFence;
  }>;

export type HypervisorStartContext =
  & HypervisorWorkLifecycleContext
  & Readonly<{
    stage: "start";
    fence: SessionFence;
  }>;

export type HypervisorCompleteContext =
  & HypervisorWorkLifecycleContext
  & Readonly<{
    stage: "complete";
    fence: SessionFence;
    outcome: "completed" | "cancelled" | "failed" | "indeterminate";
    error?: Readonly<{ code?: string; message?: string }>;
  }>;

export type WorkerLifecycleCallbacks = Readonly<{
  onActivate?(
    context: WorkerActivationContext & WorkerActivationResult,
  ): void | Promise<void>;
  onRegister?(
    context: WorkerRegistrationContext & WorkerRegistration,
  ): void | Promise<void>;
  onHandshake?(context: WorkerHandshakeContext): void | Promise<void>;
  onReady?(
    context:
      & LifecycleContext
      & Readonly<{
        stage: "ready";
        snapshot: WorkerSnapshot;
      }>,
  ): void | Promise<void>;
  onWorkAccepted?(context: WorkerWorkAcceptedContext): void | Promise<void>;
  onStart?(context: WorkerStartContext): void | Promise<void>;
  onComplete?(context: WorkerCompleteContext): void | Promise<void>;
  onDisconnect?(
    context:
      & LifecycleContext
      & Readonly<{
        stage: "disconnect";
        identity?: WorkerIdentity;
        reason: unknown;
      }>,
  ): void | Promise<void>;
}>;

export type HypervisorLifecycleCallbacks = Readonly<{
  onConnect?(
    context:
      & LifecycleContext
      & Readonly<{
        stage: "connect";
        connectionId: string;
      }>,
  ): void | Promise<void>;
  onAdmit?(
    context: HypervisorAdmitContext & HypervisorAdmission,
  ): void | Promise<void>;
  onHandshake?(
    context:
      & LifecycleContext
      & Readonly<{
        stage: "handshake";
        fence: SessionFence;
        definition: WorkerDefinition;
      }>,
  ): void | Promise<void>;
  onReady?(
    context:
      & HypervisorReadyContext
      & LifecycleContext
      & Readonly<{
        stage: "ready";
      }>,
  ): void | Promise<void>;
  onHeartbeat?(
    context:
      & HypervisorHeartbeatContext
      & LifecycleContext
      & Readonly<{
        stage: "heartbeat";
      }>,
  ): void | Promise<void>;
  onWorkAssigned?(context: HypervisorWorkAssignedContext): void | Promise<void>;
  onWorkAccepted?(context: HypervisorWorkAcceptedContext): void | Promise<void>;
  onStart?(context: HypervisorStartContext): void | Promise<void>;
  onComplete?(context: HypervisorCompleteContext): void | Promise<void>;
  onDisconnect?(
    event:
      & HypervisorDisconnectEvent
      & LifecycleContext
      & Readonly<{
        stage: "disconnect";
      }>,
  ): void | Promise<void>;
}>;

export type WorkerLifecycleEvent =
  | Readonly<{ type: "state"; snapshot: WorkerSnapshot }>
  | Readonly<{ type: "closed"; reason: unknown }>;
