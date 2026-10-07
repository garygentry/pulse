/** proposals.test.ts — `pulse proposals` plumbing (mutation-foundation 08 §1.2–1.5, §2, §11.2):
 *  the tail parser, `proposalsDir` config resolution, the secret-key refusal, the dispatcher's
 *  config/secret faults, and the PROPOSAL_* finding builders. Later items append the list/show
 *  (039) and apply/reject (041) suites. All sources (env, cwd, temp dirs) are injected. */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigIoError, FINDING_CODES } from "@pulse/core";
import type { Finding } from "@pulse/core";
import type { ProposalPayload, ProposalResultV1 } from "@pulse/core/proposals";

import { resolveConfig } from "../src/config.js";
import type { GlobalFlags } from "../src/args.js";
import { parseProposalsArgs, validateRejectReason, PROPOSALS_SUBVERBS } from "../src/commands/proposals/args.js";
import type { OptionBag } from "../src/commands/proposals/args.js";
import {
  alreadyDecided,
  cannotClearBaseFinding,
  dirtyTreeFinding,
  invalidEstateFinding,
  notFoundFinding,
  proposalFinding,
  refused,
  signatureInvalidFinding,
  staleFinding,
  staleInapplicableFinding,
  staleTargetGoneFinding,
} from "../src/commands/proposals/findings.js";
import { stripControl } from "../src/commands/proposals/commit-message.js";
import { ProposalToolError } from "../src/commands/proposals/git.js";
import {
  PROPOSAL_SECRET_ENV,
  readProposalSecret,
  requireProposalsDir,
} from "../src/commands/proposals/index.js";
import { runCli } from "./factories.js";
import { TEST_ENV, TEST_SECRET, git, tempGitEstate, writeSignedProposal } from "./temp-git-estate.js";
import type { TempGitEstate } from "./temp-git-estate.js";
import { canonicalProposalJson, proposalFileName as pFileName, resultFileName } from "@pulse/core/proposals";
import {
  idFromProposalFileName,
  readProposal,
  readProposalDir,
  readResult,
  toSummary,
  writeResultFile,
} from "../src/commands/proposals/dir.js";

/** Mirrors args.ts GLOBAL_OPTIONS (module-private there). */
const GLOBALS: OptionBag = {
  json: { type: "boolean", default: false },
  strict: { type: "boolean", default: false },
  verbose: { type: "boolean", default: false },
  quiet: { type: "boolean", default: false },
  config: { type: "string" },
  version: { type: "boolean", default: false },
};

const ID = "p-20260928T101500Z-1a2b3c4d";
const SECRET = "s3cret-canary-value-0123456789abcdefXYZ"; // ≥ 32 UTF-8 bytes
const REASON = "duplicate of an earlier proposal";

let root: string;
let proposalsDir: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pulse-proposals-"));
  proposalsDir = join(root, "proposals");
  mkdirSync(proposalsDir);
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function flags(overrides: Partial<GlobalFlags> = {}): GlobalFlags {
  return { json: false, strict: false, verbose: false, quiet: false, ...overrides };
}

/** A fresh cwd with an optional pulse.config.yaml. */
function cwdWith(config?: string): string {
  const d = mkdtempSync(join(root, "cwd-"));
  if (config !== undefined) writeFileSync(join(d, "pulse.config.yaml"), config, "utf8");
  return d;
}

/** The 08 §2.3 usage cases: argv tail after `proposals`, and the message stem. */
const USAGE_CASES: readonly (readonly [string, readonly string[], string])[] = [
  ["no sub-command", [], "missing sub-command"],
  ["unknown sub-command", ["approve", ID], 'unknown sub-command "approve"'],
  ["show without id", ["show"], "missing <id>"],
  ["apply without id", ["apply"], "missing <id>"],
  ["reject without id", ["reject", "--reason", REASON], "missing <id>"],
  ["traversal id", ["show", "../x"], "malformed proposal id"],
  ["extra positional", ["show", ID, "extra"], "unexpected argument"],
  ["list with a positional", ["list", ID], "unexpected argument"],
  ["bad --state", ["list", "--state", "done"], "--state must be one of"],
  ["--overlay off apply", ["show", ID, "--overlay", "x.yaml"], "--overlay is only valid for"],
  ["--reason off reject", ["apply", ID, "--reason", REASON], "--reason is only valid for"],
  ["--state off list", ["show", ID, "--state", "pending"], "--state is only valid for"],
  ["reject without --reason", ["reject", ID], "--reason"],
  ["reject with a short reason", ["reject", ID, "--reason", "too short"], "--reason"],
  ["reject with a control char", ["reject", ID, "--reason", "bad \u0007 reason text"], "--reason"],
];

describe("parseProposalsArgs — grammar and usage stems (REQ-PROP-07)", () => {
  for (const [name, tokens, stem] of USAGE_CASES) {
    test(`${name} → '${stem}'`, () => {
      const r = parseProposalsArgs(tokens, GLOBALS);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain(stem);
    });
  }

  test("an unknown flag is a usage message, never a throw", () => {
    const r = parseProposalsArgs(["list", "--bogus"], GLOBALS);
    expect(r.ok).toBe(false);
  });

  test("never throws for arbitrary token lists", () => {
    const junk = [["--"], ["--state"], ["--reason="], ["-x"], ["list", "--json=1"], ["\u0000"]];
    for (const tokens of junk) expect(() => parseProposalsArgs(tokens, GLOBALS)).not.toThrow();
  });

  test("valid invocations for all four sub-verbs", () => {
    expect(PROPOSALS_SUBVERBS).toEqual(["list", "show", "apply", "reject"]);
    const list = parseProposalsArgs(["list", "--state", "applied", "--proposals-dir", "/p"], GLOBALS);
    expect(list).toMatchObject({ ok: true, version: false, invocation: { sub: "list", state: "applied", proposalsDirFlag: "/p" } });
    const listAll = parseProposalsArgs(["list"], GLOBALS);
    expect(listAll.ok && !listAll.version && listAll.invocation).toEqual({ sub: "list", state: null });
    expect(parseProposalsArgs(["--json", "show", ID], GLOBALS)).toMatchObject({ ok: true, invocation: { sub: "show", id: ID } });
    const apply = parseProposalsArgs(["apply", ID], GLOBALS);
    expect(apply.ok && !apply.version && apply.invocation).toEqual({ sub: "apply", id: ID, overlay: null });
    expect(parseProposalsArgs(["apply", ID, "--overlay", "o.yaml"], GLOBALS)).toMatchObject({
      invocation: { overlay: "o.yaml" },
    });
    expect(parseProposalsArgs(["reject", ID, "--reason", `  ${REASON}  `], GLOBALS)).toMatchObject({
      invocation: { sub: "reject", id: ID, reason: REASON },
    });
  });

  test("--version short-circuits in any position", () => {
    expect(parseProposalsArgs(["list", "--version"], GLOBALS)).toMatchObject({ ok: true, version: true });
    expect(parseProposalsArgs(["--version"], GLOBALS)).toMatchObject({ ok: true, version: true });
  });

  test("a dash-leading reason must use --reason=… (08 §2.3)", () => {
    expect(parseProposalsArgs(["reject", ID, "--reason", "-starts with a dash"], GLOBALS).ok).toBe(false);
    expect(parseProposalsArgs(["reject", ID, "--reason=-starts with a dash"], GLOBALS)).toMatchObject({
      invocation: { reason: "-starts with a dash" },
    });
  });

  test("validateRejectReason bounds: 9 and 501 code points refused, 10 and 500 accepted, bidi refused", () => {
    expect(validateRejectReason("x".repeat(9))).toMatchObject({ ok: false });
    expect(validateRejectReason("x".repeat(10))).toBe("x".repeat(10));
    expect(validateRejectReason("é".repeat(500))).toBe("é".repeat(500));
    expect(validateRejectReason("x".repeat(501))).toMatchObject({ ok: false });
    expect(validateRejectReason("abc‮defghijk")).toMatchObject({ ok: false });
    expect(validateRejectReason(undefined)).toMatchObject({ ok: false });
  });
});

describe("pulse proposals via runCli — usage faults exit 2 with empty stdout (REQ-PROP-07)", () => {
  for (const [name, tokens, stem] of USAGE_CASES) {
    test(`${name}`, async () => {
      const r = await runCli(["proposals", ...tokens, "--json"], { cwd: cwdWith() });
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("usage error");
      expect(r.stderr).toContain(stem);
    });
  }

  test("`pulse render foo` still exits 2 (positionals stay off for other verbs)", async () => {
    const r = await runCli(["render", "foo"], { cwd: cwdWith() });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
  });

  test("`pulse proposals list --version` prints the version", async () => {
    const r = await runCli(["proposals", "list", "--version"], { cwd: cwdWith() });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toStartWith("pulse ");
  });

  test("`pulse` with no command lists proposals among the verbs", async () => {
    const r = await runCli([], { cwd: cwdWith() });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("coverage, proposals");
  });
});

describe("resolveConfig — proposalsDir precedence (REQ-PROP-11)", () => {
  test("absent (not undefined) when no source sets it", () => {
    const c = resolveConfig({ flags: flags(), env: {}, cwd: cwdWith() });
    expect("proposalsDir" in c).toBe(false);
  });

  test("file proposalsDir resolves absolute against cwd", () => {
    const cwd = cwdWith("proposalsDir: props\n");
    expect(resolveConfig({ flags: flags(), env: {}, cwd }).proposalsDir).toBe(join(cwd, "props"));
  });

  test("PULSE_PROPOSALS_DIR beats the file; an empty value falls through", () => {
    const cwd = cwdWith("proposalsDir: from-file\n");
    expect(resolveConfig({ flags: flags(), env: { PULSE_PROPOSALS_DIR: "from-env" }, cwd }).proposalsDir).toBe(
      join(cwd, "from-env"),
    );
    expect(resolveConfig({ flags: flags(), env: { PULSE_PROPOSALS_DIR: "" }, cwd }).proposalsDir).toBe(
      join(cwd, "from-file"),
    );
    expect("proposalsDir" in resolveConfig({ flags: flags(), env: { PULSE_PROPOSALS_DIR: "" }, cwd: cwdWith() })).toBe(
      false,
    );
  });

  test("--proposals-dir beats env and file; absolute paths are kept", () => {
    const cwd = cwdWith("proposalsDir: from-file\n");
    const c = resolveConfig({
      flags: flags(),
      proposalsDirFlag: "/abs/flag",
      env: { PULSE_PROPOSALS_DIR: "from-env" },
      cwd,
    });
    expect(c.proposalsDir).toBe("/abs/flag");
  });

  test("a non-string proposalsDir is a config fault", () => {
    expect(() => resolveConfig({ flags: flags(), env: {}, cwd: cwdWith("proposalsDir: 3\n") })).toThrow(ConfigIoError);
  });
});

