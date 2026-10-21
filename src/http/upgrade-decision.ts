import type { HypervisorRequestDecision } from "../hypervisor/types.ts";
import { acceptedWebSocket } from "./websocket.ts";

/** Await route admission before any native handshake is committed. */
export async function resolveRouteDecision(
  decision: HypervisorRequestDecision,
): Promise<HypervisorRequestDecision> {
  if (decision.kind === "upgrade") return decision;
  const response = await decision.response;
  const socket = acceptedWebSocket(response);
  if (!socket) return { kind: "response", response };
  if (socket.readyState >= 2)
    return {
      kind: "response",
      response: new Response("WebSocket route unavailable", { status: 503 }),
    };
  return {
    kind: "upgrade",
    protocol: socket.protocol,
    attach: (connection) => socket.attach(connection, socket.nativeRole),
    cancel: () => socket.fail(),
  };
}
