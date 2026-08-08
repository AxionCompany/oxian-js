# `jsr:@oxian/oxian-js@0.20.0-rc.7/transport`

[Back to the API reference](../api-reference.md)

The `/transport` subpath opens outbound worker sockets and wraps one negotiated
wire connection in the strict `oxian.worker.v1` protocol. The wrapper owns frame
encoding, protocol order, bounded receive and send admission, `bufferedAmount`
backpressure, and connection closure. Runtime server adapters can provide a
callback-native connection without implementing DOM events.

```ts
import {
  connectWorkerWebSocket,
  createWebSocketTransport,
  createWebSocketWireConnection,
  type WorkerWireConnection,
} from "jsr:@oxian/oxian-js@0.20.0-rc.7/transport";
```

## Export summary

### Values

| Export                          | Purpose                                                  |
| ------------------------------- | -------------------------------------------------------- |
| `connectWorkerWebSocket`        | Open and verify an outbound worker WebSocket.            |
| `createWebSocketWireConnection` | Adapt a standards-compatible WebSocket to the wire seam. |
| `isWorkerWireConnection`        | Test whether a value structurally implements the seam.   |
| `expectWorkerWireConnection`    | Validate a wire connection or throw `TypeError`.         |
| `toWorkerWireConnection`        | Preserve a wire connection or adapt a native WebSocket.  |
| `createWebSocketTransport`      | Apply framing, ordering, queues, and backpressure.       |

### Types

| Export                          | Purpose                                                   |
| ------------------------------- | --------------------------------------------------------- |
| `TransportSendOptions`          | Per-send cancellation.                                    |
| `TransportCloseOptions`         | Public close code, reason, and timeout.                   |
| `WebSocketTransportClose`       | Final observed or synthesized close details.              |
| `WebSocketTransportMessage`     | Validated inbound control or data message.                |
| `WorkerWireConnectionState`     | Runtime-neutral connecting/open/closing/closed state.     |
| `WorkerWireMessageData`         | Text or binary value delivered by a wire adapter.         |
| `WorkerWireClose`               | Runtime-neutral close code, reason, and cleanliness.      |
| `WorkerWireObserver`            | Optional callbacks for one connection subscription.       |
| `WorkerWireConnection`          | Callback-based server/runtime connection boundary.        |
| `WebSocketTransportOptions`     | Socket, role, queue, backpressure, and protocol settings. |
| `WebSocketTransport`            | Ordered transport API.                                    |
| `WorkerWebSocketFactoryContext` | Validated provider socket-construction input.             |
| `WorkerWebSocketFactory`        | Provider-owned authenticated socket factory.              |
| `ConnectWorkerWebSocketOptions` | Outbound endpoint and connection settings.                |

## Runtime-neutral wire connection

```ts
type WorkerWireConnectionState =
  | "connecting"
  | "open"
  | "closing"
  | "closed";

type WorkerWireMessageData =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | Blob;

type WorkerWireClose = Readonly<{
  code: number;
  reason: string;
  wasClean: boolean;
}>;

type WorkerWireObserver = Readonly<{
  open?(): void;
  message?(data: WorkerWireMessageData): void;
  close?(event: WorkerWireClose): void;
  error?(error?: unknown): void;
}>;

type WorkerWireConnection = Readonly<{
  readonly protocol: string;
  readonly state: WorkerWireConnectionState;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  subscribe(observer: WorkerWireObserver): () => void;
}>;
```

The connection deliberately does not extend `EventTarget`. A runtime adapter can
bridge DOM WebSockets, server-level callbacks, WebSocket pairs, or a
library-specific upgrade object by exposing current state, send pressure, and
one callback subscription. `subscribe()` returns an idempotent unsubscriber;
callbacks may be delivered synchronously, so an adapter should expose its
current state accurately before and after subscription.

The helper functions are:

```ts
function createWebSocketWireConnection(
  socket: WebSocket,
): WorkerWireConnection;

function isWorkerWireConnection(
  value: unknown,
): value is WorkerWireConnection;

function expectWorkerWireConnection(value: unknown): WorkerWireConnection;

function toWorkerWireConnection(
  value: WebSocket | WorkerWireConnection,
): WorkerWireConnection;
```

`createWebSocketWireConnection` configures binary delivery as `ArrayBuffer` and
translates native open, message, close, and error events. The structural helpers
let server adapters validate their bridge while preserving native client
WebSocket compatibility.

