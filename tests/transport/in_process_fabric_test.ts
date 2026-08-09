import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import {
  bindInProcessFabric,
  connectInProcessFabric,
  type InProcessFabricEvent,
} from "../../src/transport/in-process.ts";
import type { SocketConnection } from "../../src/transport/index.ts";

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new DOMException(message, "TimeoutError");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

Deno.test("the local fabric addresses ordered frames to one logical connection", async () => {
  const topic = `fabric-addressing-${crypto.randomUUID()}`;
  const accepted: SocketConnection[] = [];
  const events: InProcessFabricEvent[] = [];
  let dropNext = false;
  const binding = bindInProcessFabric({
    topic,
    accept: (connection) => void accepted.push(connection),
    intercept(event) {
      events.push(event);
      if (!dropNext) return "deliver";
      dropNext = false;
      return "drop";
    },
  });
  const workerA = connectInProcessFabric({ topic });
  const workerB = connectInProcessFabric({ topic });
  const hostA: (string | Uint8Array)[] = [];
  const hostB: (string | Uint8Array)[] = [];
  const receivedA: (string | Uint8Array)[] = [];
  const receivedB: (string | Uint8Array)[] = [];

  try {
    assertEquals(accepted.length, 2);
    const unsubscribeHostA = accepted[0].subscribe({
      message: (frame) => void hostA.push(frame as string | Uint8Array),
    });
    const unsubscribeHostB = accepted[1].subscribe({
      message: (frame) => void hostB.push(frame as string | Uint8Array),
    });
    const unsubscribeWorkerA = workerA.subscribe({
      message: (frame) => void receivedA.push(frame as string | Uint8Array),
    });
    const unsubscribeWorkerB = workerB.subscribe({
      message: (frame) => void receivedB.push(frame as string | Uint8Array),
    });

    workerA.send("a-1");
    workerA.send(new Uint8Array([1, 2, 3]));
    workerB.send("b-1");
    accepted[0].send("host-a");
    await waitFor(
      () => hostA.length === 2 && hostB.length === 1 && receivedA.length === 1,
      "addressed fabric frames did not arrive",
    );

    assertEquals(hostA, ["a-1", new Uint8Array([1, 2, 3])]);
    assertEquals(hostB, ["b-1"]);
    assertEquals(receivedA, ["host-a"]);
    assertEquals(receivedB, []);
    assertNotEquals(events[0].connectionId, events[2].connectionId);
    assertEquals(events.map((event) => event.topic), Array(4).fill(topic));
    assertEquals(events.map((event) => event.direction), [
      "worker-to-hypervisor",
      "worker-to-hypervisor",
      "worker-to-hypervisor",
      "hypervisor-to-worker",
    ]);

    dropNext = true;
    workerA.send("dropped-by-test-fault");
    workerA.send("after-drop");
    await waitFor(
      () => hostA.length === 3,
      "post-fault frame did not preserve connection progress",
    );
    assertEquals(hostA[2], "after-drop");

    unsubscribeHostA();
    unsubscribeHostB();
    unsubscribeWorkerA();
    unsubscribeWorkerB();
  } finally {
    binding.close("test_complete");
  }

  assertEquals(workerA.state, "closed");
  assertEquals(workerB.state, "closed");
});

Deno.test("the local fabric enforces its physical frame and byte bounds", () => {
  const topic = `fabric-bounds-${crypto.randomUUID()}`;
  let accepted: SocketConnection | undefined;
  const binding = bindInProcessFabric({
    topic,
    accept: (connection) => void (accepted = connection),
  });
  const worker = connectInProcessFabric({
    topic,
    maxQueuedFrames: 1,
    maxQueuedBytes: 4,
  });

  try {
    accepted!.send("1234");
    assertEquals(accepted!.bufferedAmount, 4);
    assertThrows(
      () => accepted!.send("x"),
      RangeError,
      "queue exceeded its bound",
    );
  } finally {
    worker.close(1000, "test_complete");
    binding.close("test_complete");
  }
});

Deno.test("closing a local binding releases its topic and every connection", () => {
  const topic = `fabric-cleanup-${crypto.randomUUID()}`;
  const binding = bindInProcessFabric({ topic, accept() {} });
  const worker = connectInProcessFabric({ topic });
  binding.close("hot_reload");
  assertEquals(worker.state, "closed");

  const replacement = bindInProcessFabric({ topic, accept() {} });
  replacement.close("test_complete");
});