describe("secret is env-only (REQ-SEC-04)", () => {
  test("a pulse.config.yaml `proposalSecret` key makes `pulse validate` exit 2 naming the key, never the value", async () => {
    const r = await runCli(["validate"], { cwd: cwdWith("proposalSecret: xyz\n") });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("proposalSecret");
    expect(r.stderr).not.toContain("xyz");
  });

  test("readProposalSecret: unset/empty/31 bytes throw ConfigIoError without the value; 32 UTF-8 bytes pass", () => {
    expect(() => readProposalSecret({})).toThrow(ConfigIoError);
    expect(() => readProposalSecret({ [PROPOSAL_SECRET_ENV]: "" })).toThrow(ConfigIoError);
    const short = "q".repeat(31);
    try {
      readProposalSecret({ [PROPOSAL_SECRET_ENV]: short });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigIoError);
      expect((err as Error).message).toContain("31 bytes");
      expect((err as Error).message).not.toContain(short);
    }
    // 16 × "é" = 16 code points but 32 UTF-8 bytes (TextEncoder, like the web's loadProposalSecret).
    expect(readProposalSecret({ [PROPOSAL_SECRET_ENV]: "é".repeat(16) })).toEqual(new TextEncoder().encode("é".repeat(16)));
    expect(() => readProposalSecret({ [PROPOSAL_SECRET_ENV]: "é".repeat(15) })).toThrow(ConfigIoError);
  });

  test("requireProposalsDir: unset → INVALID_ARG, missing → DIR_NOT_FOUND, a file → NOT_A_DIRECTORY", () => {
    const code = (fn: () => unknown): string | null => {
      try {
        fn();
        return null;
      } catch (err) {
        return err instanceof ConfigIoError ? err.code : "other";
      }
    };
    const file = join(root, "a-file");
    writeFileSync(file, "x");
    expect(code(() => requireProposalsDir(undefined))).toBe("INVALID_ARG");
    expect(code(() => requireProposalsDir(join(root, "nope")))).toBe("DIR_NOT_FOUND");
    expect(code(() => requireProposalsDir(file))).toBe("NOT_A_DIRECTORY");
    expect(requireProposalsDir(proposalsDir)).toBe(proposalsDir);
  });

  const secretFaults: readonly (readonly [string, readonly string[], NodeJS.ProcessEnv])[] = [
    ["no proposals dir configured", [], { [PROPOSAL_SECRET_ENV]: SECRET }],
    ["a missing proposals dir", ["--proposals-dir", "/definitely/not/here"], { [PROPOSAL_SECRET_ENV]: SECRET }],
    ["the secret unset", ["--proposals-dir", "<dir>"], {}],
    ["the secret shorter than 32 UTF-8 bytes", ["--proposals-dir", "<dir>"], { [PROPOSAL_SECRET_ENV]: SECRET.slice(0, 31) }],
  ];
  for (const [name, extra, env] of secretFaults) {
    test(`\`pulse proposals list\` with ${name} exits 2 (ConfigIoError) and stderr never holds the secret`, async () => {
      const args = ["proposals", "list", "--json", ...extra.map((a) => (a === "<dir>" ? proposalsDir : a))];
      const r = await runCli(args, { cwd: cwdWith(), env });
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("config error");
      expect(r.stderr).not.toContain(SECRET.slice(0, 31));
    });
  }

  test("with dir + secret the dispatcher routes apply; an estate outside any git repo is a labelled tool fault", async () => {
    const r = await runCli(["proposals", "apply", ID, "--proposals-dir", proposalsDir], {
      cwd: cwdWith(),
      env: { [PROPOSAL_SECRET_ENV]: SECRET },
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("proposal tool fault [git-status]");
    expect(r.stderr).not.toContain(SECRET);
  });

  test("PULSE_PROPOSALS_DIR from the env reaches the dispatcher", async () => {
    const r = await runCli(["proposals", "show", ID], {
      cwd: cwdWith(),
      env: { [PROPOSAL_SECRET_ENV]: SECRET, PULSE_PROPOSALS_DIR: proposalsDir },
    });
    // The (empty) env-configured dir was read: an unknown id is PROPOSAL_NOT_FOUND, not a config fault.
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(FINDING_CODES.PROPOSAL_NOT_FOUND);
  });
});

describe("PROPOSAL_* finding builders (REQ-PROP-07, 08 §11.2)", () => {
  const payload: ProposalPayload = {
    id: ID,
    createdAt: "2026-09-28T10:15:00.000Z",
    requestId: "req-1",
    proposer: { subject: "ada", displayName: "Ada \u001b[31mOps" },
    target: { kind: "host", id: "host:app-01", name: "app\u001b[31m-01‮" },
    changes: [{ field: "expectedChurn", seen: false, proposed: true }],
    rationale: "mark it as expected churn please",
  };
  const change = payload.changes[0]!;
  const applied: ProposalResultV1 = {
    format: "pulse-proposal-result/v1",
    id: ID,
    state: "applied",
    at: "2026-09-29T00:00:00.000Z",
    by: "gary",
    commit: "3f9c2e1aa0000000000000000000000000000000",
  };
  const rejected: ProposalResultV1 = {
    format: "pulse-proposal-result/v1",
    id: ID,
    state: "rejected",
    at: "2026-09-29T00:00:00.000Z",
    by: "gary",
    reason: REASON,
  };

  const errorBuilders: readonly (readonly [string, Finding, string])[] = [
    ["notFoundFinding", notFoundFinding(ID), FINDING_CODES.PROPOSAL_NOT_FOUND],
    ["signatureInvalidFinding", signatureInvalidFinding(ID, "signature"), FINDING_CODES.PROPOSAL_SIGNATURE_INVALID],
    ["dirtyTreeFinding", dirtyTreeFinding(["a.yaml"], ["b.yaml"]), FINDING_CODES.PROPOSAL_DIRTY_TREE],
    ["staleFinding", staleFinding("10-monitoring.overlay.yaml", payload, change, true), FINDING_CODES.PROPOSAL_STALE],
    ["staleInapplicableFinding", staleInapplicableFinding("x.yaml", payload, change), FINDING_CODES.PROPOSAL_STALE],
    ["staleTargetGoneFinding", staleTargetGoneFinding(payload), FINDING_CODES.PROPOSAL_STALE],
    [
      "cannotClearBaseFinding",
      cannotClearBaseFinding("10-monitoring.overlay.yaml", "hosts", "app-01", "scrape_interval_class"),
      FINDING_CODES.PROPOSAL_CANNOT_CLEAR_BASE,
    ],
    ["invalidEstateFinding", invalidEstateFinding("after", payload, "o.yaml"), FINDING_CODES.PROPOSAL_INVALID_ESTATE],
  ];

  for (const [name, f, code] of errorBuilders) {
    test(`${name} is severity error with code ${code}`, () => {
      expect(f.severity).toBe("error");
      expect(f.code).toBe(code as Finding["code"]);
    });
  }

  test("file/path columns follow 08 §11.1", () => {
    expect(notFoundFinding(ID)).toMatchObject({ file: `${ID}.proposal.json`, path: "" });
    expect(signatureInvalidFinding(ID, "not-a-file")).toMatchObject({ file: `${ID}.proposal.json`, path: "" });
    expect(signatureInvalidFinding(ID, "not-a-file").message).toContain("not-a-file");
    // An unreadable sidecar is not a signature problem: the hint names the sidecar, not the secret.
    expect(signatureInvalidFinding(ID, "result-invalid").fix).toContain(`${ID}.result.json`);
    expect(signatureInvalidFinding(ID, "result-invalid").fix).not.toContain("PULSE_PROPOSAL_SECRET");
    expect(dirtyTreeFinding(["a"], [])).toMatchObject({ file: "", path: "" });
    expect(staleFinding("10-monitoring.overlay.yaml", payload, change, true)).toMatchObject({
      file: "10-monitoring.overlay.yaml",
      path: "expected_churn",
      message: "expectedChurn: seen false, current true",
    });
    expect(cannotClearBaseFinding("o.yaml", "hosts", "app-01", "scrape_interval_class")).toMatchObject({
      file: "o.yaml",
      path: "hosts.app-01.scrape_interval_class",
    });
    expect(invalidEstateFinding("before", payload).file).toBe("");
  });

  test("dirtyTreeFinding lists ≤ 50 paths then '… and N more'", () => {
    const paths = Array.from({ length: 60 }, (_, i) => `estate/f${i}.yaml`);
    const f = dirtyTreeFinding(paths.slice(0, 5), paths.slice(5));
    expect(f.message).toContain("estate/f49.yaml");
    expect(f.message).not.toContain("estate/f50.yaml");
    expect(f.message).toContain("… and 10 more");
  });

  test("control characters in proposal text never reach message or fix (REQ-SEC-07)", () => {
    const all = [
      staleTargetGoneFinding(payload),
      staleInapplicableFinding("x", payload, change),
      invalidEstateFinding("render", payload),
      proposalFinding(FINDING_CODES.PROPOSAL_STALE, "error", "", "", "a\u001b[31mb\r\nc", "d\u009be⁦f"),
    ];
    for (const f of all) {
      expect(f.message).not.toContain("\u001b[31m");
      expect(`${f.message}${f.fix}`).not.toMatch(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/);
    }
    expect(staleTargetGoneFinding(payload).message).toContain("host app[31m-01");
    expect(stripControl("a\r\nb\tc", true)).toBe("a\nb c");
    expect(stripControl(" a\n\nb ")).toBe("a b");
  });

  test("alreadyDecided: one INFO PROPOSAL_ALREADY_DECIDED finding, exit-0 data per 00 §11.4 (REQ-PROP-10)", () => {
    const a = alreadyDecided("apply", applied);
    expect(a.findings).toHaveLength(1);
    expect(a.findings[0]).toMatchObject({
      severity: "info",
      code: FINDING_CODES.PROPOSAL_ALREADY_DECIDED,
      file: `${ID}.result.json`,
      path: "",
      message: `Proposal ${ID} is already applied (commit 3f9c2e1); nothing changed.`,
    });
    expect(a.outcomeFailed).toBe(false);
    expect(a.data).toEqual({
      verb: "apply",
      id: ID,
      state: "applied",
      commit: applied.commit,
      reason: null,
      changedFiles: [],
      alreadyDecided: true,
    });

    expect(alreadyDecided("apply", applied, true).findings[0]!.message).toContain(
      "recorded the missing applied result for commit 3f9c2e1",
    );

    const r = alreadyDecided("reject", rejected);
    expect(r.findings[0]!.severity).toBe("info");
    expect(r.findings[0]!.message).toContain(`already rejected: ${REASON}`);
    expect(r.data).toEqual({ verb: "reject", id: ID, state: "rejected", commit: null, reason: REASON, alreadyDecided: true });

    expect(alreadyDecided("reject", applied).data).toMatchObject({ verb: "reject", state: "applied", commit: applied.commit, reason: null });
    expect(alreadyDecided("apply", rejected).data).toMatchObject({ verb: "apply", state: "rejected", commit: null, reason: REASON });
  });

  test("refused wraps one finding with null data", () => {
    const f = notFoundFinding(ID);
    expect(refused(f)).toEqual({ findings: [f], data: null, outcomeFailed: false });
  });

  test("ProposalToolError carries its step and code", () => {
    const e = new ProposalToolError("git-commit", "hook rejected");
    expect(e).toBeInstanceOf(ProposalToolError);
    expect(e).toMatchObject({ step: "git-commit", code: "PROPOSAL_TOOL_FAULT", name: "ProposalToolError" });
  });
});

// ── list / show (item 039) ────────────────────────────────────────────────────────────────

/** A valid signed payload for host app-01 of the overlay-estate fixture. */
function lsPayload(id: string, createdAt: string, over: Partial<ProposalPayload> = {}): ProposalPayload {
  return {
    id,
    createdAt,
    requestId: "req-0001",
    proposer: { subject: "ada", displayName: "Ada Ops" },
    target: { kind: "host", id: "host:app-01", name: "app-01" },
    changes: [{ field: "expectedChurn", seen: false, proposed: true }],
    rationale: "Nightly rebuilds churn this host on purpose.",
    ...over,
  };
}

/** Hand-sign a file whose payload the schema refuses (signProposal would throw). */
function writeHandSigned(dir: string, payload: unknown, secret: string): string {
  const id = (payload as { id: string }).id;
  const mac = createHmac("sha256", new TextEncoder().encode(secret))
    .update(canonicalProposalJson({ format: "pulse-proposal/v1", payload } as never))
    .digest("base64url");
  const path = join(dir, pFileName(id));
  writeFileSync(path, JSON.stringify({ format: "pulse-proposal/v1", payload, signature: { alg: "HMAC-SHA256", value: mac } }));
  return path;
}

const ID_A = "p-20260927T080000Z-0f0e0d0c"; // oldest
const ID_B = "p-20260928T101500Z-1a2b3c4d";
const ID_C = "p-20260928T101500Z-9a9b9c9d"; // same createdAt as B, larger id → before B
const ID_D = "p-20260929T000000Z-00000001"; // newest
const TAMPERED = "p-20260926T000000Z-deadbeef";
const WRONG_KEY = "p-20260926T000000Z-0badc0de";
const SYMLINKED = "p-20260926T000000Z-51111111";
const COMMIT = "3f9c2e1a4b5c6d7e8f901234567890abcdef1234";
const TAMPER_RATIONALE = "Forged rationale marker that must never print.";

function sidecar(dir: string, result: ProposalResultV1): void {
  writeFileSync(join(dir, resultFileName(result.id)), JSON.stringify(result));
}

describe("pulse proposals list/show (REQ-PROP-07, REQ-PROP-11, REQ-SEC-05)", () => {
  let est: TempGitEstate;
  let dir: string;

  beforeAll(async () => {
    est = await tempGitEstate();
    dir = est.proposalsDir;
    writeSignedProposal(dir, lsPayload(ID_A, "2026-09-27T08:00:00.000Z"), TEST_SECRET);
    writeSignedProposal(dir, lsPayload(ID_B, "2026-09-28T10:15:00.000Z"), TEST_SECRET);
    writeSignedProposal(dir, lsPayload(ID_C, "2026-09-28T10:15:00.000Z"), TEST_SECRET);
    writeSignedProposal(dir, lsPayload(ID_D, "2026-09-29T00:00:00.000Z"), TEST_SECRET);
    sidecar(dir, { format: "pulse-proposal-result/v1", id: ID_A, state: "rejected", at: "2026-09-27T09:00:00.000Z", by: "Bo Admin", reason: REASON });
    sidecar(dir, { format: "pulse-proposal-result/v1", id: ID_C, state: "applied", at: "2026-09-28T11:00:00.000Z", by: "Bo Admin", commit: COMMIT });

    // Tampered: signed, then the payload rationale edited.
    const tp = writeSignedProposal(dir, lsPayload(TAMPERED, "2026-09-26T00:00:00.000Z"), TEST_SECRET);
    const tf = JSON.parse(readFileSync(tp, "utf8"));
    tf.payload.rationale = TAMPER_RATIONALE;
    writeFileSync(tp, JSON.stringify(tf));
    // Signed with a different (valid-length) secret.
    writeSignedProposal(dir, lsPayload(WRONG_KEY, "2026-09-26T00:00:00.000Z"), `${TEST_SECRET}-other`);
    // A symlink named like a proposal, pointing at a valid proposal elsewhere.
    const outside = mkdtempSync(join(tmpdir(), "pulse-proposal-link-"));
    const target = writeSignedProposal(outside, lsPayload(SYMLINKED, "2026-09-26T00:00:00.000Z"), TEST_SECRET);
    symlinkSync(target, join(dir, pFileName(SYMLINKED)));
    // Noise the reader must ignore.
    writeFileSync(join(dir, "README.txt"), "not a proposal");
    writeFileSync(join(dir, `.${resultFileName(ID_B)}.tmp-abcd`), "{");
  });
  afterAll(() => est.cleanup());

  const cli = (args: string[], env: NodeJS.ProcessEnv = TEST_ENV) => runCli(["proposals", ...args], { cwd: est.root, env });

  test("tempGitEstate: exactly one commit, clean status, untracked proposals dir", () => {
    expect(git(est.root, "rev-list", "--count", "HEAD").trim()).toBe("1");
    expect(git(est.root, "ls-files", "proposals").trim()).toBe("");
    expect(git(est.root, "ls-files", "estate", "rendered").trim().split("\n").length).toBeGreaterThan(2);
  });

  test("tempGitEstate: a fresh repo has a clean `git status --porcelain`; cleanup removes the root", async () => {
    const t = await tempGitEstate();
    expect(git(t.root, "status", "--porcelain")).toBe("");
    expect(git(t.root, "rev-list", "--count", "HEAD").trim()).toBe("1");
    expect(existsSync(join(t.outputRoot, "web-estate-model.json"))).toBe(true);
    t.cleanup();
    expect(existsSync(t.root)).toBe(false);
  });

  test("list: newest first (createdAt desc, then id desc) with sidecar-derived state (REQ-PROP-07)", async () => {
    const r = await cli(["list", "--json"]);
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.command).toBe("proposals");
    expect(env.data.verb).toBe("list");
    expect(env.data.proposals.map((p: { id: string }) => p.id)).toEqual([ID_D, ID_C, ID_B, ID_A]);
    expect(env.data.proposals.map((p: { state: string }) => p.state)).toEqual(["pending", "applied", "pending", "rejected"]);
    expect(env.data.proposals[0]).toEqual({
      id: ID_D,
      createdAt: "2026-09-29T00:00:00.000Z",
      proposer: "Ada Ops",
      target: { kind: "host", id: "host:app-01", name: "app-01" },
      fields: ["expectedChurn"],
      state: "pending",
    });
  });

  test("list --state filters by sidecar-derived state", async () => {
    const ids = async (state: string) =>
      JSON.parse((await cli(["list", "--state", state, "--json"])).stdout).data.proposals.map((p: { id: string }) => p.id);
    expect(await ids("pending")).toEqual([ID_D, ID_B]);
    expect(await ids("applied")).toEqual([ID_C]);
    expect(await ids("rejected")).toEqual([ID_A]);
  });

  test("tampered, wrong-secret and symlinked files are reported in data.invalid and list exits 0 (REQ-SEC-05)", async () => {
    const r = await cli(["list", "--json"]);
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.findings).toEqual([]);
    expect(env.data.invalid).toEqual([
      { file: pFileName(WRONG_KEY), reason: "signature" },
      { file: pFileName(SYMLINKED), reason: "not-a-file" },
      { file: pFileName(TAMPERED), reason: "signature" },
    ]);
    expect(r.stderr).toContain("3 invalid proposal files skipped");
    expect(r.stderr).not.toContain(TAMPER_RATIONALE);
  });

  test("list --json stdout is a single parseable envelope", async () => {
    const r = await cli(["list", "--json"]);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    const env = JSON.parse(r.stdout);
    expect(env).toMatchObject({ ok: true, exitCode: 0, command: "proposals", data: { verb: "list" } });
  });

  test("text-mode list writes nothing to stdout and prints the table to stderr", async () => {
    const r = await cli(["list"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^ID\s+STATE\s+TARGET\s+FIELDS\s+PROPOSER$/m);
    expect(r.stderr).toMatch(new RegExp(`^${ID_C}\\s+applied\\s+host app-01\\s+expectedChurn\\s+Ada Ops$`, "m"));
  });

  test("show: prints the verified proposal and returns the payload", async () => {
    const r = await cli(["show", ID_C, "--json"]);
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.data.verb).toBe("show");
    expect(env.data.proposal).toMatchObject({ id: ID_C, state: "applied", payload: { id: ID_C, rationale: lsPayload(ID_C, "x").rationale } });
    const text = await cli(["show", ID_C]);
    expect(text.stderr).toContain(`commit    ${COMMIT}`);
    expect(text.stderr).toContain("Nightly rebuilds churn this host on purpose.");
  });

  test("show of a tampered file exits 1 with PROPOSAL_SIGNATURE_INVALID and prints no payload (REQ-SEC-05)", async () => {
    for (const args of [["show", TAMPERED], ["show", TAMPERED, "--json"]]) {
      const r = await cli(args);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain(FINDING_CODES.PROPOSAL_SIGNATURE_INVALID);
      expect(r.stdout).not.toContain(TAMPER_RATIONALE);
      expect(r.stderr).not.toContain(TAMPER_RATIONALE);
      expect(r.stdout).not.toContain("Nightly rebuilds");
      expect(r.stderr).not.toContain("Nightly rebuilds");
    }
    const env = JSON.parse((await cli(["show", TAMPERED, "--json"])).stdout);
    expect(env.data).toBeNull();
    expect(env.findings.map((f: Finding) => f.code)).toEqual([FINDING_CODES.PROPOSAL_SIGNATURE_INVALID]);
  });

  test("show of an unknown well-formed id exits 1 with PROPOSAL_NOT_FOUND", async () => {
    const r = await cli(["show", "p-20200101T000000Z-00000000", "--json"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).findings.map((f: Finding) => f.code)).toEqual([FINDING_CODES.PROPOSAL_NOT_FOUND]);
  });

  test("display names with ESC and U+202E never reach stderr (REQ-SEC-07)", async () => {
    const d = mkdtempSync(join(tmpdir(), "pulse-proposals-ctl-"));
    try {
      // Valid (identity fields may carry bidi controls): listed, with U+202E stripped.
      const bidi = "p-20260930T000000Z-0000b1d1";
      writeSignedProposal(
        d,
        lsPayload(bidi, "2026-09-30T00:00:00.000Z", {
          proposer: { subject: "eve", displayName: "Eve‮[31mRed" },
          rationale: "Line one\nline two of the rationale.",
        }),
        TEST_SECRET,
      );
      // Free text refuses bidi controls (core CONTROL_EXCEPT_LF_RE): a bidi rationale is schema-invalid.
      const bidiRat = "p-20260930T000000Z-0000b1d2";
      writeHandSigned(d, { ...lsPayload(bidiRat, "2026-09-30T00:00:00.000Z"), rationale: "Looks fine‮ but reads reversed." }, TEST_SECRET);
      // ESC is refused by the schema, so the correctly-MACed file is invalid and its name never prints.
      const esc = "p-20260930T000000Z-0000e5c0";
      writeHandSigned(d, { ...lsPayload(esc, "2026-09-30T00:00:00.000Z"), proposer: { subject: "m", displayName: "Mal\u001b[31mlory‮" } }, TEST_SECRET);
      const r = await cli(["list", "--proposals-dir", d]);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain(bidi);
      expect(r.stderr).toContain("Eve[31mRed");
      expect(r.stderr).toContain(`${pFileName(esc)} (schema)`);
      expect(r.stderr).toContain(`${pFileName(bidiRat)} (schema)`);
      expect(r.stderr).not.toContain("\u001b");
      expect(r.stderr).not.toContain("‮");
      const s = await cli(["show", bidi, "--proposals-dir", d]);
      expect(s.exitCode).toBe(0);
      expect(s.stderr).toContain("  Line one\n  line two of the rationale.");
      expect(s.stderr).not.toContain("‮");
      expect(s.stderr).not.toContain("\u001b");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("a proposals dir outside the git repo works via --proposals-dir (REQ-PROP-11)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "pulse-proposals-outside-"));
    try {
      writeSignedProposal(outside, lsPayload(ID_B, "2026-09-28T10:15:00.000Z"), TEST_SECRET);
      const r = await cli(["list", "--proposals-dir", outside, "--json"]);
      expect(r.exitCode).toBe(0);
      const env = JSON.parse(r.stdout);
      expect(env.data.proposals.map((p: { id: string }) => p.id)).toEqual([ID_B]);
      expect(env.data.invalid).toEqual([]);
      expect(git(est.root, "status", "--porcelain", "--untracked-files=no")).toBe("");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("the secret never appears in list/show output (REQ-SEC-04)", async () => {
    for (const args of [["list"], ["list", "--json"], ["show", ID_B], ["show", ID_B, "--json"], ["show", TAMPERED]]) {
      const r = await cli(args);
      expect(r.stdout).not.toContain(TEST_SECRET);
      expect(r.stderr).not.toContain(TEST_SECRET);
    }
  });

  test("an empty proposals dir lists nothing and exits 0", async () => {
    const empty = mkdtempSync(join(tmpdir(), "pulse-proposals-empty-"));
    try {
      const r = await cli(["list", "--proposals-dir", empty, "--json"]);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout).data).toEqual({ verb: "list", proposals: [], invalid: [] });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("proposals dir.ts reader (08 §3.1, REQ-SEC-05)", () => {
  const secret = new TextEncoder().encode(TEST_SECRET);
  let d: string;
  beforeAll(() => {
    d = mkdtempSync(join(tmpdir(), "pulse-proposals-dir-"));
  });
  afterAll(() => rmSync(d, { recursive: true, force: true }));

  test("idFromProposalFileName accepts only exact proposal file names", () => {
    expect(idFromProposalFileName(`${ID}.proposal.json`)).toBe(ID);
    for (const n of [`${ID}.result.json`, "x.proposal.json", `.${ID}.proposal.json`, `${ID}.proposal.json.tmp`, "README"]) {
      expect(idFromProposalFileName(n)).toBeNull();
    }
  });

  test("id-mismatch, oversize, invalid sidecar, and absent are classified", () => {
    // A valid file for ID_A saved under ID_B's name.
    const signed = readFileSync(writeSignedProposal(d, lsPayload(ID_A, "2026-09-27T08:00:00.000Z"), TEST_SECRET), "utf8");
    rmSync(join(d, pFileName(ID_A)));
    writeFileSync(join(d, pFileName(ID_B)), signed);
    expect(readProposal(d, ID_B, secret)).toEqual({ kind: "invalid", reason: "id-mismatch" });
    // Oversize → unparseable.
    writeFileSync(join(d, pFileName(ID_C)), " ".repeat(64 * 1024 + 1));
    expect(readProposal(d, ID_C, secret)).toEqual({ kind: "invalid", reason: "unparseable" });
    // Valid proposal with a bad sidecar → result-invalid.
    writeSignedProposal(d, lsPayload(ID_D, "2026-09-29T00:00:00.000Z"), TEST_SECRET);
    writeFileSync(join(d, resultFileName(ID_D)), JSON.stringify({ format: "pulse-proposal-result/v1", id: ID_D, state: "applied" }));
    expect(readProposal(d, ID_D, secret)).toEqual({ kind: "invalid", reason: "result-invalid" });
    expect(readProposal(d, "p-20200101T000000Z-00000000", secret)).toEqual({ kind: "absent" });
    expect(readProposalDir(d, secret).invalid.map((i) => i.reason)).toEqual(["id-mismatch", "unparseable", "result-invalid"]);
  });

  test("writeResultFile writes a sidecar readResult accepts and leaves no temp file", () => {
    const w = mkdtempSync(join(tmpdir(), "pulse-proposals-sidecar-"));
    try {
      writeSignedProposal(w, lsPayload(ID_B, "2026-09-28T10:15:00.000Z"), TEST_SECRET);
      const result: ProposalResultV1 = { format: "pulse-proposal-result/v1", id: ID_B, state: "applied", at: "2026-09-30T00:00:00.000Z", by: "Bo", commit: COMMIT };
      writeResultFile(w, result);
      expect(readResult(w, ID_B)).toEqual({ kind: "ok", result });
      const listing = readProposalDir(w, secret);
      expect(listing.proposals.map(toSummary)[0]!.state).toBe("applied");
      expect(readFileSync(join(w, resultFileName(ID_B)), "utf8").endsWith("\n")).toBe(true);
      expect(readdirSync(w).sort()).toEqual([pFileName(ID_B), resultFileName(ID_B)]);
    } finally {
      rmSync(w, { recursive: true, force: true });
    }
  });

  test("readProposalDir on a missing directory throws ProposalToolError io", () => {
    expect(() => readProposalDir(join(d, "nope"), secret)).toThrow(ProposalToolError);
  });
});

// ---------------------------------------------------------------------------------------------
// Item 040 — commit-message builder, git runner, overlay writer (08 §6, §7, §8).
// ---------------------------------------------------------------------------------------------

import { cpSync } from "node:fs";
import { realpathSync } from "node:fs";
import {
  COMMIT_WRAP_COLUMNS,
  TRAILER_VALUE_MAX_CHARS,
  buildCommitMessage,
  trailerValue,
  wrapText,
} from "../src/commands/proposals/commit-message.js";
import { openGit, runGit } from "../src/commands/proposals/git.js";
import type { GitRepo } from "../src/commands/proposals/git.js";
import { applyChangesToOverlay, locateOverlay } from "../src/commands/proposals/overlay-writer.js";
import { overlayAmbiguousFinding } from "../src/commands/proposals/findings.js";

const OVERLAY_FIXTURE = join(import.meta.dir, "../../../packages/core/tests/fixtures/overlay-estate");
const OVERLAY_FILE = "10-monitoring.overlay.yaml";
const BASE_FILE = "00-skeleton.base.yaml";
const EXAMPLE_ID = "p-20260928T101500Z-1a2b3c4d";

const EXAMPLE_MESSAGE = `estate: apply proposal ${EXAMPLE_ID} (host app-01)

app-01 runs batch jobs that recreate containers nightly; mark it as
expected churn so the churn alerts stop paging.

Proposal-Id: ${EXAMPLE_ID}
Proposed-By: Ada Ops
Changes: expectedChurn: false -> true
`;

function examplePayload(over: Partial<ProposalPayload> = {}): ProposalPayload {
  return lsPayload(EXAMPLE_ID, "2026-09-28T10:15:00.000Z", {
    rationale:
      "app-01 runs batch jobs that recreate containers nightly; mark it as expected churn so the churn alerts stop paging.",
    ...over,
  });
}

/** A throwaway repo with a local identity; `commit` = false leaves HEAD unborn. */
function tempRepo(commit = true): { dir: string; repo: GitRepo; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pulse-git-")));
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Test Operator");
  git(dir, "config", "user.email", "operator@example.test");
  git(dir, "config", "commit.gpgsign", "false");
  if (commit) {
    writeFileSync(join(dir, "README"), "seed\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "seed");
  }
  return { dir, repo: openGit(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function toolStep(fn: () => unknown): string | null {
  try {
    fn();
  } catch (err) {
    if (err instanceof ProposalToolError) return err.step;
    throw err;
  }
  return null;
}

describe("buildCommitMessage (08 §6, REQ-PROP-08 e)", () => {
  test("the 08 §6 example payload yields the exact example message", () => {
    expect(buildCommitMessage(examplePayload())).toBe(EXAMPLE_MESSAGE);
  });

  test("git interpret-trailers --parse returns exactly the three trailers (REQ-PROP-08 e)", () => {
    const p = Bun.spawnSync({
      cmd: ["git", "interpret-trailers", "--parse"],
      stdin: new TextEncoder().encode(buildCommitMessage(examplePayload())),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toBe(
      `Proposal-Id: ${EXAMPLE_ID}\nProposed-By: Ada Ops\nChanges: expectedChurn: false -> true\n`,
    );
  });

  test("controls are stripped and body lines wrap at 72 unless a single word (REQ-SEC-07)", () => {
    const long = "x".repeat(90);
    const rationale =
      "Red \x1b[31malert\x1b[0m text\r\nwith a CR line and a ‮reversed word plus enough filler words to force " +
      `several wraps of this long rationale paragraph ${long} and then some more trailing words here.\r\rSecond paragraph.`;
    const msg = buildCommitMessage(
      examplePayload({ rationale, proposer: { subject: "ada", displayName: "Ada‮ \x1b[1mOps" } }),
    );
    expect(msg).not.toContain("\x1b");
    expect(msg).not.toContain("\r");
    expect(msg).not.toContain("‮");
    const lines = msg.split("\n");
    for (const l of lines.slice(2)) {
      if (l.length > COMMIT_WRAP_COLUMNS) expect(l).not.toContain(" ");
    }
    expect(lines).toContain(long);
    expect(msg.trimEnd().split("\n\n").at(-1)!.startsWith(`Proposal-Id: ${EXAMPLE_ID}\n`)).toBe(true);
  });

  test("a rationale imitating a trailer stays in the body; the real trailer block is last", () => {
    const msg = buildCommitMessage(examplePayload({ rationale: "Looks fine to me.\n\nProposal-Id: p-20260101T000000Z-00000000" }));
    const paragraphs = msg.trimEnd().split("\n\n");
    expect(paragraphs.at(-1)).toBe(
      `Proposal-Id: ${EXAMPLE_ID}\nProposed-By: Ada Ops\nChanges: expectedChurn: false -> true`,
    );
  });

  test("wrapText and trailerValue", () => {
    expect(wrapText("a b c", 3)).toEqual(["a b", "c"]);
    expect(wrapText("   ")).toEqual([]);
    expect(wrapText(`${"w".repeat(80)} tail`)).toEqual(["w".repeat(80), "tail"]);
    expect(trailerValue({ rationale: "r", class: "known-expected" })).toBe(
      '{"class":"known-expected","rationale":"r"}',
    );
    const big = trailerValue({ class: "known-expected", rationale: "y".repeat(400) });
    expect([...big].length).toBe(TRAILER_VALUE_MAX_CHARS);
    expect(big.endsWith("…")).toBe(true);
  });
});

describe("git runner and repository handle (08 §7, REQ-PROP-08 e)", () => {
  test("findProposalCommit returns the trailer-carrying commit and null on an unborn HEAD (REQ-PROP-08 e)", () => {
    const unborn = tempRepo(false);
    try {
      expect(unborn.repo.findProposalCommit(EXAMPLE_ID)).toBeNull();
    } finally {
      unborn.cleanup();
    }
    const t = tempRepo();
    try {
      writeFileSync(join(t.dir, "estate.yaml"), "layer: overlay\n");
      t.repo.add(["estate.yaml"]);
      const sha = t.repo.commit(buildCommitMessage(examplePayload()));
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(git(t.dir, "rev-parse", "HEAD").trim()).toBe(sha);
      expect(t.repo.findProposalCommit(EXAMPLE_ID)).toBe(sha);
      expect(t.repo.findProposalCommit("p-20260928T101500Z-ffffffff")).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  test("an id only in a rationale `Proposal-Id:` body line is not found (REQ-PROP-08 e, REQ-SEC-07)", () => {
    const t = tempRepo();
    const forged = "p-20260101T000000Z-00000000";
    try {
      writeFileSync(join(t.dir, "estate.yaml"), "layer: overlay\n");
      t.repo.add(["estate.yaml"]);
      t.repo.commit(buildCommitMessage(examplePayload({ rationale: `Please apply.\nProposal-Id: ${forged}\n\nProposal-Id: ${forged}` })));
      expect(git(t.dir, "log", "-1", "--format=%B")).toContain(`Proposal-Id: ${forged}`);
      expect(t.repo.findProposalCommit(forged)).toBeNull();
      expect(t.repo.findProposalCommit(EXAMPLE_ID)).not.toBeNull();
    } finally {
      t.cleanup();
    }
  });

  test("staged / dirty / changed / untracked / tracked paths on a temp repo", () => {
    const t = tempRepo();
    try {
      mkdirSync(join(t.dir, "estate"));
      mkdirSync(join(t.dir, "proposals"));
      writeFileSync(join(t.dir, "estate/a.yaml"), "a: 1\n");
      writeFileSync(join(t.dir, "estate/b.yaml"), "b: 1\n");
      writeFileSync(join(t.dir, "proposals/x.json"), "{}\n");
      git(t.dir, "add", "-A");
      git(t.dir, "commit", "-q", "-m", "tree");
      expect(t.repo.stagedPaths()).toEqual([]);
      expect(t.repo.dirtyTrackedPaths(["."], [])).toEqual([]);

      writeFileSync(join(t.dir, "estate/a.yaml"), "a: 2\n");
      git(t.dir, "add", "estate/a.yaml"); // staged
      writeFileSync(join(t.dir, "estate/b.yaml"), "b: 2\n"); // modified tracked
      writeFileSync(join(t.dir, "estate/u.yaml"), "u: 1\n"); // untracked
      writeFileSync(join(t.dir, "proposals/x.json"), '{"x":1}\n'); // modified, excluded dir

      expect(t.repo.stagedPaths()).toEqual(["estate/a.yaml"]);
      expect(t.repo.dirtyTrackedPaths(["."], ["proposals"])).toEqual(["M  estate/a.yaml", " M estate/b.yaml"]);
      expect(t.repo.dirtyTrackedPaths(["."], [])).toContain(" M proposals/x.json");
      expect(t.repo.untrackedPaths("estate")).toEqual(["estate/u.yaml"]);
      expect(t.repo.changedPaths("estate").sort()).toEqual(["estate/a.yaml", "estate/b.yaml", "estate/u.yaml"]);
      expect(t.repo.isTracked("estate/b.yaml")).toBe(true);
      expect(t.repo.isTracked("estate/u.yaml")).toBe(false);

      t.repo.unstage(["estate/a.yaml"]);
      expect(t.repo.stagedPaths()).toEqual([]);
      t.repo.restoreWorktree("estate/a.yaml");
      t.repo.restoreWorktree("estate/u.yaml"); // untracked → skipped, not a fault
      expect(readFileSync(join(t.dir, "estate/a.yaml"), "utf8")).toBe("a: 1\n");
      expect(existsSync(join(t.dir, "estate/u.yaml"))).toBe(true);
      expect(t.repo.userName({})).toBe("Test Operator");
    } finally {
      t.cleanup();
    }
  });

  test("runGit's child env never contains PULSE_PROPOSAL_SECRET (REQ-SEC-04)", () => {
    const t = tempRepo();
    const prior = process.env["PULSE_PROPOSAL_SECRET"];
    process.env["PULSE_PROPOSAL_SECRET"] = TEST_SECRET;
    try {
      const r = runGit(t.dir, ["-c", "alias.envdump=!env", "envdump"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("LC_ALL=C");
      expect(r.stdout).toContain("GIT_TERMINAL_PROMPT=0");
      expect(r.stdout).not.toContain("PULSE_PROPOSAL_SECRET");
      expect(r.stdout).not.toContain(TEST_SECRET);
    } finally {
      if (prior === undefined) delete process.env["PULSE_PROPOSAL_SECRET"];
      else process.env["PULSE_PROPOSAL_SECRET"] = prior;
      t.cleanup();
    }
  });

  test("rel() outside the repo and openGit on a non-repo throw step git-status", () => {
    const t = tempRepo();
    const outside = mkdtempSync(join(tmpdir(), "pulse-nogit-"));
    try {
      expect(t.repo.rel(join(t.dir, "estate", "new.yaml"))).toBe("estate/new.yaml");
      expect(t.repo.relOrNull(outside)).toBeNull();
      expect(toolStep(() => t.repo.rel(outside))).toBe("git-status");
      expect(toolStep(() => openGit(outside))).toBe("git-status");
    } finally {
      rmSync(outside, { recursive: true, force: true });
      t.cleanup();
    }
  });

  test("git.ts wraps no push/fetch/pull/remote/stash/clean/checkout/--hard operation (REQ-PROP-08)", () => {
    const src = readFileSync(join(import.meta.dir, "../src/commands/proposals/git.ts"), "utf8");
    const forbidden = /["'`](?:push|fetch|pull|remote|stash|clean|checkout|reset|--hard)["'`]/;
    expect(forbidden.test(src)).toBe(false);
    expect(src).not.toContain("--hard");
    // self-test: the matcher does catch an argv literal
    expect(forbidden.test('runGit(root, ["push", "origin"])')).toBe(true);
  });
});

describe("overlay writer — locateOverlay (08 §8.2, REQ-PROP-08 c)", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pulse-overlay-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function estate(name: string, extraFiles: Record<string, string> = {}, dropOverlay = false): string {
    const d = join(dir, name);
    cpSync(OVERLAY_FIXTURE, d, { recursive: true });
    if (dropOverlay) rmSync(join(d, OVERLAY_FILE));
    for (const [f, text] of Object.entries(extraFiles)) writeFileSync(join(d, f), text);
    return d;
  }

  test("the owning overlay is chosen and base-declared keys are reported (REQ-PROP-08 c)", () => {
    const d = estate("owner");
    const r = locateOverlay({ estateDir: d, section: "hosts", name: "app-01", ownerFile: OVERLAY_FILE, overlayFlag: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file).toBe(OVERLAY_FILE);
    expect(r.absPath).toBe(join(d, OVERLAY_FILE));
    expect(r.hasEntry).toBe(true);
    expect([...r.baseDeclaredKeys].sort()).toEqual(["addresses", "collection_class", "delivery_form", "exporter_ports", "name"]);
    // the same file named via --overlay is fine
    const same = locateOverlay({ estateDir: d, section: "hosts", name: "app-01", ownerFile: OVERLAY_FILE, overlayFlag: OVERLAY_FILE });
    expect(same.ok).toBe(true);
  });

  test("a different --overlay than the owning overlay → PROPOSAL_OVERLAY_AMBIGUOUS (REQ-PROP-08 c)", () => {
    const d = estate("competing", { "20-extra.overlay.yaml": "layer: overlay\n" });
    const r = locateOverlay({
      estateDir: d,
      section: "hosts",
      name: "app-01",
      ownerFile: OVERLAY_FILE,
      overlayFlag: "20-extra.overlay.yaml",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.finding.code).toBe(FINDING_CODES.PROPOSAL_OVERLAY_AMBIGUOUS);
    expect(r.finding.severity).toBe("error");
    expect(r.finding.message).toContain(OVERLAY_FILE);
  });

  test("two overlay files and no flag → AMBIGUOUS listing both; --overlay selects one (REQ-PROP-08 c)", () => {
    const d = estate("two", {
      [BASE_FILE]: readFileSync(join(OVERLAY_FIXTURE, BASE_FILE), "utf8") +
        "  - name: db-01\n    collection_class: managed-linux\n    delivery_form: compose\n    addresses:\n      - 10.0.0.5\n",
      "20-extra.overlay.yaml": "layer: overlay\n",
    });
    const inp = { estateDir: d, section: "hosts" as const, name: "db-01", ownerFile: BASE_FILE, overlayFlag: null };
    const r = locateOverlay(inp);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.finding.code).toBe(FINDING_CODES.PROPOSAL_OVERLAY_AMBIGUOUS);
    expect(r.finding.message).toContain(OVERLAY_FILE);
    expect(r.finding.message).toContain("20-extra.overlay.yaml");

    const chosen = locateOverlay({ ...inp, overlayFlag: join(d, "20-extra.overlay.yaml") });
    expect(chosen.ok && chosen.file).toBe("20-extra.overlay.yaml");
    expect(chosen.ok && chosen.hasEntry).toBe(false);
    const notOverlay = locateOverlay({ ...inp, overlayFlag: BASE_FILE });
    expect(notOverlay.ok).toBe(false);
  });

  test("a single overlay is chosen for an entity only in the base; zero overlays → AMBIGUOUS (REQ-PROP-08 c)", () => {
    const one = estate("one");
    const r1 = locateOverlay({ estateDir: one, section: "services", name: "api", ownerFile: BASE_FILE, overlayFlag: null });
    expect(r1.ok && r1.file).toBe(OVERLAY_FILE);
    expect(r1.ok && r1.baseDeclaredKeys.size).toBe(0);

    const none = estate("none", {}, true);
    const r0 = locateOverlay({ estateDir: none, section: "hosts", name: "app-01", ownerFile: BASE_FILE, overlayFlag: null });
    expect(r0.ok).toBe(false);
    if (r0.ok) return;
    expect(r0.finding.code).toBe(FINDING_CODES.PROPOSAL_OVERLAY_AMBIGUOUS);
    expect(r0.finding).toEqual(overlayAmbiguousFinding("the estate has no layer: overlay file; create one or pass --overlay"));
    expect(r0.finding.file).toBe("");
    expect(r0.finding.path).toBe("");
  });
});

describe("overlay writer — applyChangesToOverlay (08 §8.3, REQ-PROP-08 c)", () => {
  const text = readFileSync(join(OVERLAY_FIXTURE, OVERLAY_FILE), "utf8");
  const base = new Set(["name", "collection_class", "delivery_form", "addresses", "exporter_ports"]);

  test("expectedChurn false→true and scrapeIntervalClass fast→null yields the 08 §8.3 example (REQ-PROP-08 c)", () => {
    const r = applyChangesToOverlay({
      text,
      file: OVERLAY_FILE,
      section: "hosts",
      name: "app-01",
      baseDeclaredKeys: base,
      changes: [
        { field: "expectedChurn", seen: false, proposed: true },
        { field: "scrapeIntervalClass", seen: "fast", proposed: null },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe(text.replace("    scrape_interval_class: fast\n", "    expected_churn: true\n"));
    const header = (s: string) => s.split("\n").filter((l) => l.startsWith("#"));
    expect(header(r.text)).toEqual(header(text));
    expect(header(r.text).length).toBe(6);
  });

  test("clearing a base-declared key → PROPOSAL_CANNOT_CLEAR_BASE with no text (REQ-PROP-08 c)", () => {
    const r = applyChangesToOverlay({
      text,
      file: OVERLAY_FILE,
      section: "hosts",
      name: "app-01",
      baseDeclaredKeys: new Set([...base, "scrape_interval_class"]),
      changes: [
        { field: "expectedChurn", seen: false, proposed: true },
        { field: "scrapeIntervalClass", seen: "fast", proposed: null },
      ],
    });
    expect(r.ok).toBe(false);
    expect("text" in r).toBe(false);
    if (r.ok) return;
    expect(r.finding.code).toBe(FINDING_CODES.PROPOSAL_CANNOT_CLEAR_BASE);
    expect(r.finding.file).toBe(OVERLAY_FILE);
    expect(r.finding.path).toBe("hosts.app-01.scrape_interval_class");
  });

  test("a missing section is created as a sequence with a new {name} item carrying a suppression mark", () => {
    const r = applyChangesToOverlay({
      text: "# overlay\nlayer: overlay\n",
      file: "20-extra.overlay.yaml",
      section: "services",
      name: "api",
      baseDeclaredKeys: new Set(),
      changes: [{ field: "suppressed", seen: null, proposed: { class: "known-expected", rationale: "Planned rebuild." } }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe(
      "# overlay\nlayer: overlay\nservices:\n  - name: api\n    suppressed:\n      class: known-expected\n      rationale: Planned rebuild.\n",
    );
  });

  test("a non-sequence section or unparseable text is a tool fault (io)", () => {
    const inp = { file: "x.yaml", section: "hosts" as const, name: "a", baseDeclaredKeys: new Set<string>(), changes: [] };
    expect(toolStep(() => applyChangesToOverlay({ ...inp, text: "hosts:\n  a: 1\n" }))).toBe("io");
    expect(toolStep(() => applyChangesToOverlay({ ...inp, text: "hosts: [\n" }))).toBe("io");
  });
});

// ── apply / reject (item 041; 08 §4, §5, §9, §10; 10 §3.5, §5.4) ─────────────────────────────────

import * as coreModule from "@pulse/core";
import * as rendererModule from "@pulse/renderer";
import { RenderIoError } from "@pulse/renderer";
import { chmodSync, readdirSync as readdirAll, statSync, unlinkSync } from "node:fs";
import { relative as relPath } from "node:path";
import * as gitModule from "../src/commands/proposals/git.js";
import { findEntity, sameValue } from "../src/commands/proposals/apply.js";
import { actorName } from "../src/commands/proposals/reject.js";

/** 08 §7.4: git operations no apply/reject may ever run. */
const FORBIDDEN_GIT = new Set(["push", "fetch", "pull", "remote", "clean", "stash", "checkout", "reset"]);
const OVERLAY_REL = "estate/10-monitoring.overlay.yaml";
const BASE_REL = "estate/00-skeleton.base.yaml";
const APPLY_TIMEOUT = 60_000;

/** A distinct valid proposal id per call. */
let idSeq = 0;
function nextId(): string {
  idSeq += 1;
  return `p-20260928T101500Z-${(0xa0000000 + idSeq).toString(16)}`;
}

/** Host app-01 expectedChurn false → true (current value in the fixture), overridable. */
function applyPayload(id: string, over: Partial<ProposalPayload> = {}): ProposalPayload {
  return lsPayload(id, "2026-09-28T10:15:00.000Z", {
    rationale: "app-01 runs batch jobs that recreate containers nightly; mark it as expected churn.",
    ...over,
  });
}

/** Service `api` on app-01, suppressed null → mark (needs {@link addService}). */
function servicePayload(id: string): ProposalPayload {
  return lsPayload(id, "2026-09-28T10:15:00.000Z", {
    target: { kind: "service", id: "svc:app-01/api", name: "api" },
    changes: [{ field: "suppressed", seen: null, proposed: { class: "known-expected", rationale: "The API is retired next week." } }],
  });
}

/** prepare(): a base-declared service `api` (the fixture has none; temp copy only). */
function addService(estateDir: string): void {
  const f = join(estateDir, "00-skeleton.base.yaml");
  writeFileSync(f, readFileSync(f, "utf8") + "\nservices:\n  - name: api\n    host: app-01\n    kind: http\n    managed: true\n");
}

/** prepare(): a second, empty overlay file. */
function addSecondOverlay(estateDir: string): void {
  writeFileSync(join(estateDir, "20-extra.overlay.yaml"), "# a second hand-written overlay\nlayer: overlay\n");
}

/** Parse a `--json` envelope. */
function envelope(stdout: string): { ok: boolean; exitCode: number; findings: Finding[]; data: Record<string, unknown> | null } {
  return JSON.parse(stdout);
}

/** Every file under `dir` → contents (for "tree identical" checks). */
function treeBytes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (d: string): void => {
    for (const e of readdirAll(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[relPath(dir, p)] = readFileSync(p, "latin1");
    }
  };
  walk(dir);
  return out;
}

/** Everything an apply could touch: work tree status, index, HEAD, overlay, rendered tree, proposals dir. */
function snapshot(est: TempGitEstate, proposals = est.proposalsDir) {
  return {
    head: git(est.root, "rev-parse", "HEAD").trim(),
    status: git(est.root, "status", "--porcelain=v1", "--untracked-files=all"),
    index: git(est.root, "ls-files", "-s"),
    estate: treeBytes(est.estateDir),
    rendered: treeBytes(est.outputRoot),
    proposals: treeBytes(proposals),
  };
}

const commitCount = (est: TempGitEstate): number => Number(git(est.root, "rev-list", "--count", "HEAD").trim());
const trackedStatus = (est: TempGitEstate): string => git(est.root, "status", "--porcelain", "--untracked-files=no");
const readSidecar = (dir: string, id: string): ProposalResultV1 => JSON.parse(readFileSync(join(dir, resultFileName(id)), "utf8"));
const codes = (fs: readonly Finding[]): string[] => fs.map((f) => f.code);

describe("pulse proposals apply/reject never run a network or destructive git operation (REQ-PROP-08, 08 §7.4)", () => {
  let runGitSpy: ReturnType<typeof spyOn<typeof gitModule, "runGit">>;
  beforeAll(() => {
    runGitSpy = spyOn(gitModule, "runGit"); // calls through; records argv of every runGit call
  });
  afterAll(() => runGitSpy.mockRestore());

  let est: TempGitEstate | null = null;
  const extraDirs: string[] = [];
  afterEach(() => {
    est?.cleanup();
    est = null;
    for (const d of extraDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const make = async (opts: Parameters<typeof tempGitEstate>[0] = {}): Promise<TempGitEstate> => {
    est = await tempGitEstate(opts);
    return est;
  };
  /** A proposals dir OUTSIDE the repo (REQ-PROP-11), so `git status --porcelain` can be asserted empty. */
  const outsideDir = (): string => {
    const d = mkdtempSync(join(tmpdir(), "pulse-proposals-out-"));
    extraDirs.push(d);
    return d;
  };
  const cli = (e: TempGitEstate, args: string[], env: NodeJS.ProcessEnv = TEST_ENV) =>
    runCli(["proposals", ...args], { cwd: e.root, env });

  describe("apply (REQ-PROP-01, REQ-PROP-08)", () => {
    test("happy path: exactly one commit holding only the overlay + changed rendered files; applied sidecar with that SHA (REQ-PROP-01, REQ-PROP-08 d/e/f)", async () => {
      const e = await make();
      const id = nextId();
      writeSignedProposal(e.proposalsDir, applyPayload(id), TEST_SECRET);
      const overlayBefore = readFileSync(join(e.root, OVERLAY_REL), "utf8");
      const countBefore = commitCount(e);

      const r = await cli(e, ["apply", id, "--json"]);
      expect(r.exitCode).toBe(0);
      expect(commitCount(e)).toBe(countBefore + 1);

      const env = envelope(r.stdout);
      expect(env.findings).toEqual([]);
      const head = git(e.root, "rev-parse", "HEAD").trim();
      expect(env.data).toMatchObject({ verb: "apply", id, state: "applied", commit: head, reason: null, alreadyDecided: false });

      const committed = git(e.root, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort();
      expect(committed).toEqual([...(env.data!["changedFiles"] as string[])].sort());
      expect(committed).toContain(OVERLAY_REL);
      expect(committed.length).toBeGreaterThan(1); // the re-render changed at least one artifact
      for (const f of committed) expect(f === OVERLAY_REL || f.startsWith("rendered/")).toBe(true);

      // Header comments byte-identical; the proposed key written.
      const overlayAfter = readFileSync(join(e.root, OVERLAY_REL), "utf8");
      const comments = (t: string) => t.split("\n").filter((l) => l.trimStart().startsWith("#"));
      expect(comments(overlayAfter)).toEqual(comments(overlayBefore));
      expect(overlayAfter.startsWith(overlayBefore.slice(0, overlayBefore.indexOf("layer:")))).toBe(true);
      expect(overlayAfter).toContain("expected_churn: true");

      const sc = readSidecar(e.proposalsDir, id);
      expect(sc).toMatchObject({ format: "pulse-proposal-result/v1", id, state: "applied", commit: head, by: "Pulse Test" });
      expect(head).toMatch(/^[0-9a-f]{40}$/);

      // Trailers parse, the tree is clean, nothing was pushed.
      expect(git(e.root, "log", "-1", "--format=%(trailers:key=Proposal-Id,valueonly)").trim()).toBe(id);
      expect(trackedStatus(e)).toBe("");
      expect(git(e.root, "remote").trim()).toBe("");
      expect(r.stderr).toContain(`applied ${id} (host app-01) in commit ${head.slice(0, 7)}`);
      expect(r.stderr).toContain("not pushed");
    }, APPLY_TIMEOUT);

    test("clearing an overlay-only key deletes it from the overlay (REQ-PROP-08 c)", async () => {
      const e = await make();
      const id = nextId();
      writeSignedProposal(
        e.proposalsDir,
        applyPayload(id, { changes: [{ field: "scrapeIntervalClass", seen: "fast", proposed: null }] }),
        TEST_SECRET,
      );
      const r = await cli(e, ["apply", id]);
      expect(r.exitCode).toBe(0);
      expect(readFileSync(join(e.root, OVERLAY_REL), "utf8")).not.toContain("scrape_interval_class");
    }, APPLY_TIMEOUT);

    test("a service proposal on a base-only service appends a services sequence to the single overlay (REQ-PROP-08 c)", async () => {
      const e = await make({ prepare: addService });
      const id = nextId();
      writeSignedProposal(e.proposalsDir, servicePayload(id), TEST_SECRET);
      const r = await cli(e, ["apply", id, "--json"]);
      expect(r.exitCode).toBe(0);
      const overlay = git(e.root, "show", `HEAD:${OVERLAY_REL}`);
      expect(overlay).toContain("services:\n  - name: api\n    suppressed:\n      class: known-expected\n");
      expect(git(e.root, "show", "--name-only", "--format=", "HEAD")).not.toContain(BASE_REL);
    }, APPLY_TIMEOUT);

    test("a same-named service on another host makes the estate invalid, so apply by name can never pick the wrong one", async () => {
      // Service `name` is the estate-wide identity: a second `api` (here on db-01) is a hard
      // DUPLICATE_IDENTITY, and apply refuses before resolving the target.
      const e = await make({ prepare: addService });
      writeFileSync(
        join(e.estateDir, "05-extra.base.yaml"),
        "layer: base\nhosts:\n  - name: db-01\n    collection_class: managed-linux\n    delivery_form: compose\n    addresses:\n      - 10.0.0.5\n    exporter_ports:\n      - 9100\nservices:\n  - name: api\n    host: db-01\n    kind: http\n    managed: true\n",
      );
      git(e.root, "add", "estate");
      git(e.root, "commit", "-q", "-m", "duplicate service name");
      const id = nextId();
      writeSignedProposal(e.proposalsDir, servicePayload(id), TEST_SECRET);
      const before = snapshot(e);
      const r = await cli(e, ["apply", id, "--json"]);
      expect(r.exitCode).toBe(1);
      const env = envelope(r.stdout);
      expect(codes(env.findings)).toContain(FINDING_CODES.PROPOSAL_INVALID_ESTATE);
      expect(codes(env.findings)).toContain(FINDING_CODES.DUPLICATE_IDENTITY);
      expect(snapshot(e)).toEqual(before);
    }, APPLY_TIMEOUT);

    test("(a0) a staged change anywhere → PROPOSAL_DIRTY_TREE listing it, exit 1, nothing committed (REQ-PROP-08 a0)", async () => {
      const e = await make();
      const id = nextId();
      writeSignedProposal(e.proposalsDir, applyPayload(id), TEST_SECRET);
      writeFileSync(join(e.root, "NOTES.md"), "unrelated\n");
      git(e.root, "add", "NOTES.md");
      const before = snapshot(e);
      const r = await cli(e, ["apply", id, "--json"]);
      expect(r.exitCode).toBe(1);
      const env = envelope(r.stdout);
      expect(codes(env.findings)).toEqual([FINDING_CODES.PROPOSAL_DIRTY_TREE]);
      expect(env.findings[0]!.message).toContain("NOTES.md");
      expect(snapshot(e)).toEqual(before);
    }, APPLY_TIMEOUT);

    for (const [what, rel] of [
      ["estate", BASE_REL],
      ["rendered", "rendered/web-estate-model.json"],
    ] as const) {
      test(`(a0) a modified tracked ${what} file → PROPOSAL_DIRTY_TREE listing its path (REQ-PROP-08 a0)`, async () => {
        const e = await make();
        const id = nextId();
        writeSignedProposal(e.proposalsDir, applyPayload(id), TEST_SECRET);
        writeFileSync(join(e.root, rel), readFileSync(join(e.root, rel), "utf8") + "\n");
        const before = snapshot(e);
        const r = await cli(e, ["apply", id, "--json"]);
        expect(r.exitCode).toBe(1);
        const env = envelope(r.stdout);
        expect(codes(env.findings)).toEqual([FINDING_CODES.PROPOSAL_DIRTY_TREE]);
        expect(env.findings[0]!.message).toContain(rel);
        expect(snapshot(e)).toEqual(before);
      }, APPLY_TIMEOUT);
    }

    test("(a0) untracked files elsewhere and edits under the proposals dir are allowed and never committed (REQ-PROP-08 a0)", async () => {
      const e = await make();
      // A tracked file under the proposals dir, then modified: excluded from the dirty check.
      writeFileSync(join(e.proposalsDir, "README.md"), "proposals inbox\n");
      git(e.root, "add", "-f", "proposals/README.md");
      git(e.root, "commit", "-q", "-m", "track proposals readme");
      writeFileSync(join(e.proposalsDir, "README.md"), "proposals inbox (edited)\n");
      writeFileSync(join(e.root, "scratch.txt"), "untracked\n");
      writeFileSync(join(e.estateDir, "draft.txt"), "untracked in estate\n");
      const id = nextId();
      writeSignedProposal(e.proposalsDir, applyPayload(id), TEST_SECRET);
      const r = await cli(e, ["apply", id, "--json"]);
      expect(r.exitCode).toBe(0);
      const committed = git(e.root, "show", "--name-only", "--format=", "HEAD");
      expect(committed).not.toContain("scratch.txt");
      expect(committed).not.toContain("draft.txt");
      expect(committed).not.toContain("proposals/");
      expect(readFileSync(join(e.proposalsDir, "README.md"), "utf8")).toBe("proposals inbox (edited)\n");
    }, APPLY_TIMEOUT);

    test("(a) forged / wrong-secret / edited-payload files → PROPOSAL_SIGNATURE_INVALID, exit 1, tree and proposals dir unchanged (REQ-PROP-08 a, REQ-SEC-05)", async () => {
      const e = await make();
      const forged = nextId();
      const p = writeSignedProposal(e.proposalsDir, applyPayload(forged), TEST_SECRET);
      const ff = JSON.parse(readFileSync(p, "utf8"));
      ff.signature.value = "A".repeat(43);
      writeFileSync(p, JSON.stringify(ff));
      const wrongKey = nextId();
      writeSignedProposal(e.proposalsDir, applyPayload(wrongKey), `${TEST_SECRET}-a-different-key`);
      const edited = nextId();
      const ep = writeSignedProposal(e.proposalsDir, applyPayload(edited), TEST_SECRET);
      const ef = JSON.parse(readFileSync(ep, "utf8"));
      ef.payload.changes[0].proposed = false;
      ef.payload.changes[0].seen = true;
      writeFileSync(ep, JSON.stringify(ef));

      for (const id of [forged, wrongKey, edited]) {
        const before = snapshot(e);
        const r = await cli(e, ["apply", id, "--json"]);
        expect(r.exitCode).toBe(1);
        const env = envelope(r.stdout);
        expect(codes(env.findings)).toEqual([FINDING_CODES.PROPOSAL_SIGNATURE_INVALID]);
        expect(env.findings[0]!.message).toContain("signature");
        expect(snapshot(e)).toEqual(before);
        expect(existsSync(join(e.proposalsDir, resultFileName(id)))).toBe(false);
      }
    }, APPLY_TIMEOUT);

    test("(b) an edited current value → PROPOSAL_STALE naming field, seen and current; nothing changed (REQ-PROP-08 b)", async () => {
      const e = await make();
      const f = join(e.root, OVERLAY_REL);
      writeFileSync(f, readFileSync(f, "utf8").replace("scrape_interval_class: fast", "scrape_interval_class: fast\n    expected_churn: true"));
      git(e.root, "commit", "-q", "-am", "hand edit: expected churn");
      const id = nextId();
      writeSignedProposal(e.proposalsDir, applyPayload(id), TEST_SECRET);
      const before = snapshot(e);
      const r = await cli(e, ["apply", id, "--json"]);
      expect(r.exitCode).toBe(1);
      const env = envelope(r.stdout);
      expect(codes(env.findings)).toEqual([FINDING_CODES.PROPOSAL_STALE]);
      expect(env.findings[0]!.message).toBe("expectedChurn: seen false, current true");
      expect(env.findings[0]!.file).toBe("10-monitoring.overlay.yaml");
      expect(env.findings[0]!.path).toBe("expected_churn");
      expect(snapshot(e)).toEqual(before);
    }, APPLY_TIMEOUT);

    test("(b) an inapplicable field and a vanished target → PROPOSAL_STALE (REQ-PROP-08 b)", async () => {
      const e = await make();
      const inapplicable = nextId();
      const mark = { class: "known-expected", rationale: "Host is noisy by design." } as const;
      writeSignedProposal(
        e.proposalsDir,
        applyPayload(inapplicable, {
          changes: [{ field: "suppressed", seen: mark, proposed: { ...mark, rationale: "Still noisy by design." } }],
        }),
        TEST_SECRET,
      );
      const gone = nextId();
      writeSignedProposal(e.proposalsDir, applyPayload(gone, { target: { kind: "host", id: "host:ghost-01", name: "ghost-01" } }), TEST_SECRET);
      for (const [id, stem] of [[inapplicable, "no longer applies"], [gone, "no longer exists"]] as const) {
        const before = snapshot(e);
        const r = await cli(e, ["apply", id, "--json"]);
        expect(r.exitCode).toBe(1);
        const env = envelope(r.stdout);
        expect(codes(env.findings)).toEqual([FINDING_CODES.PROPOSAL_STALE]);
        expect(env.findings[0]!.message).toContain(stem);
        expect(snapshot(e)).toEqual(before);
      }
    }, APPLY_TIMEOUT);

    test("(c) two overlays and no --overlay → PROPOSAL_OVERLAY_AMBIGUOUS; --overlay selects the named overlay (REQ-PROP-08 c)", async () => {
      const e = await make({ prepare: (d) => (addService(d), addSecondOverlay(d)) });
      const id = nextId();
      writeSignedProposal(e.proposalsDir, servicePayload(id), TEST_SECRET);
      const before = snapshot(e);
      const r1 = await cli(e, ["apply", id, "--json"]);
      expect(r1.exitCode).toBe(1);
      const env1 = envelope(r1.stdout);
      expect(codes(env1.findings)).toEqual([FINDING_CODES.PROPOSAL_OVERLAY_AMBIGUOUS]);
      expect(env1.findings[0]!.message).toContain("10-monitoring.overlay.yaml");
      expect(env1.findings[0]!.message).toContain("20-extra.overlay.yaml");
      expect(snapshot(e)).toEqual(before);

      const r2 = await cli(e, ["apply", id, "--overlay", "20-extra.overlay.yaml", "--json"]);
      expect(r2.exitCode).toBe(0);
      const changed = envelope(r2.stdout).data!["changedFiles"] as string[];
      expect(changed).toContain("estate/20-extra.overlay.yaml");
      expect(changed).not.toContain(OVERLAY_REL);
      expect(readFileSync(join(e.estateDir, "20-extra.overlay.yaml"), "utf8")).toContain("  - name: api\n");
    }, APPLY_TIMEOUT);

    test("(c) --overlay naming a different file than the owning overlay → PROPOSAL_OVERLAY_AMBIGUOUS (REQ-PROP-08 c)", async () => {
      const e = await make({ prepare: addSecondOverlay });
      const id = nextId();
      writeSignedProposal(e.proposalsDir, applyPayload(id), TEST_SECRET);
      const before = snapshot(e);
      const r = await cli(e, ["apply", id, "--overlay", "20-extra.overlay.yaml", "--json"]);
      expect(r.exitCode).toBe(1);
      expect(codes(envelope(r.stdout).findings)).toEqual([FINDING_CODES.PROPOSAL_OVERLAY_AMBIGUOUS]);
      expect(snapshot(e)).toEqual(before);
    }, APPLY_TIMEOUT);

    test("(c) clearing a base-declared key → PROPOSAL_CANNOT_CLEAR_BASE, nothing written (REQ-PROP-08 c)", async () => {
      const e = await make({
        prepare: (d) => {
          const f = join(d, "00-skeleton.base.yaml");
          writeFileSync(f, readFileSync(f, "utf8") + "    scrape_interval_class: slow\n");
        },
      });
      const id = nextId();
      writeSignedProposal(
        e.proposalsDir,
        applyPayload(id, { changes: [{ field: "scrapeIntervalClass", seen: "fast", proposed: null }] }),
        TEST_SECRET,
      );
      const before = snapshot(e);
      const r = await cli(e, ["apply", id, "--json"]);
      expect(r.exitCode).toBe(1);
      const env = envelope(r.stdout);
      expect(codes(env.findings)).toEqual([FINDING_CODES.PROPOSAL_CANNOT_CLEAR_BASE]);
      expect(env.findings[0]!.path).toBe("hosts.app-01.scrape_interval_class");
      expect(snapshot(e)).toEqual(before);
    }, APPLY_TIMEOUT);

    test("(d) an edit that invalidates the estate → PROPOSAL_INVALID_ESTATE plus the loader findings; `git status --porcelain` empty afterwards (REQ-PROP-08 d)", async () => {
      const e = await make();
      const dir = outsideDir();
      const id = nextId();
      writeSignedProposal(dir, applyPayload(id), TEST_SECRET);
      const loaderFinding: Finding = {
        severity: "error",
        code: FINDING_CODES.WRONG_TYPE,
        file: "10-monitoring.overlay.yaml",
        path: "hosts[0].expected_churn",
        message: "injected: the edited estate is invalid",
        fix: "n/a",
      };
      const real = coreModule.loadAndValidate;
      // The estate becomes invalid exactly when the overlay carries the proposed key.
      const spy = spyOn(coreModule, "loadAndValidate").mockImplementation((d: string) =>
        readFileSync(join(e.root, OVERLAY_REL), "utf8").includes("expected_churn")
          ? { ok: false, findings: [loaderFinding] }
          : real(d),
      );
      try {
        const before = snapshot(e, dir);
        const r = await cli(e, ["apply", id, "--proposals-dir", dir, "--json"]);
        expect(r.exitCode).toBe(1);
        const env = envelope(r.stdout);
        expect(codes(env.findings)).toEqual([FINDING_CODES.PROPOSAL_INVALID_ESTATE, FINDING_CODES.WRONG_TYPE]);
        expect(git(e.root, "status", "--porcelain")).toBe("");
        expect(snapshot(e, dir)).toEqual(before);
      } finally {
        spy.mockRestore();
      }
    }, APPLY_TIMEOUT);

    test("(d) an error-severity render finding → PROPOSAL_INVALID_ESTATE; overlay and outputRoot restored (REQ-PROP-08 d)", async () => {
      const e = await make();
      const dir = outsideDir();
      const id = nextId();
      writeSignedProposal(dir, applyPayload(id), TEST_SECRET);
      const renderFinding: Finding = {
        severity: "error",
        code: FINDING_CODES.SECRET_LITERAL,
        file: "10-monitoring.overlay.yaml",
        path: "channels[0].credential",
        message: "injected: refused a secret literal",
        fix: "n/a",
      };
      const real = rendererModule.renderOnly;
      const spy = spyOn(rendererModule, "renderOnly").mockImplementation(((...args: Parameters<typeof real>) => {
        const res = real(...args);
        return res.ok ? { ...res, findings: [...res.findings, renderFinding] } : res;
      }) as typeof real);
      try {
        const before = snapshot(e, dir);
        const r = await cli(e, ["apply", id, "--proposals-dir", dir, "--json"]);
        expect(r.exitCode).toBe(1);
        const env = envelope(r.stdout);
        expect(codes(env.findings)).toEqual([FINDING_CODES.PROPOSAL_INVALID_ESTATE, FINDING_CODES.SECRET_LITERAL]);
        expect(git(e.root, "status", "--porcelain")).toBe("");
        expect(snapshot(e, dir)).toEqual(before);
      } finally {
        spy.mockRestore();
      }
    }, APPLY_TIMEOUT);

    test("(d) a materialize failure → exit 2 after the overlay and outputRoot (incl. new stray files) are restored (REQ-PROP-08 d)", async () => {
      const e = await make();
      const dir = outsideDir();
      const id = nextId();
      writeSignedProposal(dir, applyPayload(id), TEST_SECRET);
      const real = rendererModule.materialize;
      const spy = spyOn(rendererModule, "materialize").mockImplementation(((tree, outputRoot) => {
        real(tree, outputRoot);
        writeFileSync(join(outputRoot, "stray.json"), "{}\n");
        throw new RenderIoError("SWAP_FAILED", "injected swap failure", outputRoot);
      }) as typeof real);
      try {
        const before = snapshot(e, dir);
        const r = await cli(e, ["apply", id, "--proposals-dir", dir, "--json"]);
        expect(r.exitCode).toBe(2);
        expect(r.stdout).toBe("");
        expect(git(e.root, "status", "--porcelain", "--untracked-files=all")).toBe("");
        expect(snapshot(e, dir)).toEqual(before);
      } finally {
        spy.mockRestore();
      }
    }, APPLY_TIMEOUT);

    test("(e) a rejecting pre-commit hook → exit 2; tree, index and overlay identical to before (REQ-PROP-08 e)", async () => {
      const e = await make();
      const id = nextId();
      writeSignedProposal(e.proposalsDir, applyPayload(id), TEST_SECRET);
      const hook = join(e.root, ".git", "hooks", "pre-commit");
      writeFileSync(hook, "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n");
      chmodSync(hook, 0o755);
      const before = snapshot(e);
      const r = await cli(e, ["apply", id, "--json"]);
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("proposal tool fault [git-commit]");
      expect(snapshot(e)).toEqual(before);
      expect(git(e.root, "diff", "--cached", "--name-only")).toBe("");
    }, APPLY_TIMEOUT);
  });

  describe("idempotency and crash recovery (REQ-PROP-10)", () => {
    test("re-apply → info PROPOSAL_ALREADY_DECIDED, exit 0, no new commit (REQ-PROP-10)", async () => {
      const e = await make();
      const id = nextId();
      writeSignedProposal(e.proposalsDir, applyPayload(id), TEST_SECRET);
      expect((await cli(e, ["apply", id])).exitCode).toBe(0);
      const head = git(e.root, "rev-parse", "HEAD").trim();
      const count = commitCount(e);
      const r = await cli(e, ["apply", id, "--json"]);
      expect(r.exitCode).toBe(0);
      const env = envelope(r.stdout);
      expect(env.findings.map((f) => [f.code, f.severity])).toEqual([[FINDING_CODES.PROPOSAL_ALREADY_DECIDED, "info"]]);
      expect(env.data).toMatchObject({ verb: "apply", state: "applied", commit: head, alreadyDecided: true, changedFiles: [] });
      expect(commitCount(e)).toBe(count);
    }, APPLY_TIMEOUT);

    test("re-reject → exit 0 with the reason unchanged; reject of an applied proposal → info, exit 0 (REQ-PROP-10)", async () => {
      const e = await make();
      const rej = nextId();
      writeSignedProposal(e.proposalsDir, applyPayload(rej), TEST_SECRET);
      expect((await cli(e, ["reject", rej, "--reason", REASON])).exitCode).toBe(0);
      const sidecarBytes = readFileSync(join(e.proposalsDir, resultFileName(rej)), "utf8");
      const r1 = await cli(e, ["reject", rej, "--reason", "a completely different reason", "--json"]);
      expect(r1.exitCode).toBe(0);
      const env1 = envelope(r1.stdout);
      expect(codes(env1.findings)).toEqual([FINDING_CODES.PROPOSAL_ALREADY_DECIDED]);
      expect(env1.data).toMatchObject({ verb: "reject", state: "rejected", reason: REASON, alreadyDecided: true });
      expect(readFileSync(join(e.proposalsDir, resultFileName(rej)), "utf8")).toBe(sidecarBytes);

      const app = nextId();
      writeSignedProposal(e.proposalsDir, applyPayload(app), TEST_SECRET);
      expect((await cli(e, ["apply", app])).exitCode).toBe(0);
      const appliedBytes = readFileSync(join(e.proposalsDir, resultFileName(app)), "utf8");
      const r2 = await cli(e, ["reject", app, "--reason", REASON, "--json"]);
      expect(r2.exitCode).toBe(0);
      const env2 = envelope(r2.stdout);
      expect(env2.findings.map((f) => [f.code, f.severity])).toEqual([[FINDING_CODES.PROPOSAL_ALREADY_DECIDED, "info"]]);
      expect(env2.data).toMatchObject({ verb: "reject", state: "applied", alreadyDecided: true });
      expect(readFileSync(join(e.proposalsDir, resultFileName(app)), "utf8")).toBe(appliedBytes);
    }, APPLY_TIMEOUT);

    test("apply of a rejected proposal → info, exit 0, no commit, overlay untouched (REQ-PROP-10)", async () => {
      const e = await make();
      const id = nextId();
      writeSignedProposal(e.proposalsDir, applyPayload(id), TEST_SECRET);
      expect((await cli(e, ["reject", id, "--reason", REASON])).exitCode).toBe(0);
      const before = snapshot(e);
      const r = await cli(e, ["apply", id, "--json"]);
      expect(r.exitCode).toBe(0);
      const env = envelope(r.stdout);
      expect(codes(env.findings)).toEqual([FINDING_CODES.PROPOSAL_ALREADY_DECIDED]);
      expect(env.data).toMatchObject({ verb: "apply", state: "rejected", commit: null, reason: REASON, alreadyDecided: true });
      expect(snapshot(e)).toEqual(before);
    }, APPLY_TIMEOUT);

    test("crash recovery: sidecar deleted after a successful apply → rewritten with the same SHA, no new commit (REQ-PROP-10)", async () => {
      const e = await make();
      const id = nextId();
      writeSignedProposal(e.proposalsDir, applyPayload(id), TEST_SECRET);
      expect((await cli(e, ["apply", id])).exitCode).toBe(0);
      const sha = readSidecar(e.proposalsDir, id).state === "applied" ? (readSidecar(e.proposalsDir, id) as { commit: string }).commit : "";
      expect(sha).toBe(git(e.root, "rev-parse", "HEAD").trim());
      unlinkSync(join(e.proposalsDir, resultFileName(id)));
      const count = commitCount(e);
      const r = await cli(e, ["apply", id, "--json"]);
      expect(r.exitCode).toBe(0);
      const env = envelope(r.stdout);
      expect(codes(env.findings)).toEqual([FINDING_CODES.PROPOSAL_ALREADY_DECIDED]);
      expect(env.findings[0]!.message).toContain("recorded the missing applied result");
      expect(readSidecar(e.proposalsDir, id)).toMatchObject({ state: "applied", commit: sha });
      expect(commitCount(e)).toBe(count);
    }, APPLY_TIMEOUT);

    test("reject after an apply whose sidecar was lost records the applied result, never a rejection (REQ-PROP-10)", async () => {
      const e = await make();
      const id = nextId();
      writeSignedProposal(e.proposalsDir, applyPayload(id), TEST_SECRET);
      expect((await cli(e, ["apply", id])).exitCode).toBe(0);
      const sha = git(e.root, "rev-parse", "HEAD").trim();
      unlinkSync(join(e.proposalsDir, resultFileName(id)));
      const r = await cli(e, ["reject", id, "--reason", "Not wanted after all.", "--json"]);
      expect(r.exitCode).toBe(0);
      const env = envelope(r.stdout);
      expect(codes(env.findings)).toEqual([FINDING_CODES.PROPOSAL_ALREADY_DECIDED]);
      expect(readSidecar(e.proposalsDir, id)).toMatchObject({ state: "applied", commit: sha });
    }, APPLY_TIMEOUT);

    test("crash recovery never trusts a `Proposal-Id:` line inside a rationale (REQ-PROP-10)", async () => {
      const e = await make();
      const other = nextId();
      const first = nextId();
      writeSignedProposal(
        e.proposalsDir,
        applyPayload(first, { rationale: `Mark app-01 as expected churn.\nProposal-Id: ${other}\n\nProposal-Id: ${other}` }),
        TEST_SECRET,
      );
      expect((await cli(e, ["apply", first])).exitCode).toBe(0);
      // The other proposal (cadvisor true → false on the same host) must be applied for real.
      writeSignedProposal(
        e.proposalsDir,
        applyPayload(other, { changes: [{ field: "cadvisor", seen: true, proposed: false }] }),
        TEST_SECRET,
      );
      const count = commitCount(e);
      const r = await cli(e, ["apply", other, "--json"]);
      expect(r.exitCode).toBe(0);
      expect(envelope(r.stdout).data).toMatchObject({ state: "applied", alreadyDecided: false });
      expect(commitCount(e)).toBe(count + 1);
      expect(readSidecar(e.proposalsDir, other)).toMatchObject({ commit: git(e.root, "rev-parse", "HEAD").trim() });
    }, APPLY_TIMEOUT);
  });

  describe("reject (REQ-PROP-09, REQ-SEC-05)", () => {
    test("reject writes a rejected sidecar and never touches the proposal file (REQ-PROP-09)", async () => {
      const e = await make();
      const id = nextId();
      const p = writeSignedProposal(e.proposalsDir, applyPayload(id), TEST_SECRET);
      const proposalBytes = readFileSync(p, "utf8");
      const before = snapshot(e);
      const r = await cli(e, ["reject", id, "--reason", REASON, "--json"]);
      expect(r.exitCode).toBe(0);
      expect(envelope(r.stdout).data).toEqual({ verb: "reject", id, state: "rejected", commit: null, reason: REASON, alreadyDecided: false });
      expect(readSidecar(e.proposalsDir, id)).toMatchObject({ state: "rejected", reason: REASON, by: "Pulse Test" });
      expect(readFileSync(p, "utf8")).toBe(proposalBytes);
      const after = snapshot(e);
      expect({ ...after, proposals: {} }).toEqual({ ...before, status: after.status, proposals: {} });
      expect(after.head).toBe(before.head);
    }, APPLY_TIMEOUT);

    test("reject of a forged file → PROPOSAL_SIGNATURE_INVALID, exit 1, no sidecar (REQ-SEC-05)", async () => {
      const e = await make();
      const id = nextId();
      writeSignedProposal(e.proposalsDir, applyPayload(id), `${TEST_SECRET}-a-different-key`);
      const r = await cli(e, ["reject", id, "--reason", REASON, "--json"]);
      expect(r.exitCode).toBe(1);
      expect(codes(envelope(r.stdout).findings)).toEqual([FINDING_CODES.PROPOSAL_SIGNATURE_INVALID]);
      expect(existsSync(join(e.proposalsDir, resultFileName(id)))).toBe(false);
    }, APPLY_TIMEOUT);

    const badReasons: readonly (readonly [string, readonly string[]])[] = [
      ["without --reason", []],
      ["with a 9-char reason", ["--reason", "nine char"]],
      ["with a control char", ["--reason", "bad \u001b[31m reason text"]],
    ];
    for (const [name, extra] of badReasons) {
      test(`reject ${name} exits 2 with empty stdout and writes nothing (REQ-PROP-09, REQ-SEC-07)`, async () => {
        const dir = outsideDir();
        const id = nextId();
        writeSignedProposal(dir, applyPayload(id), TEST_SECRET);
        const r = await runCli(["proposals", "reject", id, "--proposals-dir", dir, ...extra], { cwd: dir, env: TEST_ENV });
        expect(r.exitCode).toBe(2);
        expect(r.stdout).toBe("");
        expect(existsSync(join(dir, resultFileName(id)))).toBe(false);
      });
    }

    test("reject works when estateDir is not a git repo (REQ-PROP-09)", async () => {
      const dir = outsideDir();
      mkdirSync(join(dir, "estate"));
      mkdirSync(join(dir, "proposals"));
      writeFileSync(join(dir, "pulse.config.yaml"), "estateDir: estate\nproposalsDir: proposals\n");
      const id = nextId();
      writeSignedProposal(join(dir, "proposals"), applyPayload(id), TEST_SECRET);
      const r = await runCli(["proposals", "reject", id, "--reason", REASON, "--json"], {
        cwd: dir,
        env: { ...TEST_ENV, USER: "operator-no-git" },
      });
      expect(r.exitCode).toBe(0);
      const sc = readSidecar(join(dir, "proposals"), id);
      expect(sc).toMatchObject({ state: "rejected", reason: REASON });
      expect(sc.by.length).toBeGreaterThan(0);
    });

    test("actorName: git user.name first, else $USER → $USERNAME → unknown; controls stripped, ≤ 128 chars", async () => {
      const nowhere = join(outsideDir(), "not-a-dir");
      expect(actorName(nowhere, { USER: "alice" })).toBe("alice");
      expect(actorName(nowhere, { USERNAME: "bob" })).toBe("bob");
      expect(actorName(nowhere, {})).toBe("unknown");
      const long = actorName(nowhere, { USER: `evil\u001b[31m${"x".repeat(300)}` });
      expect(long).not.toContain("\u001b");
      expect([...long].length).toBe(128);
      const e = await make();
      expect(actorName(e.estateDir, { USER: "alice" })).toBe("Pulse Test");
    }, APPLY_TIMEOUT);
  });

  describe("secret non-disclosure and inert text (REQ-SEC-04, REQ-SEC-07)", () => {
    test("the 32-byte test secret appears in none of stdout, stderr, the envelope, the sidecar, the commit message or a hook's env (REQ-SEC-04)", async () => {
      const secret32 = "Zq7!pulse-secret-canary-32bytes!"; // exactly 32 UTF-8 bytes
      expect(new TextEncoder().encode(secret32).byteLength).toBe(32);
      const env = { ...TEST_ENV, PULSE_PROPOSAL_SECRET: secret32 };
      const e = await make();
      const hook = join(e.root, ".git", "hooks", "pre-commit");
      writeFileSync(hook, `#!/bin/sh\nenv > "${join(e.root, ".git", "hook-env")}"\nexit 0\n`);
      chmodSync(hook, 0o755);

      const applied = nextId();
      writeSignedProposal(e.proposalsDir, applyPayload(applied), secret32);
      const ra = await cli(e, ["apply", applied, "--json"], env);
      expect(ra.exitCode).toBe(0);
      const rejected = nextId();
      writeSignedProposal(e.proposalsDir, applyPayload(rejected, { changes: [{ field: "cadvisor", seen: true, proposed: false }] }), secret32);
      const rr = await cli(e, ["reject", rejected, "--reason", REASON, "--json"], env);
      expect(rr.exitCode).toBe(0);

      const surfaces = [
        ra.stdout,
        ra.stderr,
        JSON.stringify(envelope(ra.stdout)),
        rr.stdout,
        rr.stderr,
        readFileSync(join(e.proposalsDir, resultFileName(applied)), "utf8"),
        readFileSync(join(e.proposalsDir, resultFileName(rejected)), "utf8"),
        git(e.root, "log", "-1", "--format=%B"),
        readFileSync(join(e.root, ".git", "hook-env"), "utf8"),
      ];
      for (const s of surfaces) {
        expect(s.length).toBeGreaterThan(0);
        expect(s).not.toContain(secret32);
        expect(s).not.toContain(Buffer.from(secret32).toString("base64"));
      }
    }, APPLY_TIMEOUT);

    test("bidi controls in the proposer name never reach the commit message (REQ-SEC-07)", async () => {
      // A bidi rationale is refused by the schema; identity fields may carry them and are stripped.
      const e = await make();
      const id = nextId();
      writeSignedProposal(
        e.proposalsDir,
        applyPayload(id, { proposer: { subject: "eve", displayName: "Eve ‮Operator‬ Smith" } }),
        TEST_SECRET,
      );
      expect((await cli(e, ["apply", id])).exitCode).toBe(0);
      const msg = git(e.root, "log", "-1", "--format=%B");
      expect(msg).toContain("Proposed-By: Eve Operator Smith");
      expect(msg).not.toMatch(/[‪-‮⁦-⁩\u001b\r]/);
      for (const line of msg.split("\n")) if (line.includes(" ")) expect(line.length).toBeLessThanOrEqual(72 + 60);
    }, APPLY_TIMEOUT);
  });

  test("no runGit call's first argument is push|fetch|pull|remote|clean|stash|checkout|reset across the apply suite (REQ-PROP-08, 08 §7.4)", () => {
    const firstArgs = runGitSpy.mock.calls.map((c) => c[1][0]);
    expect(firstArgs.length).toBeGreaterThan(50);
    expect(firstArgs).toContain("commit");
    expect(firstArgs.filter((a) => a !== undefined && FORBIDDEN_GIT.has(a))).toEqual([]);
  });
});

describe("apply helpers (08 §4.4)", () => {
  test("sameValue is key-order independent over suppression marks; findEntity resolves by core name", async () => {
    expect(sameValue({ class: "known-expected", rationale: "r" }, { rationale: "r", class: "known-expected" })).toBe(true);
    expect(sameValue(true, false)).toBe(false);
    expect(sameValue(null, null)).toBe(true);
    const est = await tempGitEstate();
    try {
      const loaded = coreModule.loadAndValidate(est.estateDir);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(findEntity(loaded.model, { kind: "host", id: "host:app-01", name: "app-01" })?.name).toBe("app-01");
      expect(findEntity(loaded.model, { kind: "host", id: "host:app-01", name: "nope" })).toBeNull();
      expect(findEntity(loaded.model, { kind: "service", id: "svc:app-01/app-01", name: "app-01" })).toBeNull();
    } finally {
      est.cleanup();
    }
  }, APPLY_TIMEOUT);
});
