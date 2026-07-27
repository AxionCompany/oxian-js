import type { Hypervisor, HypervisorListener } from "../types.ts";
import type { ListenerRecord } from "./model.ts";
import { createHypervisorError, listenerUrl } from "./primitives.ts";

export function observeListenerSettlement(
  input: Readonly<{
    finished: Promise<void>;
    signal?: AbortSignal;
    close(): Promise<void>;
    cleanup(): void;
  }>,
): void {
  let settled = false;
  const abort = (): void => {
    void input.close();
  };
  const cleanup = (): void => {
    if (settled) return;
    settled = true;
    input.signal?.removeEventListener("abort", abort);
    input.cleanup();
  };

  input.signal?.addEventListener("abort", abort, { once: true });
  // Supplying both handlers consumes a fatal listener rejection while preserving
  // the original `finished` Promise exposed to the caller.
  void input.finished.then(cleanup, cleanup);
}

export function createListenerFactory(
  options: Readonly<{
    isAcceptingConnections(): boolean;
    fetch: Hypervisor["fetch"];
    listeners: Set<ListenerRecord>;
  }>,
): Hypervisor["listen"] {
  return (
    listenOptions: Parameters<Hypervisor["listen"]>[0] = {},
  ): HypervisorListener => {
    if (!options.isAcceptingConnections()) {
      throw createHypervisorError(
        "shutting_down",
        "cannot listen after Hypervisor shutdown begins",
      );
    }
    const hostname = listenOptions.hostname ?? "127.0.0.1";
    const port = listenOptions.port ?? 0;
    listenOptions.signal?.throwIfAborted();
    const server = Deno.serve({
      hostname,
      port,
      onListen() {},
    }, options.fetch);
    if (server.addr.transport !== "tcp") {
      throw new TypeError("Hypervisor listener must use a TCP address");
    }
    const actualHostname = server.addr.hostname;
    const actualPort = server.addr.port;
    let closed: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (closed !== undefined) return closed;
      closed = server.shutdown().catch(() => undefined).then(() => undefined);
      return closed;
    };
    const listener: HypervisorListener = Object.freeze({
      hostname: actualHostname,
      port: actualPort,
      url: listenerUrl(actualHostname, actualPort),
      finished: server.finished,
      shutdown: close,
    });
    const record = { listener, close };
    options.listeners.add(record);
    observeListenerSettlement({
      finished: server.finished,
      signal: listenOptions.signal,
      close,
      cleanup: () => {
        options.listeners.delete(record);
      },
    });
    return listener;
  };
}
