// agent-kit/tests/eval.live.test.ts
// The opt-in LIVE Claude Code eval — the criterion-1 RELEASE gate (06-testing-and-eval.md §6.2,
// REQ-EVAL-03). This is NOT a per-PR gate: it self-skips by default and is never part of
// `bun run ci`'s pass requirement (the per-PR bar is eval.deterministic.test.ts §6.1).
//
// GATING & SKIP (spec §6.2): the whole suite is wrapped in
// `describe.skipIf(!process.env.AGENT_KIT_LIVE_EVAL)`, so with the credential env var unset it
// self-skips cleanly (green) and `bun test` passes without touching a model. This is the ONE place
// a gating-tier skip is legitimate — the objective is explicitly opt-in. When ENABLED it is a
// release gate: a tooling-absent env (no `claude` binary, no API key) fails RED, it never skips
// past a real failure once opted in.
//
// MECHANISM (spec §6.2): per rehearsed task —
//   1. scaffold a temp repo with the CLAUDE PACK ONLY (the reference ecosystem, real committed
//      bytes from generated/claude/**) + a copy of the reference estate;
//   2. spin a real pinned-model Claude Code session primed ONLY by the scaffolded pack (zero human
//      priming, REQ-GUIDE-07 — the operator prompt states the TASK, never teaches the tool);
//   3. score BINARY objective post-conditions on repo state using the CLI as the oracle — NO
//      LLM-judge, NO prose grading. First-attempt = all predicates pass on the FIRST session with
//      ZERO human-correction turns.
//
// ── OQ-03 RESOLUTION (session-runner / credential / model pin) ────────────────────────────────
// No existing repo export fixes the Claude Code session-runner API, the credential env var, or the
// model pin (item 010 note / spec §6.2 WARNING). This suite resolves them to the DOCUMENTED Claude
// Code headless entry point, with every uncertain binding env-overridable so a human can retarget
// the runner by CONFIG (env), never a code edit:
//
//   • session runner  — the `claude` CLI in headless print mode (`claude -p <task> --model <pin>
//                        --dangerously-skip-permissions`), spawned cwd'd into the scaffolded repo.
//                        Binary overridable via AGENT_KIT_CLAUDE_BIN (default "claude"); extra args
//                        via AGENT_KIT_CLAUDE_ARGS (space-split). A single non-interactive prompt =
//                        zero human-correction turns by construction (correctionTurns === 0).
//   • credential      — whatever the `claude` CLI itself consumes from the environment (normally
//                        ANTHROPIC_API_KEY); AGENT_KIT_LIVE_EVAL is only the OPT-IN gate. If opted
//                        in without a working credential the spawn fails and the suite fails RED.
//   • model pin       — AGENT_KIT_LIVE_MODEL (default PINNED_MODEL below). Pin to a fixed model
//                        version for a reproducible release run (spec §6.2 — pinned model, binary
//                        scoring, no judge).
//
// If a future repo export fixes a different session-runner contract, retarget `runClaudeCodeSession`
// there; the scaffolding and binary scoring below are contract-independent.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { runCli } from "./helpers/run-cli.js";
import { copyReferenceEstate, estateYamlPath } from "./fixtures/estate.js";
import { coverageGapPatch } from "./fixtures/coverage-gap.estate.js";
import { PROBE_HOST } from "./fixtures/add-probe.patch.js";

/** Opt-in gate (spec §6.2): unset → the whole suite self-skips (never a PR gate). */
const LIVE = Boolean(process.env.AGENT_KIT_LIVE_EVAL);

/** Default pinned model for a reproducible release run; override with AGENT_KIT_LIVE_MODEL. */
const PINNED_MODEL = process.env.AGENT_KIT_LIVE_MODEL ?? "claude-opus-4-8";

/** The `claude` headless binary; override with AGENT_KIT_CLAUDE_BIN. */
const CLAUDE_BIN = process.env.AGENT_KIT_CLAUDE_BIN ?? "claude";

/** Absolute path to the committed Claude pack tree (real bytes — NOT the init.ts dev stub). */
const CLAUDE_PACK = resolve(import.meta.dir, "../generated/claude");

/** The concrete operator subjects — chosen up front so post-condition scoring is objective. */
const LIVE_HOST = "harbor-web-09"; // new managed-linux host the add-host session must author
const LIVE_SERVICE = "billing-api"; // new deep-health-probed service the add-probe session authors

// ── Scaffolding ───────────────────────────────────────────────────────────────────────────────

