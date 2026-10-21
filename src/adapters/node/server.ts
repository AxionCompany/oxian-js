import { resolveRouteDecision } from "../../http/upgrade-decision.ts";
import {
  acceptedWebSocket,
  ROUTE_WEBSOCKET_LIMITS,
  setClientAddress,
} from "../../http/websocket.ts";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  validateHeaderValue,
} from "node:http";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { WebSocketServer } from "ws";
import {
  createConnectionBudget,
  type ConnectionLease,
} from "./connection-budget.ts";
import { observeListenerSettlement } from "../../hypervisor/internal/listener.ts";
import {
  createHypervisorError,
  listenerUrl,
} from "../../hypervisor/internal/primitives.ts";
import type { HypervisorListener } from "../../hypervisor/types.ts";
import { WORKER_PROTOCOL_LIMITS } from "../../protocol/limits.ts";
import { adaptWebSocket } from "../../transport/socket.ts";
import type { NodeServeOptions } from "./types.ts";

/** Starts a Node listener for an existing application-owned Hypervisor. */
export async function serve(
  options: NodeServeOptions,
): Promise<HypervisorListener> {
  const { hypervisor, hostname = "127.0.0.1", port = 0, signal } = options;
  const budget = options.budget ?? createConnectionBudget();
  if (!hypervisor.snapshot().acceptingConnections) {
    throw createHypervisorError(
      "shutting_down",
      "cannot listen after Hypervisor shutdown begins",
    );
  }
  signal?.throwIfAborted();

  const selected = new WeakMap<IncomingMessage, string>();
  const sockets = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload:
      WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes +
      WORKER_PROTOCOL_LIMITS.maxControlFrameBytes,
    handleProtocols: (offered, request) => {
      const protocol = selected.get(request);
      return protocol !== undefined && offered.has(protocol) ? protocol : false;
    },
  });

  const routeSockets = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: ROUTE_WEBSOCKET_LIMITS.messageBytes,
    handleProtocols: (offered, request) => {
      const protocol = selected.get(request);
      return protocol !== undefined && offered.has(protocol) ? protocol : false;
    },
  });

  // Node does not include upgraded sockets in closeAllConnections(), even
  // before ws accepts them or while an application rejection is still pending.
  const upgraded = new Set<Duplex>();
  let stopping = false;
  let origin = listenerUrl(hostname, port);
  const server = createServer((request, response) => {
    void respond(request, response);
  });

  async function respond(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const lifetime = requestLifetime(request, response);
    try {
      const decision = hypervisor.prepare(
        toRequest(request, origin, true, lifetime.signal),
      );
      if (decision.kind === "upgrade") {
        decision.cancel("upgrade_event_required");
        await send(
          response,
          new Response("WebSocket upgrade required", { status: 400 }),
        );
        return;
      }
      const result = await decision.response;
      if (result.status === 101) {
        acceptedWebSocket(result)?.fail();
        await send(
          response,
          new Response("WebSocket upgrade required", { status: 400 }),
        );
        return;
      }
      if (lifetime.signal.aborted) {
        await result.body?.cancel(lifetime.signal.reason);
        return;
      }
      await send(response, result);
    } catch {
      if (!response.destroyed) {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      }
    } finally {
      lifetime.dispose();
    }
  }

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head) => {
    if (stopping) {
      socket.destroy();
      return;
    }
    upgraded.add(socket);
    socket.once("close", () => upgraded.delete(socket));
    void upgrade(request, socket, head);
  });

  async function upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    if (socket.destroyed) return;
    if (takeConnection(budget, socket) === "refused") {
      await reject(
        socket,
        new Response("connection budget exceeded", { status: 503 }),
      );
      return;
    }
    const abort = new AbortController();
    const disconnected = (): void => abort.abort(disconnectedError());
    socket.once("close", disconnected);
    let cancel: ((reason?: string) => void) | undefined;
    const failed = (): void => cancel?.("upgrade_closed");
    socket.on("error", failed);
    socket.once("close", failed);
    try {
      const prepared = hypervisor.prepare(
        toRequest(request, origin, false, abort.signal),
      );
      const decision = await resolveRouteDecision(prepared);
      if (decision.kind === "response") {
        await reject(socket, await decision.response);
        return;
      }
      if (socket.destroyed || stopping) {
        decision.cancel("upgrade_closed");
        return;
      }
      cancel = decision.cancel;
      selected.set(request, decision.protocol);
      const native = prepared.kind === "upgrade" ? sockets : routeSockets;
      native.handleUpgrade(request, socket, head, (connection) => {
        socket.removeListener("error", failed);
        socket.removeListener("close", failed);
        cancel = undefined;
        try {
          decision.attach(
            adaptWebSocket(connection as unknown as WebSocket),
            decision.protocol,
          );
        } catch {
          decision.cancel("connection_rejected");
          connection.close(4400, "connection_rejected");
        }
      });
    } catch {
      cancel?.("invalid_upgrade");
      socket.destroy();
    } finally {
      socket.removeListener("close", disconnected);
    }
  }

  const badUpgrade = (_error: Error, socket: Duplex) => {
    socket.end(
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  };
  sockets.on("wsClientError", badUpgrade);
  routeSockets.on("wsClientError", badUpgrade);

  const finished = Promise.withResolvers<void>();
  // Startup can fail before a listener is returned and observed by its caller.
  void finished.promise.catch(() => undefined);
  server.on("error", (error) => finished.reject(error));
  server.once("close", () => finished.resolve());

  let closed: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (closed !== undefined) return closed;
    stopping = true;
    const upgradeClosures = [...upgraded].map(
      (socket) =>
        new Promise<void>((resolve) => socket.once("close", () => resolve())),
    );
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    for (const client of routeSockets.clients)
      client.close(1011, "Listener shutdown");
    routeSockets.close();
    const serverClosed = new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    for (const socket of upgraded) socket.destroy();
    closed = Promise.all([serverClosed, ...upgradeClosures]).then(
      () => undefined,
    );
    return closed;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const aborted = (): void =>
        failed(
          signal?.reason ??
            new DOMException("Listener startup aborted", "AbortError"),
        );
      const cleanup = (): void => {
        server.removeListener("error", failed);
        signal?.removeEventListener("abort", aborted);
      };
      const failed = (error: unknown): void => {
        cleanup();
        reject(error);
      };
      server.once("error", failed);
      signal?.addEventListener("abort", aborted, { once: true });
      try {
        signal?.throwIfAborted();
        server.listen({ port, host: hostname, signal }, () => {
          cleanup();
          resolve();
        });
      } catch (error) {
        failed(error);
      }
    });
  } catch (error) {
    await shutdown();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    await shutdown();
    signal?.throwIfAborted();
    throw new TypeError("Hypervisor listener must use a TCP address");
  }
  origin = listenerUrl(address.address, address.port);

  const listener: HypervisorListener = Object.freeze({
    hostname: address.address,
    port: address.port,
    url: origin,
    finished: finished.promise,
    shutdown,
  });
  if (signal?.aborted) {
    await shutdown();
    signal.throwIfAborted();
  }
  observeListenerSettlement({
    finished: finished.promise,
    signal,
    close: shutdown,
    cleanup: () => undefined,
  });
  return listener;
}

