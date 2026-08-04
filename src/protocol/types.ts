/**
 * Wire-level types for the Oxian worker protocol.
 *
 * The package version and wire protocol version intentionally evolve
 * independently. A 0.20.x runtime speaks `oxian.worker.v1` until the wire
 * contract itself needs a breaking change.
 */

export const WORKER_PROTOCOL = "oxian.worker.v1" as const;

export type WorkerProtocol = typeof WORKER_PROTOCOL;

export type JsonPrimitive = boolean | number | string | null;

export type JsonValue =
  | JsonPrimitive
  | JsonObject
  | readonly JsonValue[];

export type JsonObject = {
  readonly [key: string]: JsonValue;
};

/**
 * Identifies one fenced incarnation of a logical worker.
 *
 * `workerId` survives attempts. `attemptId` identifies one provisioned
 * Control-plane attempt and remains stable across process restarts, while
 * `epoch` fences older attempts and connections.
 */
export type WorkerIdentity = Readonly<{
  workerId: string;
  attemptId: string;
  epoch: number;
}>;

export type WorkerCredential =
  | Readonly<{
    kind: "registration";
    capability: string;
  }>
  | Readonly<{
    kind: "resume";
    capability: string;
  }>;

export type HelloFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "hello";
  handshakeId: string;
  identity: WorkerIdentity;
  credential: WorkerCredential;
  workloads: readonly string[];
  capacity: number;
}>;

export type WelcomeFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "welcome";
  connectionId: string;
  heartbeatIntervalMs: number;
  leaseTimeoutMs: number;
  resumeCapability: string;
  resumeExpiresAtMs: number;
  bootstrap: JsonObject;
}>;

export type ReadyFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "ready";
  connectionId: string;
  capacity: number;
  metadata: JsonObject;
}>;

/**
 * Confirms that the Hypervisor durably committed and published Ready.
 *
 * A worker must not report itself ready, emit heartbeats, or accept work until
 * this frame arrives for the current connection.
 */
export type ReadyAckFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "ready_ack";
  connectionId: string;
}>;

export type HeartbeatFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "heartbeat";
  connectionId: string;
  sequence: number;
  inflight: number;
  availableCapacity: number;
  metadata: JsonObject;
}>;

export type DrainFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "drain";
  connectionId: string;
  reason: string;
  deadlineAtMs: number;
}>;

export type ShutdownFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "shutdown";
  connectionId: string;
  reason: string;
}>;

export type DrainedFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "drained";
  connectionId: string;
}>;

export type ProtocolErrorFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "protocol_error";
  connectionId?: string;
  code: string;
  message: string;
}>;

export type WorkOpenFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "work.open";
  streamId: string;
  workload: string;
  metadata: JsonObject;
  deadlineAtMs?: number;
}>;

export type WorkAcceptedFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "work.accepted";
  streamId: string;
}>;

/**
 * Authorizes a worker that has reserved a stream with `work.accepted` to invoke
 * the workload. The Hypervisor must mark the operation non-replayable before
 * sending this frame.
 */
export type WorkStartFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "work.start";
  streamId: string;
}>;

export type WorkMetadataFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "work.metadata";
  streamId: string;
  metadata: JsonObject;
}>;

export type WorkEndFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "work.end";
  streamId: string;
}>;

export type WorkCancelFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "work.cancel";
  streamId: string;
  reason: string;
}>;

export type WorkErrorFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "work.error";
  streamId: string;
  code: string;
  message: string;
  details?: JsonObject;
}>;

export type WorkCreditFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "work.credit";
  streamId: string;
  bytes: number;
}>;

export type ControlFrame =
  | HelloFrame
  | WelcomeFrame
  | ReadyFrame
  | ReadyAckFrame
  | HeartbeatFrame
  | DrainFrame
  | ShutdownFrame
  | DrainedFrame
  | ProtocolErrorFrame
  | WorkOpenFrame
  | WorkAcceptedFrame
  | WorkStartFrame
  | WorkMetadataFrame
  | WorkEndFrame
  | WorkCancelFrame
  | WorkErrorFrame
  | WorkCreditFrame;

export type ControlFrameType = ControlFrame["type"];

export type WorkerToHypervisorControlFrame =
  | HelloFrame
  | ReadyFrame
  | HeartbeatFrame
  | DrainedFrame
  | ProtocolErrorFrame
  | WorkAcceptedFrame
  | WorkMetadataFrame
  | WorkEndFrame
  | WorkCancelFrame
  | WorkErrorFrame
  | WorkCreditFrame;

export type HypervisorToWorkerControlFrame =
  | WelcomeFrame
  | ReadyAckFrame
  | DrainFrame
  | ShutdownFrame
  | ProtocolErrorFrame
  | WorkOpenFrame
  | WorkStartFrame
  | WorkEndFrame
  | WorkCancelFrame
  | WorkErrorFrame
  | WorkCreditFrame;

export type WorkDataFrame = Readonly<{
  type: "work.data";
  streamId: string;
  sequence: number;
  payload: Uint8Array;
}>;
