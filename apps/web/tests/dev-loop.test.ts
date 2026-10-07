// apps/web/tests/dev-loop.test.ts — item 016 / REQ-DEV-11 smoke.
//
// Spawns `bun apps/web/scripts/dev.ts --mock all-green --port 0`, discovers the bound port from
// the supervisor's stdout, GETs the shell, and asserts the manifest's entry tags landed. Then
// SIGTERM and asserts a clean exit within the grace window. No engine, no container, no browser.
//
// Also serves web-data-tier item 055 / 02 §9 point 1 (AC1): from the same real run it asserts the
// supervisor compiles the dependency packages BEFORE the first client build and the server spawn,
// by checking the ordering of the parent's own stdout milestones.

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const APP_ROOT = resolve(REPO_ROOT, "apps", "web");
const CLIENT_DIR = resolve(APP_ROOT, "dist", "client");
const DEV_SCRIPT = resolve(APP_ROOT, "scripts", "dev.ts");

interface Spawned {
  proc: ReturnType<typeof Bun.spawn>;
  readAll: () => Promise<{ stdout: string; exitCode: number }>;
  waitForLine: (predicate: (line: string) => boolean, timeoutMs: number) => Promise<string>;
  /** A snapshot of every stdout line collected so far, in emission order. */
  lines: () => readonly string[];
}

function spawnDev(args: readonly string[]): Spawned {
  const proc = Bun.spawn(["bun", DEV_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  const collected: string[] = [];
  const listeners: Array<(line: string) => void> = [];

  const consume = async (): Promise<void> => {
    const decoder = new TextDecoder();
    let buffer = "";
    const stream = proc.stdout as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          collected.push(line);
          for (const l of listeners) l(line);
        }
      }
      if (buffer.length > 0) {
        collected.push(buffer);
        for (const l of listeners) l(buffer);
      }
    } finally {
      reader.releaseLock();
    }
  };
  const consumePromise = consume();

  return {
    proc,
    async readAll(): Promise<{ stdout: string; exitCode: number }> {
      const exitCode = await proc.exited;
      await consumePromise;
      return { stdout: collected.join("\n"), exitCode };
    },
    lines: () => collected.slice(),
    waitForLine(predicate, timeoutMs): Promise<string> {
      for (const line of collected) if (predicate(line)) return Promise.resolve(line);
      return new Promise<string>((resolve0, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `timeout ${timeoutMs}ms waiting for matching line; got:\n${collected.join("\n")}`,
            ),
          );
        }, timeoutMs);
        const listener = (line: string): void => {
          if (predicate(line)) {
            clearTimeout(timer);
            resolve0(line);
          }
        };
        listeners.push(listener);
      });
    },
  };
}

let active: Spawned | null = null;

beforeEach(() => {
  active = null;
});

afterEach(async () => {
  if (active !== null) {
    try {
      active.proc.kill("SIGKILL");
      await active.proc.exited;
    } catch {
      // ignore
    }
    active = null;
  }
});

describe("REQ-DEV-11 — bun apps/web/scripts/dev.ts --mock all-green --port 0", () => {
  test("shell renders with injected tags for the current buildId; SIGTERM exits 0", async () => {
    const spawned = spawnDev(["--mock", "all-green", "--port", "0"]);
    active = spawned;

    // Wait for the supervisor's listening line — this covers both a successful first build and
    // a successful child bind.
    const listeningLine = await spawned.waitForLine(
      (l) => l.startsWith("[dev] server listening on http://"),
      30_000,
    );
    // Extract the bound port from `[dev] server listening on http://<host>:<port>  mock=<...>`.
    const match = /http:\/\/[^:]+:(\d+)\s/.exec(listeningLine);
    expect(match).not.toBe(null);
    const port = Number.parseInt(match![1] as string, 10);
    expect(Number.isFinite(port)).toBe(true);
    expect(port).toBeGreaterThan(0);

    // web-data-tier 02 §9 point 1 (AC1): the real supervisor compiles the dependency packages
    // BEFORE the first client build and BEFORE spawning the server. Assert that ordering from the
    // parent's own stdout — the dependency build both STARTS and COMPLETES ahead of the client
    // build, which in turn precedes the child server bind.
    const emitted = spawned.lines();
    const firstIndex = (pred: (l: string) => boolean): number => emitted.findIndex(pred);
    const pkgStarted = firstIndex((l) => l.startsWith("[dev] package build started"));
    const pkgDone = firstIndex((l) => /^\[dev\] package build (ok|FAILED)/.test(l));
    const clientStarted = firstIndex((l) => l.startsWith("[dev] client build started"));
    const listening = firstIndex((l) => l.startsWith("[dev] server listening on http://"));
    expect(pkgStarted).toBeGreaterThanOrEqual(0);
    expect(pkgDone).toBeGreaterThan(pkgStarted); // dependency build completes before...
    expect(clientStarted).toBeGreaterThan(pkgDone); // ...the client build starts, which precedes...
    expect(listening).toBeGreaterThan(clientStarted); // ...the server bind.

    // The first build should have published a manifest — read the buildId directly.
    const manifest = JSON.parse(readFileSync(resolve(CLIENT_DIR, "manifest.json"), "utf8")) as {
      buildId: string;
      entries: { js: string[]; css: string[] };
    };
    expect(typeof manifest.buildId).toBe("string");
    expect(manifest.buildId.length).toBe(12);
    expect(manifest.entries.js.length).toBeGreaterThan(0);

    // GET the shell — every entries.js / entries.css path should appear in the served HTML, plus
    // the build-id meta.
    const shellRes = await fetch(`http://127.0.0.1:${port}/`);
    expect(shellRes.status).toBe(200);
    const shell = await shellRes.text();
    for (const js of manifest.entries.js) expect(shell).toContain(js);
    for (const css of manifest.entries.css) expect(shell).toContain(css);
    expect(shell).toContain(manifest.buildId);

    // GET /__dev/build-id — must equal manifest.buildId (REQ-DEV-05).
    const idRes = await fetch(`http://127.0.0.1:${port}/__dev/build-id`);
    expect(idRes.status).toBe(200);
    expect(idRes.headers.get("cache-control")).toBe("no-store");
    const body = (await idRes.json()) as { buildId: string };
    expect(body.buildId).toBe(manifest.buildId);

    // Clean shutdown — SIGTERM the supervisor and expect exit 0 within 10s.
    spawned.proc.kill("SIGTERM");
    const exited = await Promise.race([
      spawned.proc.exited,
      new Promise<number>((_r, rej) => setTimeout(() => rej(new Error("shutdown timeout")), 10_000)),
    ]);
    expect(exited).toBe(0);
    active = null; // already exited
  }, 60_000);
});
