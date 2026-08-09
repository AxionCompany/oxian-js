import type { WorkerWebSocketFactory } from "./types.ts";
import type { WorkerWebSocketLimits } from "../worker/types.ts";

export type InProcessTransport = Readonly<{
  type: "in-process";
  config: Readonly<{
    topic: string;
    maxQueuedBytes?: number;
    maxQueuedFrames?: number;
  }>;
}>;

export type HypervisorWebSocketTransport = Readonly<{
  type: "websocket";
  config: Readonly<{
    path: string;
  }>;
}>;

export type WorkerWebSocketTransport = Readonly<{
  type: "websocket";
  config: Readonly<{
    url: string | URL;
    allowInsecureLoopback?: boolean;
    connectTimeoutMs?: number;
    /** Provider-owned socket construction for transport-level authentication. */
    socket?: WorkerWebSocketFactory;
    limits?: WorkerWebSocketLimits;
  }>;
}>;

export type HypervisorTransport =
  | InProcessTransport
  | HypervisorWebSocketTransport;

export type WorkerTransport = InProcessTransport | WorkerWebSocketTransport;
