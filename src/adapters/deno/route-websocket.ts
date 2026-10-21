// @deno-types="npm:@types/ws@8.18.2"
import { WebSocket as NativeClient } from "ws";
import type { HttpFetchHandler } from "../../http/types.ts";
import { adaptWebSocket } from "../../transport/socket.ts";
import {
  acceptedWebSocket,
  getClientAddress,
  isWebSocketRequest,
  ROUTE_WEBSOCKET_LIMITS,
  setClientAddress,
  upgradeWebSocket,
} from "../../http/websocket.ts";

/** Host a route on a native request while preserving its original public fields. */
export async function hostWebSocket(
  request: Request,
  fetch: HttpFetchHandler,
): Promise<Response> {
  if (!isWebSocketRequest(request)) return await fetch(request);
  request.signal.throwIfAborted();
  const result = Promise.withResolvers<Response>();
  const token = crypto.randomUUID();
  const abort = new AbortController();
  let claimed = false;
  let fetchTask: Promise<Response> | undefined;
  let accepted: ReturnType<typeof upgradeWebSocket> | undefined;
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: abort.signal,
      onListen() {},
    },
    async (nativeRequest) => {
      if (claimed || new URL(nativeRequest.url).pathname !== `/${token}`)
        return new Response(null, { status: 404 });
      claimed = true;
      const key = nativeRequest.headers.get("sec-websocket-key");
      // Retain the native request's upgrade capability. Only its public Fetch
      // fields come from the client; the private loopback URL is never exposed.
      Object.defineProperties(nativeRequest, {
        url: { value: request.url },
        headers: { value: new Headers(request.headers) },
        signal: { value: request.signal },
      });
      const address = getClientAddress(request);
      if (address) setClientAddress(nativeRequest, address);
      try {
        fetchTask = Promise.resolve().then(() => fetch(nativeRequest));
        const response = await fetchTask;
        if (response.status !== 101 || acceptedWebSocket(response)) {
          result.resolve(response);
          return new Response(null, { status: 204 });
        }
        const protocol = response.headers.get("sec-websocket-protocol") ?? "";
        accepted = upgradeWebSocket(request, { protocol });
        acceptedWebSocket(accepted.response)!.attach(
          adaptWebSocket(client as unknown as WebSocket),
        );
        // The internal native handshake has its own key. The external adapter
        // generates the external response only after this route has accepted.
        const digest = await crypto.subtle.digest(
          "SHA-1",
          new TextEncoder().encode(
            `${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
          ),
        );
        response.headers.set(
          "sec-websocket-accept",
          btoa(String.fromCharCode(...new Uint8Array(digest))),
        );
        return response;
      } catch (error) {
        result.reject(error);
        return new Response(null, { status: 500 });
      }
    },
  );
  const protocols =
    request.headers
      .get("sec-websocket-protocol")
      ?.split(",")
      .map((value) => value.trim()) ?? [];
  const client = new NativeClient(
    `ws://127.0.0.1:${server.addr.port}/${token}`,
    protocols,
    {
      perMessageDeflate: false,
      maxPayload: ROUTE_WEBSOCKET_LIMITS.messageBytes,
    },
  );
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const stopped = Promise.withResolvers<void>();
  const stop = () => {
    if (client.readyState === NativeClient.CLOSED || closeTimer !== undefined)
      return;
    // A graceful private close also releases native server idle timers. Never
    // strand a live TCP connection if the route does not answer the handshake.
    closeTimer = setTimeout(() => {
      client.terminate();
      abort.abort();
    }, 250);
    client.close(1000, "Workload ended");
  };
  request.signal.addEventListener("abort", stop, { once: true });
  const cleanup = () => {
    request.signal.removeEventListener("abort", stop);
    clearTimeout(closeTimer);
    abort.abort();
    void server.finished.then(stopped.resolve, stopped.resolve);
  };
  client.once("open", () => {
    if (accepted) result.resolve(accepted.response);
    else result.reject(new Error("Native route did not accept"));
  });
  client.once("unexpected-response", (_request, response) => {
    response.resume();
    stop();
  });
  client.on("error", (error) => {
    if ("code" in error && error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") {
      if (accepted)
        acceptedWebSocket(accepted.response)!.fail(
          1009,
          "Route message too large",
        );
    }
    result.reject(error);
  });
  client.once("close", () => {
    cleanup();
    result.reject(new Error("Native route closed before acceptance"));
  });
  void server.finished.catch(() => undefined);
  try {
    const response = await result.promise;
    request.signal.throwIfAborted();
    if (!accepted) {
      stop();
      await stopped.promise;
    }
    return response;
  } catch (error) {
    if (accepted) acceptedWebSocket(accepted.response)!.fail();
    stop();
    // Cancelling the private handshake cannot release a worker execution while
    // an application handler that ignores cancellation is still running.
    await stopped.promise;
    await fetchTask?.catch(() => undefined);
    throw error;
  }
}
