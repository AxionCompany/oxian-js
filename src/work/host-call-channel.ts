import {
  createWorkOpenFrame,
  isProtocolViolation,
  type ControlFrame,
  type JsonObject,
  type WorkDataFrame,
  type WorkOpenFrame,
  WORKER_PROTOCOL,
  WORKER_PROTOCOL_LIMITS,
} from "../protocol/index.ts";
import type { ProtocolTransport } from "../transport/types.ts";
import { normalizeHandlerResult } from "../worker/internal/work.ts";
import type { WorkerWorkResult } from "../worker/types.ts";
import {
  createHostCallError,
  type HostCallError,
  type HostCallErrorCode,
  type HostCallHandle,
  type HostCallInput,
} from "./host-call.ts";
import type { WorkBody } from "./types.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export type HostCallExecution = Readonly<{
  input: ReadableStream<Uint8Array>;
  signal: AbortSignal;
}>;
export type HostCallHandler = (
  context: HostCallExecution,
) => WorkerWorkResult | Promise<WorkerWorkResult>;
export type HostCallReservation = Readonly<{
  /** No effects here. Execution starts only after the peer's work.start. */
  admit(): HostCallHandler | undefined | Promise<HostCallHandler | undefined>;
  /** Rechecks the current session and parent immediately before handler entry. */
  current(): boolean;
  release(): void;
}>;

type Stream = {
  open: WorkOpenFrame;
  initiator: boolean;
  deadlineAtMs: number;
  started: boolean;
  possibleExecution: boolean;
  local?: "end" | "abort";
  remote?: "end" | "abort";
  metadataSent: boolean;
  metadataReceived: boolean;
  abort: AbortController;
  input: ReadableStream<Uint8Array>;
  controller: ReadableStreamDefaultController<Uint8Array>;
  inputClosed: boolean;
  receiveCredit: number;
  granting: boolean;
  grantStopped: boolean;
  sendCredit: number;
  sequence: number;
  waiters: Set<() => void>;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  body?: WorkBody;
  pumping: boolean;
  cleanupPending: boolean;
  outgoingReservation?: { release(): void };
  cancellation?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  ackTimer?: ReturnType<typeof setTimeout>;
  dispose?: () => void;
  startedResult: Deferred<void>;
  metadata: Deferred<JsonObject>;
  completed: Deferred<void>;
  reservation?: HostCallReservation;
  admissionPending: boolean;
  handler?: HostCallHandler;
  executing: boolean;
};