function takeConnection(
  budget: NodeServeOptions["budget"],
  socket: Duplex,
): "refused" | undefined {
  if (budget === undefined) return undefined;
  let held: ConnectionLease;
  try {
    held = budget.connect();
  } catch {
    return "refused";
  }
  if (socket.destroyed) held.release();
  else socket.once("close", () => held.release());
  return undefined;
}

function disconnectedError(): DOMException {
  return new DOMException("HTTP client disconnected", "AbortError");
}

/** An ordinary HTTP request ends with its response, not with body EOF. */
function requestLifetime(
  request: IncomingMessage,
  response: ServerResponse,
): Readonly<{
  signal: AbortSignal;
  dispose(): void;
}> {
  const controller = new AbortController();
  const dispose = (): void => {
    request.removeListener("close", requestClosed);
    request.removeListener("error", abort);
    response.removeListener("close", responseClosed);
    response.removeListener("error", abort);
    response.removeListener("finish", dispose);
  };
  const abort = (): void => {
    dispose();
    controller.abort(disconnectedError());
  };
  const requestClosed = (): void => {
    // IncomingMessage close also fires after a normally consumed request body.
    if (!request.complete) abort();
  };
  const responseClosed = (): void => {
    if (!response.writableFinished) abort();
    else dispose();
  };
  request.once("close", requestClosed);
  request.once("error", abort);
  response.once("close", responseClosed);
  response.once("error", abort);
  response.once("finish", dispose);
  if ((request.destroyed && !request.complete) || response.destroyed) abort();
  return { signal: controller.signal, dispose };
}

function toRequest(
  request: IncomingMessage,
  origin: URL,
  withBody: boolean,
  signal: AbortSignal,
): Request {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    headers.append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!);
  }
  const hasBody =
    withBody && request.method !== "GET" && request.method !== "HEAD";
  const host = headers.get("host");
  const url = new URL(request.url ?? "/", origin);
  if (host) {
    url.port = "";
    url.host = host;
  }
  const result = new Request(url, {
    method: request.method,
    headers,
    signal,
    ...(hasBody
      ? {
          body: Readable.toWeb(request) as ReadableStream<Uint8Array>,
          duplex: "half",
        }
      : {}),
  });
  if (request.socket.remoteAddress)
    setClientAddress(result, request.socket.remoteAddress);
  return result;
}

async function send(target: ServerResponse, response: Response): Promise<void> {
  target.writeHead(
    response.status,
    response.statusText || undefined,
    [...response.headers.entries()].flat(),
  );
  if (response.body === null) {
    const completion = finished(target, { cleanup: true });
    target.end();
    await completion;
    return;
  }
  await pipeline(
    Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
    target,
  );
}

async function reject(socket: Duplex, response: Response): Promise<void> {
  if (socket.destroyed) {
    await response.body?.cancel("connection closed");
    return;
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (socket.destroyed) return;
  const headers = new Headers(response.headers);
  // This path closes the socket after one buffered response. Application
  // headers must not override its framing or advertise unsupported trailers.
  headers.set("connection", "close");
  headers.set("content-length", String(body.length));
  headers.delete("keep-alive");
  headers.delete("transfer-encoding");
  headers.delete("trailer");
  const lines: string[] = [];
  for (const [name, value] of headers) {
    if (name === "set-cookie") continue;
    validateHeaderValue(name, value);
    lines.push(`${name}: ${value}\r\n`);
  }
  for (const cookie of headers.getSetCookie()) {
    validateHeaderValue("set-cookie", cookie);
    lines.push(`set-cookie: ${cookie}\r\n`);
  }
  socket.write(
    `HTTP/1.1 ${response.status} ${response.statusText || "Rejected"}\r\n` +
      `${lines.join("")}\r\n`,
    "latin1",
  );
  socket.end(body);
}
