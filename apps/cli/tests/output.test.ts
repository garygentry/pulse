/** output.test.ts — the stdout/stderr / colour / verbosity discipline (04 §6, REQ-CLI-03/05,
 *  REQ-OBS-02, REQ-A11Y-01).
 *
 *  Asserts resolveColor's NO_COLOR/TTY rules; that emitJson is the only stdout writer and only
 *  in --json mode; that quiet suppresses note but not diagnostic and detail shows only in
 *  verbose; verbosityOf; and reportFindings routing findings text to stderr only when non-empty. */

import { expect, test, describe } from "bun:test";

import type { Finding } from "@pulse/core";

import {
  createOutputWriter,
  resolveColor,
  verbosityOf,
  reportFindings,
  type OutputInputs,
  type Verbosity,
} from "../src/output.js";

/** A buffer pair capturing both streams for a writer. */
function makeSinks() {
  const out: string[] = [];
  const err: string[] = [];
  const sinks: Pick<OutputInputs, "stdout" | "stderr"> = {
    stdout: (s) => void out.push(s),
    stderr: (s) => void err.push(s),
  };
  return { out, err, sinks };
}

describe("resolveColor (REQ-CLI-05, REQ-A11Y-01)", () => {
  test("false when NO_COLOR is a non-empty string, regardless of TTY", () => {
    expect(resolveColor("1", true)).toBe(false);
    expect(resolveColor("anything", true)).toBe(false);
  });

  test("false when the stream is not a TTY", () => {
    expect(resolveColor(undefined, false)).toBe(false);
    expect(resolveColor("", false)).toBe(false);
  });

  test("true only when NO_COLOR is unset/empty AND the stream is a TTY", () => {
    expect(resolveColor(undefined, true)).toBe(true);
    expect(resolveColor("", true)).toBe(true);
  });
});

describe("verbosityOf", () => {
  test("maps flags to a detail level", () => {
    expect(verbosityOf({ verbose: true, quiet: false })).toBe("verbose");
    expect(verbosityOf({ verbose: false, quiet: true })).toBe("quiet");
    expect(verbosityOf({ verbose: false, quiet: false })).toBe("normal");
  });
});

describe("createOutputWriter — stdout is machine-only (REQ-CLI-03)", () => {
  test("emitJson writes to stdout ONLY in --json mode; nothing else touches stdout", () => {
    const { out, err, sinks } = makeSinks();
    const w = createOutputWriter({ json: true, verbosity: "normal", color: false, ...sinks });
    w.note("progress");
    w.detail("detail");
    w.diagnostic("diag");
    w.emitJson('{"ok":true}\n');
    // Exactly one stdout write — the envelope.
    expect(out).toEqual(['{"ok":true}\n']);
    // Human text went to stderr, never stdout.
    expect(err.join("")).toContain("progress");
    expect(err.join("")).toContain("diag");
  });

  test("emitJson is a no-op in text mode (json:false): stdout stays empty", () => {
    const { out, sinks } = makeSinks();
    const w = createOutputWriter({ json: false, verbosity: "normal", color: false, ...sinks });
    w.emitJson('{"ok":true}\n');
    expect(out).toEqual([]);
  });
});

describe("createOutputWriter — verbosity gates stderr (REQ-OBS-02)", () => {
  test("quiet suppresses note but never diagnostic", () => {
    const { err, sinks } = makeSinks();
    const w = createOutputWriter({ json: false, verbosity: "quiet", color: false, ...sinks });
    w.note("progress");
    w.diagnostic("diag");
    const text = err.join("");
    expect(text).not.toContain("progress");
    expect(text).toContain("diag");
  });

  test("detail shows only in verbose", () => {
    for (const verbosity of ["quiet", "normal"] as Verbosity[]) {
      const { err, sinks } = makeSinks();
      const w = createOutputWriter({ json: false, verbosity, color: false, ...sinks });
      w.detail("deep");
      expect(err.join("")).not.toContain("deep");
    }
    const { err, sinks } = makeSinks();
    const w = createOutputWriter({ json: false, verbosity: "verbose", color: false, ...sinks });
    w.detail("deep");
    expect(err.join("")).toContain("deep");
  });

  test("note shows at normal and verbose", () => {
    for (const verbosity of ["normal", "verbose"] as Verbosity[]) {
      const { err, sinks } = makeSinks();
      const w = createOutputWriter({ json: false, verbosity, color: false, ...sinks });
      w.note("progress");
      expect(err.join("")).toContain("progress");
    }
  });
});

describe("reportFindings (REQ-VAL-02)", () => {
  function finding(severity: Finding["severity"], message: string): Finding {
    return {
      severity,
      code: "secret_literal",
      file: "estate/estate.yaml",
      path: "hosts[0]",
      message,
      fix: "declare a reference",
    };
  }

  test("writes formatted findings to stderr only, never stdout", () => {
    const { out, err, sinks } = makeSinks();
    const w = createOutputWriter({ json: true, verbosity: "normal", color: false, ...sinks });
    reportFindings(w, [finding("error", "boom")]);
    expect(out).toEqual([]); // findings never reach stdout
    expect(err.join("")).toContain("boom");
  });

  test("empty findings list writes nothing", () => {
    const { out, err, sinks } = makeSinks();
    const w = createOutputWriter({ json: false, verbosity: "normal", color: false, ...sinks });
    reportFindings(w, []);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });
});