/** Same v1 stream framing and credit discipline, with the worker as initiator. */
export function createHostCallChannel(
  options: Readonly<{
    role: "worker" | "hypervisor";
    transport: ProtocolTransport;
    signal: AbortSignal;
    capacity: number;
    timeoutMs: number;
    cancellationAckTimeoutMs?: number;
    windowBytes?: number;
    maxDataPayloadBytes?: number;
    now?: () => number;
    accept?: (
      open: WorkOpenFrame,
      signal: AbortSignal,
    ) => HostCallReservation | undefined;
    onIdle?: () => void;
    reserveOutgoing?: () => { release(): void } | undefined;
  }>,
) {
  const streams = new Map<string, Stream>();
  // Bounded by the connection's negotiated protocol lifetime, like its tombstones.
  const used = new Set<string>();
  const now = options.now ?? Date.now;
  const maxDataPayloadBytes = Math.min(
    options.maxDataPayloadBytes ?? WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes,
    WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes,
  );
  const windowBytes = Math.min(
    options.windowBytes ?? 256 * 1024,
    maxDataPayloadBytes,
    WORKER_PROTOCOL_LIMITS.maxOutstandingStreamCreditBytes,
  );
  let closed = false;

  const failConnection = (): void => {
    void options.transport
      .close({ code: 4500, reason: "host_call_stream_failed", timeoutMs: 1000 })
      .catch(() => undefined);
  };
  const send = async (frame: ControlFrame): Promise<void> => {
    await options.transport.sendControl(frame);
  };
  const wake = (stream: Stream): void => {
    for (const callback of stream.waiters) callback();
    stream.waiters.clear();
  };
  const errorFor = (stream: Stream, code: HostCallErrorCode): HostCallError =>
    createHostCallError(
      code,
      stream.possibleExecution ? "indeterminate" : "not_started",
    );
  const closeInput = (stream: Stream, error?: unknown): void => {
    if (stream.inputClosed) return;
    stream.inputClosed = true;
    try {
      if (error === undefined) stream.controller.close();
      else stream.controller.error(error);
    } catch {
      /* Consumer cancellation already closed the input. */
    }
  };
  const releaseOutgoing = (stream: Stream): void => {
    if (
      streams.has(stream.open.streamId) ||
      stream.pumping ||
      stream.cleanupPending
    )
      return;
    stream.outgoingReservation?.release();
    stream.outgoingReservation = undefined;
  };
  const release = (stream: Stream): void => {
    if (stream.admissionPending || stream.executing) return;
    stream.reservation?.release();
    stream.reservation = undefined;
  };
  const settle = (stream: Stream, error?: HostCallError): void => {
    if (error) {
      stream.startedResult.reject(error);
      stream.metadata.reject(error);
      stream.completed.reject(error);
      closeInput(stream, error);
    } else {
      stream.completed.resolve(undefined);
    }
  };
  const finish = (stream: Stream): void => {
    if (
      stream.local === undefined ||
      stream.remote === undefined ||
      stream.local !== stream.remote
    )
      return;
    clearTimeout(stream.timer);
    clearTimeout(stream.ackTimer);
    stream.dispose?.();
    streams.delete(stream.open.streamId);
    wake(stream);
    if (stream.local === "end") settle(stream);
    release(stream);
    releaseOutgoing(stream);
    options.onIdle?.();
  };
  const cancelSource = (stream: Stream, error: unknown): Promise<void> => {
    if (stream.cancellation) return stream.cancellation;
    stream.cleanupPending = true;
    let task: Promise<void>;
    try {
      task = stream.reader
        ? stream.reader.cancel(error)
        : stream.body instanceof ReadableStream
          ? stream.body.cancel(error)
          : Promise.resolve();
    } catch {
      task = Promise.resolve();
    }
    stream.cancellation = task
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        stream.cleanupPending = false;
        stream.body = undefined;
        releaseOutgoing(stream);
      });
    return stream.cancellation;
  };
  const abort = (
    stream: Stream,
    code: HostCallErrorCode,
    notify = true,
  ): void => {
    const error = errorFor(stream, code);
    stream.abort.abort(error);
    settle(stream, error);
    wake(stream);
    void cancelSource(stream, error);
    if (notify && !closed && stream.local !== "abort") {
      stream.local = "abort";
      void send({
        protocol: WORKER_PROTOCOL,
        type: "work.error",
        streamId: stream.open.streamId,
        code,
        message: code,
      }).catch(failConnection);
      stream.ackTimer ??= setTimeout(
        failConnection,
        options.cancellationAckTimeoutMs ?? 1000,
      );
    }
    release(stream);
    finish(stream);
  };
  const grant = (stream: Stream): void => {
    if (
      stream.granting ||
      stream.grantStopped ||
      !stream.started ||
      stream.remote !== undefined ||
      stream.inputClosed ||
      stream.abort.signal.aborted ||
      closed
    )
      return;
    const bytes =
      Math.floor(Math.max(0, stream.controller.desiredSize ?? 0)) -
      stream.receiveCredit;
    if (bytes <= 0) return;
    stream.receiveCredit += bytes;
    stream.granting = true;
    void send({
      protocol: WORKER_PROTOCOL,
      type: "work.credit",
      streamId: stream.open.streamId,
      bytes,
    })
      .catch((error) => {
        if (
          isProtocolViolation(error) &&
          (error.code === "post_terminal_frame" ||
            error.code === "unknown_stream")
        ) {
          // The transport can observe the peer's End before this queued grant.
          // Do not discard already-queued data or fail unrelated multiplexed calls.
          stream.grantStopped = true;
        } else failConnection();
      })
      .finally(() => {
        stream.granting = false;
        grant(stream);
      });
  };
  const create = (open: WorkOpenFrame, initiator: boolean): Stream => {
    // Assigned after ReadableStream.start captures its controller.
    // deno-lint-ignore prefer-const
    let stream!: Stream;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value;
        },
        pull() {
          if (stream) grant(stream);
        },
        cancel() {
          if (stream) {
            if (initiator) abort(stream, "cancelled");
            else stream.inputClosed = true;
          }
        },
      },
      { highWaterMark: windowBytes, size: (chunk) => chunk.byteLength },
    );
    stream = {
      open,
      initiator,
      deadlineAtMs: Math.min(
        open.deadlineAtMs ?? now() + options.timeoutMs,
        now() + options.timeoutMs,
      ),
      started: false,
      possibleExecution: false,
      metadataSent: false,
      metadataReceived: false,
      abort: new AbortController(),
      input,
      controller,
      inputClosed: false,
      receiveCredit: 0,
      granting: false,
      grantStopped: false,
      sendCredit: 0,
      sequence: 0,
      waiters: new Set(),
      startedResult: deferred(),
      metadata: deferred(),
      completed: deferred(),
      admissionPending: false,
      executing: false,
      pumping: false,
      cleanupPending: false,
    };
    used.add(open.streamId);
    streams.set(open.streamId, stream);
    const remaining = Math.min(
      options.timeoutMs,
      (open.deadlineAtMs ?? now() + options.timeoutMs) - now(),
    );
    stream.timer = setTimeout(
      () => abort(stream, "deadline_exceeded"),
      Math.max(0, remaining),
    );
    return stream;
  };
  const waitCredit = async (stream: Stream): Promise<void> => {
    while (
      stream.sendCredit < 1 &&
      !stream.abort.signal.aborted &&
      !closed &&
      stream.local === undefined
    ) {
      await new Promise<void>((resolve) => stream.waiters.add(resolve));
    }
    if (stream.abort.signal.aborted || closed || stream.local !== undefined)
      throw errorFor(stream, "cancelled");
  };
  const pump = async (stream: Stream, body?: WorkBody): Promise<void> => {
    stream.pumping = true;
    stream.body = body;
    const source = body instanceof ReadableStream ? body : undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      reader = source?.getReader();
      stream.reader = reader;
      let direct = body instanceof Uint8Array ? body : undefined;
      while (
        !stream.abort.signal.aborted &&
        !closed &&
        stream.local === undefined
      ) {
        const item = reader
          ? await reader.read()
          : { done: direct === undefined, value: direct };
        direct = undefined;
        if (item.done) break;
        if (!(item.value instanceof Uint8Array))
          throw new TypeError("call body chunks must be bytes");
        if (
          reader &&
          item.value.byteLength > WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes
        )
          throw new RangeError("call body chunk exceeds wire bound");
        let offset = 0;
        while (offset < item.value.byteLength) {
          await waitCredit(stream);
          if (
            stream.local !== undefined ||
            stream.abort.signal.aborted ||
            closed
          )
            return;
          const count = Math.min(
            item.value.byteLength - offset,
            stream.sendCredit,
            maxDataPayloadBytes,
          );
          const payload = item.value.slice(offset, offset + count);
          stream.sendCredit -= count;
          await options.transport.sendData({
            type: "work.data",
            streamId: stream.open.streamId,
            sequence: stream.sequence++,
            payload,
          });
          offset += count;
        }
      }
      if (stream.abort.signal.aborted || closed || stream.local !== undefined)
        return;
      stream.local = "end";
      await send({
        protocol: WORKER_PROTOCOL,
        type: "work.end",
        streamId: stream.open.streamId,
      });
      finish(stream);
    } catch (error) {
      if (stream.local !== "end" || stream.abort.signal.aborted)
        abort(stream, "handler_failed");
      await cancelSource(stream, error);
      if (stream.local !== "end" || stream.abort.signal.aborted) throw error;
    } finally {
      if (stream.abort.signal.aborted)
        await cancelSource(stream, stream.abort.signal.reason);
      if (stream.cancellation) await stream.cancellation;
      reader?.releaseLock();
      stream.reader = undefined;
      stream.body = undefined;
      stream.pumping = false;
      releaseOutgoing(stream);
    }
  };
  const runHandler = (stream: Stream): void => {
    if (!stream.handler || stream.executing || stream.abort.signal.aborted)
      return;
    if (now() >= stream.deadlineAtMs) {
      abort(stream, "deadline_exceeded");
      return;
    }
    if (!stream.reservation?.current()) {
      abort(stream, "refused");
      return;
    }
    stream.executing = true;
    stream.possibleExecution = true;
    void (async () => {
      try {
        const raw = await stream.handler!({
          input: stream.input,
          signal: stream.abort.signal,
        });
        // Own an ordinary returned body before validation can reject another field.
        // Do not execute arbitrary getters merely to discover cleanup resources.
        const owned =
          raw instanceof ReadableStream || raw instanceof Uint8Array
            ? raw
            : raw && typeof raw === "object"
              ? Object.getOwnPropertyDescriptor(raw, "body")?.value
              : undefined;
        if (owned instanceof ReadableStream || owned instanceof Uint8Array) {
          stream.body = owned;
          // Cancellation while awaiting the handler had no returned source yet.
          stream.cancellation = undefined;
        }
        const result = normalizeHandlerResult(raw);
        stream.body = result.body;
        if (stream.abort.signal.aborted || closed) {
          await cancelSource(stream, stream.abort.signal.reason);
          return;
        }
        stream.metadataSent = true;
        await send({
          protocol: WORKER_PROTOCOL,
          type: "work.metadata",
          streamId: stream.open.streamId,
          metadata: result.metadata ?? {},
        });
        await pump(stream, result.body);
      } catch {
        abort(stream, "handler_failed");
      } finally {
        if (stream.cancellation) await stream.cancellation;
        stream.executing = false;
        release(stream);
      }
    })();
  };
  const accept = (open: WorkOpenFrame): void => {
    const stream = create(open, false);
    try {
      stream.reservation = options.accept?.(open, stream.abort.signal);
    } catch {
      /* A refused route is not an application exception on the wire. */
    }
    if (!stream.reservation) {
      abort(stream, "refused");
      return;
    }
    stream.admissionPending = true;
    void (async () => {
      try {
        const handler = await stream.reservation!.admit();
        if (stream.abort.signal.aborted || closed) return;
        if (now() >= stream.deadlineAtMs) {
          abort(stream, "deadline_exceeded");
          return;
        }
        if (!handler || !stream.reservation!.current()) {
          abort(stream, "refused");
          return;
        }
        stream.handler = handler;
        await send({
          protocol: WORKER_PROTOCOL,
          type: "work.accepted",
          streamId: open.streamId,
        });
      } catch {
        abort(stream, "refused");
      } finally {
        stream.admissionPending = false;
        if (stream.abort.signal.aborted || closed) release(stream);
      }
    })();
  };

  // The public asynchronous contract also turns synchronous admission failures into rejections.
  // deno-lint-ignore require-await
  const call = async (
    input: HostCallInput,
    parentStreamId?: string,
  ): Promise<HostCallHandle> => {
    if (options.role !== "worker" || closed || options.signal.aborted)
      throw createHostCallError("unavailable", "not_started");
    if (streams.size >= options.capacity)
      throw createHostCallError("capacity", "not_started");
    if (input.signal?.aborted)
      throw createHostCallError("cancelled", "not_started");
    if (
      input.body !== undefined &&
      !(input.body instanceof Uint8Array) &&
      !(input.body instanceof ReadableStream)
    )
      throw new TypeError("call body must be bytes or a byte stream");
    if (input.body instanceof ReadableStream && input.body.locked)
      throw new TypeError("call body is already locked");
    const deadlineAtMs = Math.min(
      input.deadlineAtMs ?? now() + options.timeoutMs,
      now() + options.timeoutMs,
    );
    if (deadlineAtMs <= now())
      throw createHostCallError("deadline_exceeded", "not_started");
    const open = createWorkOpenFrame({
      streamId: crypto.randomUUID(),
      workload: input.workload,
      metadata: input.metadata ?? {},
      deadlineAtMs,
      ...(parentStreamId === undefined ? {} : { parentStreamId }),
    });
    const reservation = options.reserveOutgoing?.();
    if (options.reserveOutgoing && !reservation)
      throw createHostCallError("capacity", "not_started");
    const stream = create(open, true);
    stream.outgoingReservation = reservation;
    stream.body = input.body;
    const cancel = (): void => abort(stream, "cancelled");
    input.signal?.addEventListener("abort", cancel, { once: true });
    stream.dispose = () => {
      input.signal?.removeEventListener("abort", cancel);
    };
    void send(open).catch(failConnection);
    return Object.freeze({
      streamId: open.streamId,
      output: stream.input,
      metadata: stream.metadata.promise,
      started: stream.startedResult.promise,
      completed: stream.completed.promise,
      cancel: () => {
        abort(stream, "cancelled");
        return Promise.resolve();
      },
    });
  };
  const control = (
    frame: ControlFrame,
    disposition: "deliver" | "discard",
  ): boolean => {
    if (frame.type === "work.open" && options.role === "hypervisor") {
      accept(frame);
      return true;
    }
    if (!("streamId" in frame) || !used.has(frame.streamId)) return false;
    const stream = streams.get(frame.streamId);
    if (!stream) {
      if (
        (frame.type === "work.error" || frame.type === "work.cancel") &&
        disposition === "discard"
      ) {
        void send({
          protocol: WORKER_PROTOCOL,
          type: "work.cancel",
          streamId: frame.streamId,
          reason: "late_abort_ack",
        }).catch(failConnection);
      }
      return true;
    }
    if (frame.type === "work.error" || frame.type === "work.cancel") {
      stream.remote = "abort";
      abort(stream, frame.type === "work.cancel" ? "cancelled" : "refused");
      return true;
    }
    if (disposition === "discard") return true;
    switch (frame.type) {
      case "work.accepted":
        if (stream.abort.signal.aborted) return true;
        if (now() >= stream.deadlineAtMs) {
          abort(stream, "deadline_exceeded");
          return true;
        }
        // The start can reach the host even when its send promise fails.
        stream.possibleExecution = true;
        stream.started = true;
        void send({
          protocol: WORKER_PROTOCOL,
          type: "work.start",
          streamId: frame.streamId,
        }).then(
          () => {
            stream.startedResult.resolve(undefined);
            grant(stream);
            if (!stream.abort.signal.aborted && !closed)
              void pump(stream, stream.body).catch(() =>
                abort(stream, "handler_failed"),
              );
          },
          (error) => {
            if (
              isProtocolViolation(error) &&
              (error.code === "post_terminal_frame" ||
                error.code === "unknown_stream")
            )
              abort(stream, "cancelled");
            else failConnection();
          },
        );
        break;
      case "work.start":
        stream.started = true;
        stream.startedResult.resolve(undefined);
        grant(stream);
        runHandler(stream);
        break;
      case "work.metadata":
        stream.metadataReceived = true;
        stream.metadata.resolve(frame.metadata);
        break;
      case "work.credit":
        stream.sendCredit += frame.bytes;
        wake(stream);
        break;
      case "work.end":
        stream.remote = "end";
        closeInput(stream);
        if (stream.initiator && stream.local === undefined) {
          stream.local = "end";
          wake(stream);
          void cancelSource(stream, "response_complete");
          void send({
            protocol: WORKER_PROTOCOL,
            type: "work.end",
            streamId: frame.streamId,
          }).then(() => finish(stream), failConnection);
        } else finish(stream);
        break;
    }
    return true;
  };
  const data = (
    frame: WorkDataFrame,
    disposition: "deliver" | "discard",
  ): boolean => {
    if (!used.has(frame.streamId)) return false;
    const stream = streams.get(frame.streamId);
    if (!stream || disposition === "discard" || stream.abort.signal.aborted)
      return true;
    stream.receiveCredit -= frame.payload.byteLength;
    if (!stream.inputClosed) stream.controller.enqueue(frame.payload);
    grant(stream);
    return true;
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const stream of streams.values()) {
      abort(stream, "connection_lost", false);
      clearTimeout(stream.timer);
      clearTimeout(stream.ackTimer);
      stream.dispose?.();
    }
    const remaining = [...streams.values()];
    streams.clear();
    for (const stream of remaining) releaseOutgoing(stream);
    options.signal.removeEventListener("abort", close);
  };
  options.signal.addEventListener("abort", close, { once: true });
  if (options.signal.aborted) close();
  const cancelParent = (streamId: string): void => {
    for (const stream of streams.values()) {
      if (stream.open.parentStreamId === streamId) abort(stream, "cancelled");
    }
  };
  return Object.freeze({
    call,
    control,
    data,
    close,
    cancelParent,
    active: () => streams.size,
  });
}

export type HostCallChannel = ReturnType<typeof createHostCallChannel>;
