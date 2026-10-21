import { serve } from "../../src/adapters/node/server.ts";
import { routeWebSocketCases } from "./route_websocket_cases.ts";
routeWebSocketCases("Node", serve);
