// tests/events/sse-constants.test.ts — the server's SSE constants equal the wire contract values.
//
// A client reads the reconnect delay, heartbeat cadence and stream cap from the wire package, so the
// values the server actually uses must be the same numbers.

import { describe, expect, test } from "bun:test";
import * as wire from "@pulse/web-data/wire";
import * as server from "../../src/server/events/stream.js";

describe("SSE constants match the wire contract", () => {
  test("retry, heartbeat and stream cap are equal", () => {
    expect(server.SSE_RETRY_MS).toBe(wire.SSE_RETRY_MS);
    expect(server.SSE_HEARTBEAT_MS).toBe(wire.SSE_HEARTBEAT_MS);
    expect(server.SSE_MAX_STREAMS).toBe(wire.SSE_MAX_STREAMS);
  });

  test("the values are the documented literals", () => {
    expect(server.SSE_RETRY_MS).toBe(10_000);
    expect(server.SSE_HEARTBEAT_MS).toBe(5_000);
    expect(server.SSE_MAX_STREAMS).toBe(64);
  });

  test("the retry frame advertises the wire value", () => {
    expect(new TextDecoder().decode(server.RETRY_FRAME)).toBe(`retry: ${wire.SSE_RETRY_MS}\n\n`);
  });
});
