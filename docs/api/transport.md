# `jsr:@oxian/oxian-js@0.21.0-rc.3/transport`

Most applications use plain transport declarations through `createWorker` and
`createHypervisor`. This subpath also exposes the advanced runtime socket and
canonical frame/protocol seams.

Exports: `adaptSocketConnection`, `adaptWebSocket`, `connectWorkerWebSocket`,
`createFrameConnection`, `createProtocolTransport`, `expectSocketConnection`,
`isSocketConnection`, `ConnectWorkerWebSocketOptions`, `ConnectionClose`,
`Frame`, `FrameConnection`, `FrameConnectionOptions`, `FrameSendOptions`,
`HypervisorTransport`, `HypervisorWebSocketTransport`, `InProcessTransport`,
`ProtocolTransport`, `ProtocolTransportMessage`, `ProtocolTransportOptions`,
`SocketClose`, `SocketConnection`, `SocketConnectionState`, `SocketMessage`,
`SocketObserver`, `TransportCloseOptions`, `TransportSendOptions`,
`WorkerTransport`, `WorkerWebSocketFactory`, `WorkerWebSocketFactoryContext`,
and `WorkerWebSocketTransport`.

## Declarations

- `InProcessTransport`: `{ type: "in-process", config: { topic, ...limits } }`.
- `HypervisorWebSocketTransport`: host
  `{ type: "websocket", config: { path } }`.
- `WorkerWebSocketTransport`: client
  `{ type: "websocket", config: { url, ... } }`.
- `HypervisorTransport` and `WorkerTransport`: role-specific unions.

These are data records; no construction helper is required.

## Socket adaptation

`SocketConnection` is the callback boundary shared by server-runtime adapters.
It uses `SocketConnectionState`, `SocketMessage`, `SocketClose`, and
`SocketObserver`.

```ts
import {
  adaptSocketConnection,
  adaptWebSocket,
  expectSocketConnection,
  isSocketConnection,
} from "jsr:@oxian/oxian-js@0.21.0-rc.3/transport";
```

`adaptWebSocket(socket)` handles a standards-compatible native WebSocket.
`adaptSocketConnection(value)` preserves an already adapted value.
`isSocketConnection` and `expectSocketConnection` validate custom runtime
adapters.

## Canonical frame connection

`createFrameConnection(connection, options)` converts native callbacks to one
bounded `FrameConnection`. Its `incoming` stream and `send()` use
`Frame =
string | Uint8Array`; `closed` resolves a `ConnectionClose`.

`FrameConnectionOptions` bounds inbound frames/bytes, pending sends, native
buffered amount, and polling. `FrameSendOptions` provides cancellation and the
internal emission-boundary protocol gate.

This is the physical normalization boundary used by both WebSocket and the
addressed in-process event fabric. The package does not promise zero-copy
semantics.

## Protocol transport

`createProtocolTransport(ProtocolTransportOptions)` applies the single v1 codec,
order validator, and bounded decoded queue to any `FrameConnection`. It returns
a `ProtocolTransport` whose `ProtocolTransportMessage` values carry validated
control/data acceptance and wire-byte weight.

`TransportSendOptions` and `TransportCloseOptions` control cancellation and
ordered close. This is an advanced conformance seam; 0.21 ships and documents
only `oxian.worker.v1`.

## Outbound WebSocket acquisition

```ts
import {
  connectWorkerWebSocket,
  type ConnectWorkerWebSocketOptions,
  type WorkerWebSocketFactory,
  type WorkerWebSocketFactoryContext,
} from "jsr:@oxian/oxian-js@0.21.0-rc.3/transport";
```

`connectWorkerWebSocket(options)` validates URL policy, owns the deadline, waits
for Open, and verifies the exact subprotocol. Production uses WSS. Plain WS is
accepted only for explicitly enabled loopback development.

A `WorkerWebSocketFactory` may obtain provider authentication before creating
the native socket; its `WorkerWebSocketFactoryContext` contains the validated
URL, protocol, and deadline signal.
