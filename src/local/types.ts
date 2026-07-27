import type { Application } from "../app/types.ts";
import type { OxianConfig } from "../config/types.ts";
import type { Hypervisor } from "../hypervisor/types.ts";
import type { WorkerCredential, WorkerIdentity } from "../protocol/types.ts";
import type { FileRouter } from "../router/types.ts";
import type {
  WorkerClient,
  WorkerClientResult,
  WorkerResumeCredentialPersister,
} from "../worker/types.ts";

export type LocalRuntimeMode = "start" | "dev";

export type LocalRuntimeState =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export type LocalRuntimeOptions = Readonly<{
  config: OxianConfig;
  mode?: LocalRuntimeMode;
  listener?: Readonly<{
    hostname?: string;
    /** Port 0 asks the operating system for an ephemeral listener port. */
    port?: number;
  }>;
  workerId?: string;
  capacity?: number;
}>;

export type LocalRuntimeSnapshot = Readonly<{
  state: LocalRuntimeState;
  listenerUrl?: string;
  workerUrl?: string;
  identity?: WorkerIdentity;
}>;

export type LocalRuntimeRunning = Readonly<{
  listenerUrl: URL;
  workerUrl: URL;
  identity: WorkerIdentity;
  router: FileRouter<unknown>;
  application: Application<unknown>;
  hypervisor: Hypervisor;
  worker: WorkerClient;
}>;

export type LocalRuntime = Readonly<{
  start(): Promise<LocalRuntimeRunning>;
  stop(reason?: string): Promise<void>;
  readonly finished: Promise<void>;
  snapshot(): LocalRuntimeSnapshot;
}>;

export type DurableCredentialStore = Readonly<{
  mode: "durable";
  path: string;
}>;

export type EphemeralCredentialStore = Readonly<{
  mode: "ephemeral";
}>;

export type WorkerCredentialStore =
  | DurableCredentialStore
  | EphemeralCredentialStore;

export type WorkerManifest = Readonly<{
  gatewayUrl: string;
  identity: WorkerIdentity;
  credential: WorkerCredential;
  handshakeId: string;
  resumeExpiresAtMs?: number;
  capacity: number;
  applicationConfig: string;
  credentialStore: WorkerCredentialStore;
}>;

export type LoadWorkerManifestSource = string | URL;

export type WorkerResumeCredentialState = Readonly<{
  schema: "oxian.worker-resume.v1";
  identity: WorkerIdentity;
  credential: Readonly<{
    kind: "resume";
    capability: string;
  }>;
  handshakeId: string;
  resumeExpiresAtMs: number;
}>;

export type AtomicResumeCredentialStore = Readonly<{
  path: string;
  load(): Promise<WorkerResumeCredentialState | undefined>;
  persist: WorkerResumeCredentialPersister;
  close(): Promise<void>;
}>;

export type ManifestWorkerRuntimeOptions = Readonly<{
  manifest: WorkerManifest;
}>;

export type ManifestWorkerRuntimeRunning = Readonly<{
  router: FileRouter<unknown>;
  application: Application<unknown>;
  worker: WorkerClient;
  workerRun: Promise<WorkerClientResult>;
}>;

export type ManifestWorkerRuntime = Readonly<{
  start(): Promise<ManifestWorkerRuntimeRunning>;
  stop(reason?: string): Promise<void>;
  readonly finished: Promise<void>;
  snapshot(): Readonly<{
    state: LocalRuntimeState;
    worker?: ReturnType<WorkerClient["snapshot"]>;
  }>;
}>;
