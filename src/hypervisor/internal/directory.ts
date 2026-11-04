import type { ConnectionRecord } from "./model.ts";

export type ConnectionDirectory = Readonly<{
  readonly records: Set<ConnectionRecord>;
  add(record: ConnectionRecord): void;
  remove(record: ConnectionRecord): void;
  get(connectionId: string): ConnectionRecord | undefined;
  reserveId(record: ConnectionRecord): string;
  publish(record: ConnectionRecord): void;
  /**
   * The worker's published connections. More than one is live only during a
   * handoff, while a predecessor finishes its own streams.
   */
  lineage(workerId: string): readonly ConnectionRecord[];
}>;

/**
 * Owns process-local socket identity and lookup state.
 *
 * Reservation is separate from publication so asynchronous authentication
 * cannot issue the same connection ID to two concurrent handshakes.
 */
export function createConnectionDirectory(
  createConnectionId: () => string,
): ConnectionDirectory {
  const records = new Set<ConnectionRecord>();
  const byConnectionId = new Map<string, ConnectionRecord>();
  const reservedConnectionIds = new Set<string>();
  const byWorker = new Map<string, Set<ConnectionRecord>>();

  const add = (record: ConnectionRecord): void => {
    records.add(record);
  };

  const remove = (record: ConnectionRecord): void => {
    records.delete(record);
    const workerId = record.fence?.identity.workerId;
    const lineage = workerId === undefined ? undefined : byWorker.get(workerId);
    if (lineage?.delete(record) && lineage.size === 0) {
      byWorker.delete(workerId!);
    }
    if (record.connectionId === undefined) return;
    reservedConnectionIds.delete(record.connectionId);
    if (byConnectionId.get(record.connectionId) === record) {
      byConnectionId.delete(record.connectionId);
    }
  };

  const get = (connectionId: string): ConnectionRecord | undefined =>
    byConnectionId.get(connectionId);

  const reserveId = (record: ConnectionRecord): string => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const connectionId = createConnectionId();
      if (
        !byConnectionId.has(connectionId) &&
        !reservedConnectionIds.has(connectionId)
      ) {
        reservedConnectionIds.add(connectionId);
        record.connectionId = connectionId;
        return connectionId;
      }
    }
    throw new TypeError(
      "createConnectionId() repeatedly returned an active identifier",
    );
  };

  const publish = (record: ConnectionRecord): void => {
    if (record.connectionId === undefined) {
      throw new TypeError("cannot publish a connection without a reserved ID");
    }
    reservedConnectionIds.delete(record.connectionId);
    byConnectionId.set(record.connectionId, record);
    const workerId = record.fence?.identity.workerId;
    if (workerId === undefined) return;
    let lineage = byWorker.get(workerId);
    if (lineage === undefined) byWorker.set(workerId, (lineage = new Set()));
    lineage.add(record);
  };

  const lineage = (workerId: string): readonly ConnectionRecord[] => [
    ...(byWorker.get(workerId) ?? []),
  ];

  return Object.freeze({
    records,
    add,
    remove,
    get,
    reserveId,
    publish,
    lineage,
  });
}
