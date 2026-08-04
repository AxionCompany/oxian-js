import type { ConnectionRecord } from "./model.ts";

export type ConnectionDirectory = Readonly<{
  readonly records: Set<ConnectionRecord>;
  add(record: ConnectionRecord): void;
  remove(record: ConnectionRecord): void;
  get(connectionId: string): ConnectionRecord | undefined;
  reserveId(record: ConnectionRecord): string;
  publish(record: ConnectionRecord): void;
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

  const add = (record: ConnectionRecord): void => {
    records.add(record);
  };

  const remove = (record: ConnectionRecord): void => {
    records.delete(record);
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
  };

  return Object.freeze({
    records,
    add,
    remove,
    get,
    reserveId,
    publish,
  });
}
