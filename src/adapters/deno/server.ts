import { observeListenerSettlement } from "../../hypervisor/internal/listener.ts";
import {
  createHypervisorError,
  listenerUrl,
} from "../../hypervisor/internal/primitives.ts";
import type { Hypervisor, HypervisorListener } from "../../hypervisor/types.ts";
import { adaptWebSocket } from "../../transport/socket.ts";
import type { DenoServeOptions } from "./types.ts";

/** Adapts a portable Hypervisor to Deno's Fetch/WebSocket upgrade boundary. */
export function handler(
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
        adaptWebSocket(upgraded.socket),
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

/** Starts a Deno listener for an existing application-owned Hypervisor. */
export function serve(options: DenoServeOptions): HypervisorListener {
  const { hypervisor, hostname = "127.0.0.1", port = 0, signal } = options;
  if (!hypervisor.snapshot().acceptingConnections) {
    throw createHypervisorError(
      "shutting_down",
      "cannot listen after Hypervisor shutdown begins",
    );
  }
  signal?.throwIfAborted();
  const fetch = handler(hypervisor);
  const server = Deno.serve({ hostname, port, onListen() {} }, fetch);
  if (server.addr.transport !== "tcp") {
    throw new TypeError("Hypervisor listener must use a TCP address");
  }
  let closed: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (closed !== undefined) return closed;
    closed = server.shutdown().catch(() => undefined).then(() => undefined);
    return closed;
  };
  const listener: HypervisorListener = Object.freeze({
    hostname: server.addr.hostname,
    port: server.addr.port,
    url: listenerUrl(server.addr.hostname, server.addr.port),
    finished: server.finished,
    shutdown,
  });
  observeListenerSettlement({
    finished: server.finished,
    signal,
    close: shutdown,
    cleanup: () => undefined,
  });
  return listener;
}
