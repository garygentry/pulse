// apps/cli/tests/connect-link.test.ts — `pulse connect-link`: the runner, the terminal QR
// renderer, and the verb end to end through the in-process CLI (address precedence, refusals,
// exit codes, output channels, no credential echo, no network).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FINDING_CODES } from "@pulse/core";
import { CONNECT_LINK_MAX_LENGTH, encodeQrMatrix } from "@pulse/web-data/contract";

import { runCli } from "./factories.js";
import { runConnectLink } from "../src/commands/connect-link.js";
import type { ConnectLinkAddress } from "../src/config.js";
import type { ConnectLinkData, PulseEnvelope } from "../src/envelope.js";
import { createOutputWriter } from "../src/output.js";
import type { Verbosity } from "../src/output.js";
import { renderQrHalfBlocks, TERMINAL_QR_QUIET_ZONE } from "../src/qr-terminal.js";

const BASE = "https://pulse.example.com";
const LINK = "pulse://connect?v=1&url=https%3A%2F%2Fpulse.example.com";
const BLOCKS = /[▀▄█]/;

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pulse-connect-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

/** A buffered writer plus its captured streams. */
function capture(verbosity: Verbosity = "normal", json = false) {
  const streams = { stdout: "", stderr: "" };
  const out = createOutputWriter({
    json,
    verbosity,
    color: false,
    stdout: (s) => void (streams.stdout += s),
    stderr: (s) => void (streams.stderr += s),
  });
  return { out, streams };
}

const flag = (value: string): ConnectLinkAddress => ({ value, source: "flag" });

describe("renderQrHalfBlocks", () => {
  const ONE_DARK = { size: 1, modules: [true] };

  test("a 1×1 dark matrix paints the light cells by default", () => {
    expect(renderQrHalfBlocks(ONE_DARK).split("\n")).toEqual([
      "█████████",
      "█████████",
      "████▄████",
      "█████████",
      "█████████",
    ]);
  });

  test("invert paints the dark cells instead", () => {
    expect(renderQrHalfBlocks(ONE_DARK, { invert: true }).split("\n")).toEqual([
      "         ",
      "         ",
      "    ▀    ",
      "         ",
      "         ",
    ]);
  });

  test("width is size + 2 × quiet zone and height is half of it, rounded up", () => {
    expect(TERMINAL_QR_QUIET_ZONE).toBe(4);
    for (const text of ["a", LINK]) {
      const matrix = encodeQrMatrix(text);
      const side = matrix.size + 2 * TERMINAL_QR_QUIET_ZONE;
      const text2 = renderQrHalfBlocks(matrix);
      const lines = text2.split("\n");
      expect(lines.length).toBe(Math.ceil(side / 2));
      for (const line of lines) expect([...line].length).toBe(side);
      expect(text2.endsWith("\n")).toBe(false);
      expect(text2).not.toContain(String.fromCharCode(0x1b));
    }
    // Version 1 (21 modules): 29 columns, 15 lines.
    expect(encodeQrMatrix("a").size).toBe(21);
    expect(renderQrHalfBlocks(encodeQrMatrix("a")).split("\n").length).toBe(15);
  });

  test("the two polarities are exact complements", () => {
    const matrix = encodeQrMatrix(LINK);
    const swap: Record<string, string> = { "█": " ", " ": "█", "▀": "▄", "▄": "▀" };
    const flipped = [...renderQrHalfBlocks(matrix)].map((ch) => swap[ch] ?? ch).join("");
    expect(renderQrHalfBlocks(matrix, { invert: true })).toBe(flipped);
  });

  test("a modules length that is not size × size throws RangeError", () => {
    expect(() => renderQrHalfBlocks({ size: 2, modules: [true, false, true] })).toThrow(RangeError);
    expect(() => renderQrHalfBlocks({ size: 1, modules: [] })).toThrow(RangeError);
  });
});