## Outbound worker connection

### Factory types

```ts
type WorkerWebSocketFactoryContext = Readonly<{
  url: URL;
  protocol: string;
  signal: AbortSignal;
}>;

type WorkerWebSocketFactory = (
  context: WorkerWebSocketFactoryContext,
) => WebSocket | Promise<WebSocket>;

type ConnectWorkerWebSocketOptions = Readonly<{
  url: string | URL;
  signal?: AbortSignal;
  timeoutMs?: number;
  createWebSocket?: WorkerWebSocketFactory;
  allowInsecureLoopback?: boolean;
}>;
```

The factory hook exists for provider-owned authentication. It receives a fresh
copy of the already validated URL, the exact `oxian.worker.v1` subprotocol, and
a signal combining caller cancellation with the connection deadline.

```ts
const createWebSocket: WorkerWebSocketFactory = async (
  { url, protocol, signal },
) => {
  const token = await obtainProviderToken({ signal });
  return createSocketWithHeaders(url, protocol, {
    authorization: `Bearer ${token}`,
  });
};
```

The hook owns only authentication and socket construction. Oxian owns the
deadline, waits for Open, configures binary delivery, verifies the selected
subprotocol, and closes the returned socket on failure. If an asynchronous
factory ignores its signal and resolves after the deadline, Oxian immediately
closes that orphaned socket.

### `connectWorkerWebSocket`

```ts
function connectWorkerWebSocket(
  options: ConnectWorkerWebSocketOptions,
): Promise<WebSocket>;
```

Production URLs must use `wss:`. Plain `ws:` is accepted only when
`allowInsecureLoopback` is exactly `true` and the hostname is `localhost`,
`127.0.0.1`, or IPv6 loopback. Embedded username/password, query strings, and
fragments are rejected before the custom factory runs.

`timeoutMs` defaults to 15 seconds and must be a positive safe integer. The
function:

1. validates the endpoint;
2. creates the socket through the custom or native factory;
3. sets `binaryType = "arraybuffer"`;
4. waits for Open, error, close, abort, or deadline; and
5. requires `socket.protocol === "oxian.worker.v1"`.

It resolves with an open socket. Invalid URLs, malformed factory results,
connection errors, deadlines, cancellation, premature close, or missing exact
subprotocol reject and close the socket.

## WebSocket transport types

```ts
type TransportSendOptions = Readonly<{
  signal?: AbortSignal;
}>;

type TransportCloseOptions = Readonly<{
  code?: number;
  reason?: string;
  timeoutMs?: number;
}>;

type WebSocketTransportClose = Readonly<{
  code: number;
  reason: string;
  wasClean: boolean;
}>;
```

A public close code must be `1000` or an integer from `3000` through `4999`. The
reason cannot exceed 123 UTF-8 bytes. Close timeout defaults to 5 seconds and
must be a positive safe integer.

```ts
type WebSocketTransportMessage =
  | Readonly<{
    kind: "control";
    acceptance: ProtocolFrameAcceptance<ControlFrame>;
    wireBytes: number;
  }>
  | Readonly<{
    kind: "data";
    acceptance: ProtocolFrameAcceptance<WorkDataFrame>;
    wireBytes: number;
  }>;
```

`acceptance.frame` is strictly decoded and has already advanced the
connection-local order validator. A `discard` disposition means a valid crossed
inbound work frame arrived after local abort and must not reach workload code.
`wireBytes` is the original WebSocket message size used for queue accounting.

## `WebSocketTransportOptions`

```ts
type WebSocketTransportOptions = Readonly<{
  socket: WebSocket | WorkerWireConnection;
  role: ProtocolRole;
  negotiatedProtocol?: string;
  signal?: AbortSignal;
  maxInboundMessages?: number;
  maxInboundBytes?: number;
  maxPendingSendMessages?: number;
  maxPendingSendBytes?: number;
  maxBufferedAmountBytes?: number;
  bufferedAmountLowWaterBytes?: number;
  bufferedAmountPollMs?: number;
  protocol?: Omit<ProtocolOrderValidatorOptions, "role">;
}>;
```

Defaults are per connection:

