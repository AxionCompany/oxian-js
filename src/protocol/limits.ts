/**
 * Hard interoperability and safety limits for `oxian.worker.v1`.
 *
 * Implementations may choose stricter local admission limits, but a v1 peer
 * must never emit a frame or declare capacity above these values.
 */
export type WorkerProtocolLimits = Readonly<{
  maxControlFrameBytes: number;
  maxDataPayloadBytes: number;
  maxOutstandingStreamCreditBytes: number;
  maxLifetimeStreams: number;
  maxWorkerCapacity: number;
}>;

export const WORKER_PROTOCOL_LIMITS: WorkerProtocolLimits = Object.freeze({
  maxControlFrameBytes: 64 * 1024,
  maxDataPayloadBytes: 1024 * 1024,
  maxOutstandingStreamCreditBytes: 16 * 1024 * 1024,
  maxLifetimeStreams: 65_536,
  maxWorkerCapacity: 1_024,
});
