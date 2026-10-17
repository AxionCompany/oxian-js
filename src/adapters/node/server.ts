import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  validateHeaderValue,
} from "node:http";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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

  let origin = listenerUrl(hostname, port);
  const server = createServer((request, response) => {
    void respond(request, response);
  });

  async function respond(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const decision = hypervisor.prepare(toRequest(request, origin, true));
      if (decision.kind === "upgrade") {
        decision.cancel("upgrade_event_required");
        await send(
          response,
          new Response("WebSocket upgrade required", { status: 400 }),
        );
        return;
      }
      await send(response, await decision.response);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  }

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head) => {
    void upgrade(request, socket, head);
  });

  async function upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    if (takeConnection(budget, socket) === "refused") {
      await reject(
        socket,
        new Response("connection budget exceeded", { status: 503 }),
      );
      return;
    }
    let cancel: ((reason?: string) => void) | undefined;
    const failed = (): void => cancel?.("upgrade_closed");
    socket.on("error", failed);
    socket.once("close", failed);
    try {
      const decision = hypervisor.prepare(toRequest(request, origin, false));
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
    }
  }

  sockets.on("wsClientError", (_error, socket) => {
    socket.end(
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  });

  const finished = Promise.withResolvers<void>();
  // Startup can fail before a listener is returned and observed by its caller.
  void finished.promise.catch(() => undefined);
  server.on("error", (error) => finished.reject(error));
  server.once("close", () => finished.resolve());

  let closed: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (closed !== undefined) return closed;
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    closed = new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
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

function toRequest(
  request: IncomingMessage,
  origin: URL,
  withBody: boolean,
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
    target.end();
    return;
  }
  await pipeline(
    Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
    target,
  );
}

async function reject(socket: Duplex, response: Response): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());
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
