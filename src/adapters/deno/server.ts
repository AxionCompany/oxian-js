import { createHypervisor } from "../../hypervisor/hypervisor.ts";
import { observeListenerSettlement } from "../../hypervisor/internal/listener.ts";
import {
  createHypervisorError,
  listenerUrl,
} from "../../hypervisor/internal/primitives.ts";
import type {
  Hypervisor,
  HypervisorListener,
  HypervisorListenOptions,
} from "../../hypervisor/types.ts";
import { createWebSocketWireConnection } from "../../transport/wire.ts";
import type { DenoHypervisor, DenoHypervisorOptions } from "./types.ts";

type ListenerRecord = Readonly<{
  listener: HypervisorListener;
  close(): Promise<void>;
}>;

/** Creates the Deno Fetch bridge for a portable Hypervisor core. */
export function createDenoHypervisorFetch(
  hypervisor: Hypervisor,
): (request: Request) => Response | Promise<Response> {
  return (request) => {
    const decision = hypervisor.prepare(request);
    if (decision.kind === "response") return decision.response;

    let upgraded: ReturnType<typeof Deno.upgradeWebSocket>;
    try {
      upgraded = Deno.upgradeWebSocket(request, {
        protocol: decision.protocol,
      });
    } catch {
      decision.cancel("invalid_upgrade");
      return new Response("Invalid WebSocket upgrade", { status: 400 });
    }
    try {
      decision.attach(
        createWebSocketWireConnection(upgraded.socket),
        decision.protocol,
      );
    } catch {
      try {
        upgraded.socket.close(4400, "connection_rejected");
      } catch {
        // Returning a non-upgrade response leaves the socket uncommitted.
      }
      decision.cancel("connection_rejected");
      return new Response("WebSocket connection rejected", { status: 400 });
    }
    return upgraded.response;
  };
}

function createDenoListenerFactory(
  input: Readonly<{
    hypervisor: Hypervisor;
    fetch(request: Request): Response | Promise<Response>;
    listeners: Set<ListenerRecord>;
  }>,
): (options?: HypervisorListenOptions) => HypervisorListener {
  return (options: HypervisorListenOptions = {}): HypervisorListener => {
    if (!input.hypervisor.snapshot().acceptingConnections) {
      throw createHypervisorError(
        "shutting_down",
        "cannot listen after Hypervisor shutdown begins",
      );
    }
    const hostname = options.hostname ?? "127.0.0.1";
    const port = options.port ?? 0;
    options.signal?.throwIfAborted();
    const server = Deno.serve({ hostname, port, onListen() {} }, input.fetch);
    if (server.addr.transport !== "tcp") {
      throw new TypeError("Hypervisor listener must use a TCP address");
    }
    let closed: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (closed !== undefined) return closed;
      closed = server.shutdown().catch(() => undefined).then(() => undefined);
      return closed;
    };
    const listener: HypervisorListener = Object.freeze({
      hostname: server.addr.hostname,
      port: server.addr.port,
      url: listenerUrl(server.addr.hostname, server.addr.port),
      finished: server.finished,
      shutdown: close,
    });
    const record = Object.freeze({ listener, close });
    input.listeners.add(record);
    observeListenerSettlement({
      finished: server.finished,
      signal: options.signal,
      close,
      cleanup: () => input.listeners.delete(record),
    });
    return listener;
  };
}

/**
 * Creates the backwards-complete Deno composition around the portable core.
 */
export function createDenoHypervisor(
  options: DenoHypervisorOptions,
): DenoHypervisor {
  const hypervisor = createHypervisor(options);
  const fetch = createDenoHypervisorFetch(hypervisor);
  const listeners = new Set<ListenerRecord>();
  const listen = createDenoListenerFactory({ hypervisor, fetch, listeners });
  let shutdownTask: Promise<void> | undefined;
  const shutdown = (reason = "hypervisor_shutdown"): Promise<void> => {
    if (shutdownTask !== undefined) return shutdownTask;
    shutdownTask = (async () => {
      await hypervisor.shutdown(reason);
      await Promise.allSettled([...listeners].map((entry) => entry.close()));
    })();
    return shutdownTask;
  };
  return Object.freeze({
    ...hypervisor,
    fetch,
    listen,
    shutdown,
  });
}
