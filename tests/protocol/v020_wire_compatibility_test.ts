import { test } from "node:test";
import assert from "node:assert/strict";
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

test("v0.21 preserves every v0.20.0-rc.7 golden control-frame byte", () => {
  assert.deepStrictEqual(golden.sourceVersion, "0.20.0-rc.7");
  assert.deepStrictEqual(golden.protocol, WORKER_PROTOCOL);
  for (const fixture of golden.control) {
    const decoded = parseControlFrame(fixture.encoded);
    assert.deepStrictEqual(decoded.type, fixture.type);
    assert.deepStrictEqual(encodeControlFrame(decoded), fixture.encoded);
  }
});

test("v0.21 preserves the v0.20.0-rc.7 binary header and payload bytes", () => {
  const encoded = fromHex(golden.binary.encodedHex);
  const decoded = decodeBinaryFrame(encoded);
  assert.deepStrictEqual(decoded.streamId, golden.binary.streamId);
  assert.deepStrictEqual(decoded.sequence, golden.binary.sequence);
  assert.deepStrictEqual(toHex(decoded.payload), golden.binary.payloadHex);
  assert.deepStrictEqual(
    toHex(encodeBinaryFrame(decoded)),
    golden.binary.encodedHex,
  );
});
