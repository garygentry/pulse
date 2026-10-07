// apps/cli/src/commands/proposals/git.ts — `Bun.spawnSync` git runner and repository handle.
// Only read, add, commit and restore operations are wrapped; no network-facing or
// destructive git operation has a wrapper (REQ-PROP-08 "MUST NOT push or deploy").

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { stripControl } from "./commit-message.js";

/** A git/tool fault → exit 2 via failHard. */
export class ProposalToolError extends Error {
  readonly code = "PROPOSAL_TOOL_FAULT" as const;
  readonly step: "git-missing" | "git-status" | "git-commit" | "restore" | "io";
  constructor(step: ProposalToolError["step"], message: string) {
    super(message);
    this.name = "ProposalToolError";
    this.step = step;
    Object.setPrototypeOf(this, ProposalToolError.prototype);
  }
}

/** One finished git invocation. */
export interface GitRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Child env: deterministic output, no prompts, and NO proposal secret (REQ-SEC-04: hooks never see it). */
function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "PULSE_PROPOSAL_SECRET") env[k] = v;
  }
  return { ...env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

/**
 * Run `git -C <cwd> <args…>` synchronously. Never goes through a shell (argv array), so no quoting or injection.
 * @throws {ProposalToolError} "git-missing" when the executable cannot be spawned.
 */
export function runGit(cwd: string, args: readonly string[]): GitRun {
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args], stdout: "pipe", stderr: "pipe", env: gitEnv() });
  } catch (err) {
    throw new ProposalToolError(
      "git-missing",
      `git executable not found on PATH (${(err as Error).message}); install git ≥ 2.24`,
    );
  }
  return { code: proc.exitCode ?? -1, stdout: proc.stdout?.toString() ?? "", stderr: proc.stderr?.toString() ?? "" };
}

/** Operations bound to one repo root. Every path argument is repo-relative (see `rel`). */
export interface GitRepo {
  readonly repoRoot: string;
  /** Repo-relative path of an absolute path inside the work tree; throws "git-status" when outside. */
  rel(abs: string): string;
  /** As `rel`, but null when outside the work tree (proposals dir may live elsewhere, REQ-PROP-11). */
  relOrNull(abs: string): string | null;
  /** Staged paths (a0): `git diff --cached --quiet`; on exit 1, `--name-only -z`. */
  stagedPaths(): string[];
  /** `git status --porcelain=v1 -z --untracked-files=no -- <include…> ':(exclude)<exclude>'…` → "XY path" entries. */
  dirtyTrackedPaths(include: readonly string[], exclude: readonly string[]): string[];
  /** `git ls-files --error-unmatch -- <rel>` exit 0. */
  isTracked(rel: string): boolean;
  /** `git ls-files --others --exclude-standard -z -- <rel>`. */
  untrackedPaths(rel: string): string[];
  /** `git status --porcelain=v1 -z --untracked-files=all -- <rel>` → paths (tracked, untracked, deleted). */
  changedPaths(rel: string): string[];
  /** `git add -A -- <paths…>`; failure → "git-commit". */
  add(paths: readonly string[]): void;
  /** Write message to a mkdtemp file, `git commit --cleanup=whitespace -F <tmp>`, return `rev-parse HEAD`. Failure → "git-commit". */
  commit(message: string): string;
  /** Trailer-verified search (the id must appear as a parsed Proposal-Id trailer, not just in the body); null when not found or HEAD is unborn. */
  findProposalCommit(id: string): string | null;
  /** `git restore --staged -- <paths…>` (index back to HEAD). */
  unstage(paths: readonly string[]): void;
  /** `git restore --worktree -- <rel>`, skipped when `git ls-files -- <rel>` is empty. */
  restoreWorktree(rel: string): void;
  /** `git config user.name` || $USER || $USERNAME || "unknown"; controls stripped, ≤128 chars. */
  userName(env: NodeJS.ProcessEnv): string;
}

/** Max characters of an actor name. */
const USER_NAME_MAX_CHARS = 128;
/** Max characters of git stderr quoted in a fault message. */
const STDERR_MAX_CHARS = 500;

type Step = ProposalToolError["step"];

/** Throw `step` with the first 500 characters of stderr, controls stripped. */
function fault(step: Step, what: string, r: GitRun): never {
  throw new ProposalToolError(step, `git ${what} failed (exit ${r.code}): ${stripControl(r.stderr).slice(0, STDERR_MAX_CHARS)}`);
}

/** Split `-z` output into its non-empty fields. */
function zFields(stdout: string): string[] {
  return stdout.split("\0").filter((f) => f.length > 0);
}

/** Porcelain v1 `-z` records → "XY path" entries; a rename/copy consumes the next field (the source). */
function porcelainEntries(stdout: string): string[] {
  const fields = zFields(stdout);
  const out: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i]!;
    out.push(rec);
    const x = rec[0];
    if (x === "R" || x === "C") i++;
  }
  return out;
}

/** realpath of `p`, or of its nearest existing ancestor joined with the missing tail. */
function realish(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const parent = resolve(abs, "..");
    if (parent === abs) return abs;
    return join(realish(parent), abs.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
  }
}