describe("runConnectLink — runner", () => {
  test("no address gives CONNECT_LINK_NO_ADDRESS, no data and no output", () => {
    const { out, streams } = capture();
    const result = runConnectLink({ address: undefined }, out);
    expect(result.outcomeFailed).toBe(true);
    expect(result.data).toBeNull();
    expect(result.findings).toEqual([
      {
        severity: "error",
        code: FINDING_CODES.CONNECT_LINK_NO_ADDRESS,
        file: "",
        path: "",
        message: "No server address is configured for the connect link.",
        fix: "Pass --url https://<server address>, set PULSE_WEB_EXTERNAL_URL, or set externalUrl in pulse.config.yaml.",
      },
    ]);
    expect(streams).toEqual({ stdout: "", stderr: "" });
  });

  const REFUSALS = [
    {
      name: "not-https",
      value: "http://pulse.example.com",
      message: (s: string) => `The address from ${s} does not use HTTPS, so no connect link was produced.`,
      fix: "Use the server's https address.",
    },
    {
      name: "loopback",
      value: "https://localhost:8443",
      message: (s: string) => `The address from ${s} is a loopback address that a phone cannot reach.`,
      fix: "Use the server's https address on your network.",
    },
    {
      name: "credentials",
      value: "https://user:secret@pulse.example.com",
      message: (s: string) => `The address from ${s} contains a user name or password.`,
      fix: "Remove the credentials; a connect link never carries them.",
    },
    {
      name: "unparseable",
      value: "not a url",
      message: (s: string) => `The address from ${s} is not a valid absolute URL.`,
      fix: "Use an absolute https URL such as https://pulse.example.com.",
    },
    {
      name: "too-long",
      value: `https://pulse.example.com/${"a".repeat(300)}`,
      message: (s: string) =>
        `The address from ${s} makes a connect link longer than ${CONNECT_LINK_MAX_LENGTH} characters.`,
      fix: "Use a shorter https address.",
    },
  ] as const;

  const SOURCES = [
    { source: "flag", label: "--url" },
    { source: "env", label: "PULSE_WEB_EXTERNAL_URL" },
    { source: "config", label: "pulse.config.yaml" },
  ] as const;

  for (const refusal of REFUSALS) {
    for (const { source, label } of SOURCES) {
      test(`${refusal.name} from ${source}: CONNECT_LINK_REFUSED naming the source, not the value`, () => {
        const { out, streams } = capture();
        const result = runConnectLink({ address: { value: refusal.value, source } }, out);
        expect(result.outcomeFailed).toBe(true);
        expect(result.data).toBeNull();
        expect(result.findings).toEqual([
          {
            severity: "error",
            code: FINDING_CODES.CONNECT_LINK_REFUSED,
            file: "",
            path: "",
            message: refusal.message(label),
            fix: refusal.fix,
          },
        ]);
        expect(JSON.stringify(result)).not.toContain(refusal.value);
        expect(streams).toEqual({ stdout: "", stderr: "" });
      });
    }
  }

  test("a usable address returns the link, the normalised base and the source", () => {
    const { out, streams } = capture();
    const result = runConnectLink({ address: { value: `${BASE}/`, source: "env" } }, out);
    expect(result).toEqual({
      findings: [],
      data: { link: LINK, baseUrl: BASE, source: "env" },
      outcomeFailed: false,
    });
    expect(streams.stdout).toBe("");
    const lines = streams.stderr.split("\n");
    expect(lines.at(-1)).toBe("");
    expect(lines.at(-2)).toBe(`Address from PULSE_WEB_EXTERNAL_URL: ${BASE}`);
    expect(lines.at(-3)).toBe(LINK);
    expect(lines.at(-4)).toBe("");
    expect(lines.slice(0, -4).join("\n")).toBe(renderQrHalfBlocks(encodeQrMatrix(LINK)));
  });

  test("the source line names each source", () => {
    const line = (address: ConnectLinkAddress): string => {
      const { out, streams } = capture();
      runConnectLink({ address }, out);
      return streams.stderr.trimEnd().split("\n").at(-1)!;
    };
    expect(line(flag(BASE))).toBe(`Address from --url: ${BASE}`);
    expect(line({ value: BASE, source: "config" })).toBe(
      `Address from pulse.config.yaml (externalUrl): ${BASE}`,
    );
  });

  test("at quiet verbosity only the link is written", () => {
    const { out, streams } = capture("quiet");
    runConnectLink({ address: flag(BASE) }, out);
    expect(streams).toEqual({ stdout: "", stderr: `${LINK}\n` });
  });
});

