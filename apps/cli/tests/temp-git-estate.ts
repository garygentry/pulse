// apps/cli/tests/temp-git-estate.ts — a throwaway git-tracked estate for the `pulse proposals`
// suites (10 §3.5). Copies the shared overlay-estate fixture (never edited in place), renders it
// in-process, and commits everything except the proposals dir, which stays untracked.

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProposalPayload } from "@pulse/core/proposals";
import { signProposal } from "@pulse/core/proposals/sign";
import { proposalFileName } from "@pulse/core/proposals";

import { runCli } from "./factories.js";

/** The shared fixture copied into every temp estate (read-only source). */
export const OVERLAY_ESTATE_FIXTURE = join(import.meta.dir, "../../../packages/core/tests/fixtures/overlay-estate");

/** A ≥ 32-byte test secret (REQ-SEC-04); tests grep outputs for it. */
export const TEST_SECRET = "pulse-test-proposal-secret-0123456789-abcdef";

/** Env for runCli: the secret plus the fixture's `${…}` placeholders. Never touches process.env. */
export const TEST_ENV: NodeJS.ProcessEnv = {
  PULSE_PROPOSAL_SECRET: TEST_SECRET,
  CHAT_WEBHOOK_URL: "https://chat.example.invalid/hook",
  DEADMAN_URL: "https://deadman.example.invalid/ping",
};

/** A temp estate repo created by {@link tempGitEstate}. */
export interface TempGitEstate {
  /** Repo root (holds pulse.config.yaml). */
  readonly root: string;
  /** `<root>/estate`. */
  readonly estateDir: string;
  /** `<root>/rendered`. */
  readonly outputRoot: string;
  /** `<root>/proposals` (exists, untracked). */
  readonly proposalsDir: string;
  /** Remove the temp root. */
  cleanup(): void;
}

/** Options for {@link tempGitEstate}. */
export interface TempGitEstateOptions {
  /** Mutate the estate copy before the initial render/commit (e.g. add services). */
  readonly prepare?: (estateDir: string) => void;
}

/** Run git in `cwd`, throwing on a non-zero exit. */
export function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${proc.exitCode}): ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

/**
 * Build a rendered, committed estate repo: mkdtemp → copy overlay-estate → pulse.config.yaml →
 * mkdir proposals → git init + local identity → `pulse render` in-process → one commit.
 */
export async function tempGitEstate(opts: TempGitEstateOptions = {}): Promise<TempGitEstate> {
  const root = mkdtempSync(join(tmpdir(), "pulse-git-estate-"));
  const estateDir = join(root, "estate");
  const outputRoot = join(root, "rendered");
  const proposalsDir = join(root, "proposals");
  const cleanup = (): void => rmSync(root, { recursive: true, force: true });
  try {
    cpSync(OVERLAY_ESTATE_FIXTURE, estateDir, { recursive: true });
    opts.prepare?.(estateDir);
    writeFileSync(
      join(root, "pulse.config.yaml"),
      "estateDir: estate\noutputRoot: rendered\nproposalsDir: proposals\n",
    );
    mkdirSync(proposalsDir);
    git(root, "init", "-q");
    git(root, "config", "user.name", "Pulse Test");
    git(root, "config", "user.email", "pulse-test@example.invalid");
    git(root, "config", "commit.gpgsign", "false");
    const r = await runCli(["render"], { cwd: root, env: TEST_ENV });
    if (r.exitCode !== 0) throw new Error(`pulse render failed (${r.exitCode}): ${r.stderr}`);
    git(root, "add", "-A", "--", ".", ":!proposals");
    git(root, "commit", "-q", "-m", "initial estate");
  } catch (err) {
    cleanup();
    throw err;
  }
  return { root, estateDir, outputRoot, proposalsDir, cleanup };
}

/** Sign `payload` with `secret` and write `<id>.proposal.json` into `dir`; returns the path. */
export function writeSignedProposal(dir: string, payload: ProposalPayload, secret: string | Uint8Array): string {
  const bytes = typeof secret === "string" ? new TextEncoder().encode(secret) : secret;
  const file = signProposal(payload, bytes);
  const path = join(dir, proposalFileName(payload.id));
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
  return path;
}