/** List every file under `dir` as `dir`-relative POSIX paths (recursive, sorted). */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.push(relative(dir, abs).split("\\").join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Scaffold a temp repo primed with the CLAUDE PACK ONLY + a copy of the reference estate
 * (spec §6.2). Writes the REAL committed generated/claude/** bytes at their natural repo paths
 * (CLAUDE.md at root, .claude/** below it) so a real Claude Code session auto-reads them — the
 * init.ts pack seam ships only a dev stub in a non-release build, so we lay the reviewed bytes
 * down directly. Never mutates the committed source. Caller removes the dir in a `finally`.
 */
function scaffoldClaudePackAndEstate(): string {
  const repo = copyReferenceEstate(); // pulse.config.yaml + estate/ + rendered/ (a fresh temp copy)
  for (const rel of listFiles(CLAUDE_PACK)) {
    const dest = join(repo, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(CLAUDE_PACK, rel), dest);
  }
  return repo;
}

// ── Session runner (OQ-03 binding — documented Claude Code headless entry) ──────────────────────

interface ClaudeSession {
  /** The session's final textual answer (stdout of `claude -p`). */
  answer: string;
  /** Human-correction turns. Always 0 here: a single non-interactive prompt, zero priming. */
  correctionTurns: number;
}

/**
 * Run a real pinned-model Claude Code session, primed ONLY by the scaffolded pack in `repo`, on the
 * operator `task`. Headless print mode → one shot, no human correction (correctionTurns === 0).
 * A non-zero exit / missing binary throws so an opted-in release run fails RED (spec §1/§6.2).
 */
function runClaudeCodeSession(repo: string, task: string): ClaudeSession {
  const extra = (process.env.AGENT_KIT_CLAUDE_ARGS ?? "").split(" ").filter(Boolean);
  const argv = ["-p", task, "--model", PINNED_MODEL, "--dangerously-skip-permissions", ...extra];
  const res = spawnSync(CLAUDE_BIN, argv, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60 * 1000, // 15-minute per-session ceiling
  });
  if (res.error) {
    throw new Error(`[eval:live] session runner '${CLAUDE_BIN}' failed to spawn: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`[eval:live] session exited ${res.status}: ${res.stderr ?? ""}`);
  }
  return { answer: res.stdout ?? "", correctionTurns: 0 };
}

/** Parse the current host ids out of a scaffolded repo's estate.yaml (via the CLI validate is done separately). */
function estateText(repo: string): string {
  return readFileSync(estateYamlPath(repo), "utf8");
}

/** Run a task body, emit the greppable per-task line (REQ-OBS-01), re-throw on failure so the gate fails. */
async function evalLive(task: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`[eval:live] ${task}: PASS`);
  } catch (e) {
    console.log(`[eval:live] ${task}: FAIL`);
    throw e;
  }
}

describe.skipIf(!LIVE)("eval.live — criterion-1 release gate (REQ-EVAL-03)", () => {
  // ── add-host: host present + validate 0 + render writes its scrape target ─────────────────────
  test("[live add-host] first-attempt: host present + validate 0 + render writes its target", async () => {
    await evalLive("add-host", async () => {
      const repo = scaffoldClaudePackAndEstate();
      try {
        const session = runClaudeCodeSession(
          repo,
          `Add a new managed-linux host named "${LIVE_HOST}" (address 10.20.0.40, node_exporter ` +
            `on port 9100) to this Pulse estate, then confirm it validates.`,
        );
        expect(session.correctionTurns).toBe(0); // zero human-correction turns (first-attempt)
        expect(estateText(repo)).toContain(LIVE_HOST); // estate.yaml gained the host

        // Binary post-conditions scored with the CLI as oracle (no LLM-judge).
        const v = await runCli(["validate", "--json"], repo);
        expect(v.exitCode).toBe(0);

        const r = await runCli(["render", "--json"], repo);
        expect(r.exitCode).toBe(0);
        const data = JSON.parse(r.stdout).data;
        expect(data.filesWritten.some((f: string) => f.includes(LIVE_HOST))).toBe(true);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  // ── add-probe: probe present + validate 0 + rendered prober gains it ──────────────────────────
  test("[live add-probe] first-attempt: probe present + validate 0 + rendered prober gains it", async () => {
    await evalLive("add-probe", async () => {
      const repo = scaffoldClaudePackAndEstate();
      try {
        const session = runClaudeCodeSession(
          repo,
          `Add a deep-health probe to this estate: a new managed http service named ` +
            `"${LIVE_SERVICE}" on host "${PROBE_HOST}", ingress https://${LIVE_SERVICE}.aurora.example, ` +
            `health endpoint https://${LIVE_SERVICE}.aurora.example/api/health (map status to $.status; ` +
            `use the \${WEB_HEALTH_TOKEN} env credential — never a literal). Confirm it validates.`,
        );
        expect(session.correctionTurns).toBe(0);
        const estate = estateText(repo);
        expect(estate).toContain(LIVE_SERVICE);
        expect(estate).toContain("deep_health");

        const v = await runCli(["validate", "--json"], repo);
        expect(v.exitCode).toBe(0);

        const r = await runCli(["render", "--json"], repo);
        expect(r.exitCode).toBe(0);
        const prober = readFileSync(join(repo, "rendered", "prober", "config.yaml"), "utf8");
        expect(prober).toContain(`svc:${PROBE_HOST}/${LIVE_SERVICE}`);
        expect(prober).toContain("deep-health");
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  // ── explain-coverage: the answer names the exact declared-but-unmonitored service ─────────────
  test("[live explain-coverage] first-attempt: answer names the exact unmonitored service", async () => {
    await evalLive("explain-coverage", async () => {
      const repo = scaffoldClaudePackAndEstate();
      try {
        // Seed a KNOWN declared-but-unmonitored service so the CLI oracle has a deterministic gap.
        coverageGapPatch.apply(repo);
        const gapSubject = coverageGapPatch.subject; // e.g. "orphan-svc"

        // The CLI is the oracle: coverage exits 1 and reports the gap (binary, reproducible).
        const c = await runCli(["coverage", "--json"], repo);
        expect(c.exitCode).toBe(1);
        const gaps: Array<{ name: string }> = JSON.parse(c.stdout).data.gaps;
        expect(gaps.some((g) => g.name.includes(gapSubject))).toBe(true);

        const session = runClaudeCodeSession(
          repo,
          `Which declared service in this Pulse estate has no monitoring coverage? ` +
            `Name the exact host/service.`,
        );
        expect(session.correctionTurns).toBe(0);

        // Binary scoring: the session's answer NAMES the exact gap service (no prose grading).
        expect(session.answer).toContain(gapSubject);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });
  });
});