describe("pulse connect-link — end to end", () => {
  const envelope = (stdout: string): PulseEnvelope<ConnectLinkData> => {
    const parsed = JSON.parse(stdout) as PulseEnvelope<ConnectLinkData>;
    expect(stdout).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
    expect(parsed.command).toBe("connect-link");
    return parsed;
  };

  test("--url --json exits 0 with only the envelope on stdout", async () => {
    const r = await runCli(["connect-link", "--url", BASE, "--json"], { cwd });
    expect(r.exitCode).toBe(0);
    const parsed = envelope(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.findings).toEqual([]);
    expect(parsed.data).toEqual({ link: LINK, baseUrl: BASE, source: "flag" });
    expect(r.stderr).toMatch(BLOCKS);
    expect(r.stderr).toContain(`${LINK}\n`);
  });

  test("default mode: nothing on stdout; QR, link and source line on stderr", async () => {
    const r = await runCli(["connect-link", "--url", `${BASE}/`], { cwd });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(BLOCKS);
    expect(r.stderr.endsWith(`\n\n${LINK}\nAddress from --url: ${BASE}\n`)).toBe(true);
    expect(r.stderr).not.toContain(String.fromCharCode(0x1b));
  });

  test("--quiet hides the QR and still prints exactly the link line", async () => {
    const r = await runCli(["connect-link", "--url", BASE, "--quiet"], { cwd });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`${LINK}\n`);
  });

  test("--json --quiet: envelope on stdout, link only on stderr", async () => {
    const r = await runCli(["connect-link", "--url", BASE, "--json", "--quiet"], { cwd });
    expect(r.exitCode).toBe(0);
    expect(envelope(r.stdout).data?.link).toBe(LINK);
    expect(r.stderr).toBe(`${LINK}\n`);
  });

  test("--url beats PULSE_WEB_EXTERNAL_URL, which beats externalUrl in pulse.config.yaml", async () => {
    writeFileSync(join(cwd, "pulse.config.yaml"), "externalUrl: https://file.example.com\n");
    const env = { PULSE_WEB_EXTERNAL_URL: "https://env.example.com" };
    const data = async (args: string[], e: NodeJS.ProcessEnv): Promise<ConnectLinkData> => {
      const r = await runCli(["connect-link", "--json", ...args], { cwd, env: e });
      expect(r.exitCode).toBe(0);
      return envelope(r.stdout).data!;
    };
    expect(await data(["--url", "https://flag.example.com"], env)).toMatchObject({
      baseUrl: "https://flag.example.com",
      source: "flag",
    });
    expect(await data([], env)).toMatchObject({ baseUrl: "https://env.example.com", source: "env" });
    expect(await data([], {})).toMatchObject({ baseUrl: "https://file.example.com", source: "config" });
    // An empty env value (the compose default) falls through to the file.
    expect(await data([], { PULSE_WEB_EXTERNAL_URL: "" })).toMatchObject({ source: "config" });
  });

  test("no address exits 1 with CONNECT_LINK_NO_ADDRESS", async () => {
    const r = await runCli(["connect-link", "--json"], { cwd });
    expect(r.exitCode).toBe(1);
    const parsed = envelope(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.data).toBeNull();
    expect(parsed.findings.map((f) => f.code)).toEqual([FINDING_CODES.CONNECT_LINK_NO_ADDRESS]);
    expect(r.stderr).toContain("connect_link_no_address");
    expect(r.stderr).not.toMatch(BLOCKS);
  });

  test("a refused address exits 1 with CONNECT_LINK_REFUSED and no QR, also at --quiet", async () => {
    for (const extra of [[], ["--quiet"]]) {
      const r = await runCli(["connect-link", "--url", "http://192.0.2.10", ...extra], { cwd });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("connect_link_refused");
      expect(r.stderr).toContain("does not use HTTPS");
      expect(r.stderr).not.toMatch(BLOCKS);
      expect(r.stderr).not.toContain("pulse://");
    }
  });

  test("credentials in the address never reach stdout, stderr or the envelope", async () => {
    const secretUrl = "https://user:secret@pulse.example.com";
    const runs = [
      await runCli(["connect-link", "--url", secretUrl, "--json"], { cwd }),
      await runCli(["connect-link", "--url", secretUrl, "--verbose"], { cwd }),
      await runCli(["connect-link", "--json"], { cwd, env: { PULSE_WEB_EXTERNAL_URL: secretUrl } }),
    ];
    writeFileSync(join(cwd, "pulse.config.yaml"), `externalUrl: ${secretUrl}\n`);
    runs.push(await runCli(["connect-link", "--json"], { cwd }));
    for (const r of runs) {
      expect(r.exitCode).toBe(1);
      for (const text of [r.stdout, r.stderr]) {
        expect(text).not.toContain("secret");
        expect(text).not.toContain("user:");
      }
      expect(r.stderr).toContain("contains a user name or password");
    }
    expect(envelope(runs[0]!.stdout).findings[0]!.code).toBe(FINDING_CODES.CONNECT_LINK_REFUSED);
  });

  test("usage faults exit 2 with empty stdout", async () => {
    for (const args of [
      ["connect-link", "--url"],
      ["connect-link", "--url", "  "],
      ["connect-link", "--url="],
      ["connect-link", "--bogus"],
      ["connect-link", "https://pulse.example.com"],
    ]) {
      const r = await runCli([...args, "--json"], { cwd });
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("usage error");
    }
  });

  test("a non-string externalUrl in the config file exits 2", async () => {
    writeFileSync(join(cwd, "pulse.config.yaml"), "externalUrl: 42\n");
    const r = await runCli(["connect-link", "--json"], { cwd });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("config error [INVALID_ARG]");
  });

  test("the run makes no network request", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      throw new Error("network access is not allowed");
    }) as unknown as typeof fetch;
    try {
      const r = await runCli(["connect-link", "--url", BASE, "--json"], { cwd });
      expect(r.exitCode).toBe(0);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
