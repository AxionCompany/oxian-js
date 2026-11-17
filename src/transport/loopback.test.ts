import assert from "node:assert/strict";
import { test } from "node:test";
import { isLoopbackHostname } from "./loopback.ts";

test("isLoopbackHostname accepts localhost, *.localhost and loopback addresses", () => {
  for (const host of [
    "localhost",
    "LocalHost",
    "localhost.",
    "shop.localhost",
    "Shop.LOCALHOST.",
    "a.b.localhost",
    "127.0.0.1",
    "::1",
    "[::1]",
  ]) {
    assert.equal(isLoopbackHostname(host), true, host);
  }
});

test("isLoopbackHostname rejects other hosts", () => {
  for (const host of [
    "",
    "example.com",
    "notlocalhost",
    "localhost.example.com",
    "localhost.evil.com",
    "evillocalhost",
    "127.0.0.2",
    "10.0.0.1",
    "[::2]",
  ]) {
    assert.equal(isLoopbackHostname(host), false, host);
  }
});
