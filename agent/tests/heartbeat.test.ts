// agent/tests/heartbeat.test.ts
//
// Focused coverage for the per-host heartbeat exporter (03-bundle-and-heartbeat.md §5; item 013).
// Exercises the pure, side-effect-free seams ONLY — `renderHeartbeat` (exposition body) and
// `handleRequest` (routing) — so importing this file never binds HEARTBEAT_PORT (06 §3.4):
//   - renderHeartbeat emits EXACTLY the two contract series with version/component labels and
//     NO self-emitted host label (host is scrape-applied via file_sd relabel, 03 §5.1).
//   - the version label safely escapes Prometheus label metacharacters (REQ-HB-02).
//   - handleRequest serves ONLY GET /metrics; any other path → 404, any other method → 405
//     (no write/control surface, REQ-SEC-02, 03 §5.3).

import { describe, expect, test } from "bun:test";

import { renderHeartbeat, handleRequest } from "../heartbeat/src/index.js";
import { AGENT_VERSION } from "../heartbeat/src/version.js";
import { PULSE_AGENT_UP, PULSE_AGENT_BUILD_INFO } from "../contract/types.js";

const METRICS_URL = "http://localhost:9110/metrics";

describe("renderHeartbeat exposition (REQ-HB-01/02)", () => {
  test("emits exactly the two contract series with version/component labels", () => {
    const text = renderHeartbeat("1.4.2");
    expect(text).toBe(
      [
        "# HELP pulse_agent_up Pulse managed-linux agent liveness (1 = alive).",
        "# TYPE pulse_agent_up gauge",
        "pulse_agent_up 1",
        "# HELP pulse_agent_build_info Pulse agent build/version info (value always 1).",
        "# TYPE pulse_agent_build_info gauge",
        'pulse_agent_build_info{version="1.4.2",component="agent"} 1',
        "",
      ].join("\n"),
    );
  });

  test("uses the Pulse-owned series names from the contract constants", () => {
    const text = renderHeartbeat("1.4.2");
    expect(text).toContain(`${PULSE_AGENT_UP} 1`);
    expect(text).toContain(`${PULSE_AGENT_BUILD_INFO}{version="1.4.2",component="agent"} 1`);
  });

  test("never self-emits a host label (host is scrape-applied, 03 §5.1)", () => {
    const text = renderHeartbeat("1.4.2");
    expect(text).not.toContain("host=");
  });

  test("carries a label-safe version string unchanged (REQ-HB-02 version carrier)", () => {
    const version = "2.0.0-rc.1+build.5";
    const text = renderHeartbeat(version);
    expect(text).toContain(`{version="${version}",component="agent"} 1`);
  });

  test("escapes quote, backslash, and newline in the Prometheus version label", () => {
    const text = renderHeartbeat('2.0\\build"candidate\nnext');
    expect(text).toContain('{version="2.0\\\\build\\"candidate\\nnext",component="agent"} 1');
    expect(text).not.toContain('candidate\nnext');
  });

  test("the committed default version is a dev placeholder", () => {
    // A released image overwrites version.ts via the Dockerfile build ARG (03 §5.2/§5.5).
    expect(AGENT_VERSION).toBe("0.0.0-dev");
  });
});

describe("handleRequest routing (REQ-SEC-02, 03 §5.3)", () => {
  test("GET /metrics returns 200 with the exposition body and prometheus content type", async () => {
    const res = handleRequest(new Request(METRICS_URL));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    const body = await res.text();
    expect(body).toContain(`${PULSE_AGENT_UP} 1`);
    expect(body).toContain(`${PULSE_AGENT_BUILD_INFO}{version="${AGENT_VERSION}",component="agent"} 1`);
  });

  test("a non-/metrics path returns 404", async () => {
    for (const path of ["/", "/healthz", "/write", "/metrics/extra"]) {
      const res = handleRequest(new Request(`http://localhost:9110${path}`));
      expect(res.status).toBe(404);
    }
  });

  test("a non-GET method on /metrics returns 405 (no write/control surface)", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = handleRequest(new Request(METRICS_URL, { method }));
      expect(res.status).toBe(405);
    }
  });
});
