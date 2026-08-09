import { assertEquals } from "@std/assert";
import {
  decodeBinaryFrame,
  encodeBinaryFrame,
  encodeControlFrame,
  parseControlFrame,
  WORKER_PROTOCOL,
} from "../../src/protocol/index.ts";
import golden from "../fixtures/protocol/v0.20.0-rc.7.json" with {
  type: "json",
};

function fromHex(value: string): Uint8Array {
  return new Uint8Array(
    value.match(/.{2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

Deno.test("v0.21 preserves every v0.20.0-rc.7 golden control-frame byte", () => {
  assertEquals(golden.sourceVersion, "0.20.0-rc.7");
  assertEquals(golden.protocol, WORKER_PROTOCOL);
  for (const fixture of golden.control) {
    const decoded = parseControlFrame(fixture.encoded);
    assertEquals(decoded.type, fixture.type);
    assertEquals(encodeControlFrame(decoded), fixture.encoded);
  }
});

Deno.test("v0.21 preserves the v0.20.0-rc.7 binary header and payload bytes", () => {
  const encoded = fromHex(golden.binary.encodedHex);
  const decoded = decodeBinaryFrame(encoded);
  assertEquals(decoded.streamId, golden.binary.streamId);
  assertEquals(decoded.sequence, golden.binary.sequence);
  assertEquals(toHex(decoded.payload), golden.binary.payloadHex);
  assertEquals(toHex(encodeBinaryFrame(decoded)), golden.binary.encodedHex);
});
