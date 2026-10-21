import {
  createConnectionBudget,
  type ConnectionBudget,
  type ConnectionLease,
} from "../../http/connection-budget.ts";
import { resolveRouteDecision } from "../../http/upgrade-decision.ts";
import {
  getClientAddress,
  isWebSocketRequest,
  setClientAddress,
} from "../../http/websocket.ts";
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
  budget: ConnectionBudget = createConnectionBudget(),
): (request: Request) => Response | Promise<Response> {
  return createHandler(hypervisor, budget, new Set(), new Set());
}

function createHandler(
  hypervisor: Hypervisor,
  budget: ConnectionBudget,
  sockets: Set<WebSocket>,
  pending: Set<AbortController>,
): (request: Request) => Promise<Response> {
  return async (nativeRequest) => {
    const controller = new AbortController();
    let lease: ConnectionLease | undefined;
    const abort = () => {
      lease?.release();
      controller.abort(nativeRequest.signal.reason);
    };
    const upgrading = isWebSocketRequest(nativeRequest);
    const request = upgrading
      ? new Request(nativeRequest, { signal: controller.signal })
      : nativeRequest;
    const address = getClientAddress(nativeRequest);
    if (address) setClientAddress(request, address);
    if (upgrading)
      nativeRequest.signal.addEventListener("abort", abort, { once: true });
    if (upgrading) pending.add(controller);
    const detach = () => {
      pending.delete(controller);
      nativeRequest.signal.removeEventListener("abort", abort);
    };
    if (nativeRequest.signal.aborted) abort();
    if (isWebSocketRequest(request)) {
      try {
        lease = budget.connect();
      } catch {
        detach();
        return new Response("connection budget exceeded", { status: 503 });
      }
    }
    let decision;
    try {
      decision = await resolveRouteDecision(hypervisor.prepare(request));
    } catch (error) {
      detach();
      lease?.release();
      throw error;
    }
    if (decision.kind === "response") {
      detach();
      lease?.release();
      return decision.response;
    }

    detach();
    let upgraded: ReturnType<typeof Deno.upgradeWebSocket>;
    try {
      upgraded = Deno.upgradeWebSocket(nativeRequest, {
        protocol: decision.protocol,
      });
    } catch {
      detach();
      lease?.release();
      decision.cancel("invalid_upgrade");
      return new Response("Invalid WebSocket upgrade", { status: 400 });
    }
    sockets.add(upgraded.socket);
    upgraded.socket.addEventListener(
      "close",
      () => {
        sockets.delete(upgraded.socket);
        lease?.release();
      },
      { once: true },
    );
    try {
      decision.attach(adaptWebSocket(upgraded.socket), decision.protocol);
    } catch {
      try {
        upgraded.socket.close(4400, "connection_rejected");
      } catch {
        // Returning a non-upgrade response leaves the socket uncommitted.
      }
      detach();
      lease?.release();
      decision.cancel("connection_rejected");
      return new Response("WebSocket connection rejected", { status: 400 });
    }
    // Legacy Deno aborts the HTTP signal when a successful upgrade response
    // finishes. The WebSocket close/error events own the upgraded lifetime.
    detach();
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
  const sockets = new Set<WebSocket>();
  let stopping = false;
  const pending = new Set<AbortController>();
  const fetch = createHandler(
    hypervisor,
    options.budget ?? createConnectionBudget(),
    sockets,
    pending,
  );
  const server = Deno.serve(
    { hostname, port, onListen() {} },
    (request, info) => {
      if (stopping) return new Response("Listener shutdown", { status: 503 });
      setClientAddress(request, info.remoteAddr.hostname);
      return fetch(request);
    },
  );
  if (server.addr.transport !== "tcp") {
    throw new TypeError("Hypervisor listener must use a TCP address");
  }
  let closed: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (closed !== undefined) return closed;
    stopping = true;
    for (const controller of pending) controller.abort("Listener shutdown");
    closed = (async () => {
      const closures = [...sockets].map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.addEventListener("close", () => resolve(), { once: true });
            try {
              socket.close(1011, "Listener shutdown");
            } catch {
              resolve();
            }
          }),
      );
      // Allow the selected error close frame to reach peers before Deno's
      // server shutdown sends its own going-away frame. Bound unresponsive peers.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(closures),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 250);
        }),
      ]);
      clearTimeout(timer);
      await server.shutdown().catch(() => undefined);
    })();
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
