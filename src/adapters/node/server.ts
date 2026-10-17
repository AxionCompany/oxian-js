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
      const decision = hypervisor.prepare(
        toRequest(request, origin, false, abort.signal),
      );
      if (decision.kind === "response") {
        await reject(socket, await decision.response);
        return;
      }
      cancel = decision.cancel;
      selected.set(request, decision.protocol);
      sockets.handleUpgrade(request, socket, head, (connection) => {
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

  sockets.on("wsClientError", (_error, socket) => {
    socket.end(
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  });

  const finished = Promise.withResolvers<void>();
  server.on("error", (error) => finished.reject(error));
  server.once("close", () => finished.resolve());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new TypeError("Hypervisor listener must use a TCP address");
  }
  origin = listenerUrl(address.address, address.port);

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
    server.close();
    server.closeAllConnections();
    for (const socket of upgraded) socket.destroy();
    closed = Promise.all([
      finished.promise.catch(() => undefined),
      ...upgradeClosures,
    ]).then(() => undefined);
    return closed;
  };
  const listener: HypervisorListener = Object.freeze({
    hostname: address.address,
    port: address.port,
    url: origin,
    finished: finished.promise,
    shutdown,
  });
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
  return new Request(new URL(request.url ?? "/", origin), {
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