| Option                        | Default |
| ----------------------------- | ------- |
| `maxInboundMessages`          | 64      |
| `maxInboundBytes`             | 4 MiB   |
| `maxPendingSendMessages`      | 64      |
| `maxPendingSendBytes`         | 32 MiB  |
| `maxBufferedAmountBytes`      | 2 MiB   |
| `bufferedAmountLowWaterBytes` | 512 KiB |
| `bufferedAmountPollMs`        | 4 ms    |

All numeric options must be positive safe integers. The low-water mark must be
strictly less than the maximum buffered amount. The maximum buffered amount must
fit one maximum configured data payload plus the 28-byte binary header.

`role` is `"worker"` or `"hypervisor"` and determines legal frame direction.
`protocol` can make capacity, lifetime stream, payload, or receive-credit
admission stricter than the v1 hard limits.

Most WebSocket clients expose the negotiated value as `socket.protocol`. Server
adapters whose wire connection does not expose it may pass `negotiatedProtocol`.
If both values exist, they must agree exactly.

## `createWebSocketTransport`

```ts
function createWebSocketTransport(
  options: WebSocketTransportOptions,
): Promise<WebSocketTransport>;
```

The function accepts an open native WebSocket or `WorkerWireConnection`, or
waits for a connecting one to open. It rejects closed connections, an
already-aborted signal, invalid options, or any subprotocol other than
`oxian.worker.v1`. Native WebSockets are adapted with binary delivery set to
`arraybuffer`; the returned transport is frozen.

```ts
const socket = await connectWorkerWebSocket({
  url: "wss://gateway.example.com/_oxian/workers/connect",
});

const transport = await createWebSocketTransport({
  socket,
  role: "worker",
});
```

Inbound messages are processed in WebSocket event order, including asynchronous
`Blob` decoding. Text is parsed as a strict control frame; binary data is
decoded with the fixed Oxian header. Empty, unsupported, malformed,
out-of-order, or over-admission messages are protocol failures. The transport
best-effort sends a bounded `protocol_error`, closes with code `4400` and a
stable violation code, discards queued inbound values, and rejects the message
iterator. Ordinary socket failures use synthesized close code `4500`.

## `WebSocketTransport`

```ts
type WebSocketTransport = Readonly<{
  sendControl(
    frame: ControlFrame,
    options?: TransportSendOptions,
  ): Promise<ProtocolFrameAcceptance<ControlFrame>>;
  sendData(
    frame: WorkDataFrame,
    options?: TransportSendOptions,
  ): Promise<ProtocolFrameAcceptance<WorkDataFrame>>;
  messages(): AsyncIterable<WebSocketTransportMessage>;
  snapshot(): ProtocolStateSnapshot;
  close(options?: TransportCloseOptions): Promise<void>;
  readonly closed: Promise<WebSocketTransportClose>;
}>;
```

### Sending

`sendControl` and `sendData` validate and encode before joining one serialized
send queue. Admission counts both queued message count and encoded bytes.
Exceeding either pending bound rejects with `RangeError`.

Before `socket.send`, the queue waits until native `bufferedAmount` can fit the
whole message. Once throttled, it waits for the low-water threshold to avoid
oscillation. A per-send signal cancels that queued/backpressured send; the
transport-level signal cancels the whole connection.

Protocol state advances immediately before the native send. If `socket.send`
then throws, the transport is poisoned and closed rather than rolling state
back. This preserves a deterministic ordering boundary for all later callers.

The returned acceptance is the validator's canonical frame and disposition.
Never bypass these methods with direct `socket.send` after wrapping a socket.

### Receiving

`messages()` returns the bounded async iterable and may be claimed exactly once.
A second call throws `TypeError`. Normal peer close lets every message event
observed before Close finish decoding and drain through the iterable before it
ends.

A fatal protocol, transport, or abort close rejects the iterable and discards
retained values. Consumers should run one `for await` loop for the complete
transport lifetime.

### State and closure

`snapshot()` returns the current `ProtocolStateSnapshot`, including handshake
phase, identity, capacity, active streams, sequences, and credit.

`closed` always resolves with the peer close event or a synthesized local close.
It is the authoritative transport-termination notification.

`close()` is idempotent after terminal settlement. Defaults are code `1000`,
reason `transport_closed`, and a 5-second wait. It starts the WebSocket close
handshake and resolves on the peer close event or the timeout; timeout produces
`wasClean: false`. Invalid public close options throw before closing.