/**
 * Discover the repo root from `dir` via `git rev-parse --show-toplevel` (realpath'd).
 * @throws {ProposalToolError} "git-missing"; "git-status" when `dir` is not inside a git work tree.
 */
export function openGit(dir: string): GitRepo {
  const top = runGit(dir, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) {
    throw new ProposalToolError(
      "git-status",
      `${stripControl(dir)} is not inside a git work tree: ${stripControl(top.stderr).slice(0, STDERR_MAX_CHARS)}`,
    );
  }
  const repoRoot = realpathSync(top.stdout.trim());
  const git = (args: readonly string[]): GitRun => runGit(repoRoot, args);

  const relOrNull = (abs: string): string | null => {
    const r = relative(repoRoot, realish(abs));
    if (r === "") return ".";
    if (r.startsWith("..") || isAbsolute(r)) return null;
    return r.split(sep).join("/");
  };

  const repo: GitRepo = {
    repoRoot,
    rel(abs) {
      const r = relOrNull(abs);
      if (r === null) throw new ProposalToolError("git-status", `${stripControl(abs)} is outside the estate repository ${repoRoot}`);
      return r;
    },
    relOrNull,
    stagedPaths() {
      const q = git(["diff", "--cached", "--quiet"]);
      if (q.code === 0) return [];
      if (q.code !== 1) fault("git-status", "diff --cached", q);
      const r = git(["diff", "--cached", "--name-only", "-z"]);
      if (r.code !== 0) fault("git-status", "diff --cached --name-only", r);
      return zFields(r.stdout);
    },
    dirtyTrackedPaths(include, exclude) {
      const r = git([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=no",
        "--",
        ...include,
        ...exclude.map((e) => `:(exclude)${e}`),
      ]);
      if (r.code !== 0) fault("git-status", "status", r);
      return porcelainEntries(r.stdout);
    },
    isTracked(rel) {
      const r = git(["ls-files", "--error-unmatch", "--", rel]);
      if (r.code === 0) return true;
      if (r.code === 1) return false;
      return fault("git-status", "ls-files --error-unmatch", r);
    },
    untrackedPaths(rel) {
      const r = git(["ls-files", "--others", "--exclude-standard", "-z", "--", rel]);
      if (r.code !== 0) fault("git-status", "ls-files --others", r);
      return zFields(r.stdout);
    },
    changedPaths(rel) {
      const r = git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", rel]);
      if (r.code !== 0) fault("git-status", "status", r);
      return porcelainEntries(r.stdout).map((e) => e.slice(3));
    },
    add(paths) {
      if (paths.length === 0) return;
      const r = git(["add", "-A", "--", ...paths]);
      if (r.code !== 0) fault("git-commit", "add", r);
    },
    commit(message) {
      const tmp = mkdtempSync(join(tmpdir(), "pulse-commit-msg-"));
      try {
        const file = join(tmp, "MESSAGE");
        writeFileSync(file, message, { mode: 0o600 });
        const r = git(["commit", "--cleanup=whitespace", "-F", file]);
        if (r.code !== 0) fault("git-commit", "commit", r);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
      const head = git(["rev-parse", "HEAD"]);
      if (head.code !== 0) fault("git-commit", "rev-parse HEAD", head);
      return head.stdout.trim();
    },
    findProposalCommit(id) {
      if (git(["rev-parse", "--verify", "-q", "HEAD"]).code !== 0) return null; // unborn HEAD
      const r = git([
        "log",
        "HEAD",
        `--grep=^Proposal-Id: ${id}$`,
        "--format=%H%x00%(trailers:key=Proposal-Id,valueonly,separator=%x2C)%x1e",
      ]);
      if (r.code !== 0) fault("git-status", "log", r);
      for (const rec of r.stdout.split("\x1e")) {
        const [sha, trailers] = rec.trim().split("\0");
        if (sha && trailers !== undefined && trailers.split(",").map((t) => t.trim()).includes(id)) return sha;
      }
      return null;
    },
    unstage(paths) {
      if (paths.length === 0) return;
      const r = git(["restore", "--staged", "--", ...paths]);
      if (r.code !== 0) fault("restore", "restore --staged", r);
    },
    restoreWorktree(rel) {
      const ls = git(["ls-files", "--", rel]);
      if (ls.code !== 0) fault("restore", "ls-files", ls);
      if (ls.stdout.trim() === "") return;
      const r = git(["restore", "--worktree", "--", rel]);
      if (r.code !== 0) fault("restore", "restore --worktree", r);
    },
    userName(env) {
      const r = git(["config", "user.name"]);
      if (r.code !== 0 && r.code !== 1) fault("git-status", "config user.name", r);
      const raw = (r.code === 0 ? r.stdout.trim() : "") || env["USER"] || env["USERNAME"] || "unknown";
      return [...(stripControl(raw) || "unknown")].slice(0, USER_NAME_MAX_CHARS).join("");
    },
  };
  return repo;
}
