// apps/web/tests/ui-drift-fixture.ts — builds the upstream git repository and the pulse-side copy
// that tests/ui-drift.test.ts runs the drift check against. See tests/fixtures/ui-drift/.
//
//   upstream-pin/  deck at the pin: same, diverged, changed, removed and skip (excluded)
//   upstream-ref/  deck later: diverged and changed edited, removed deleted, skip edited, added new
//   local/         pulse: same, changed and removed identical to the pin, diverged rewritten
//                  (note `pulse-text`), extra pulse-only, plus VENDORED.json and VENDORED.md
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FIXTURE = join(import.meta.dir, "fixtures", "ui-drift");
export const FIXTURE_MANIFEST = "ui/VENDORED.json";

// Fixed identity, dates and an empty config, so the pin's sha is the same on every machine and the
// committed fixture manifest can record it.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

export interface Upstream {
  dir: string;
  pin: string;
  ref: string;
}

/** A git repository whose `main` has two commits: upstream-pin, then upstream-ref. */
export function buildUpstream(parent: string): Upstream {
  const dir = join(parent, "upstream");
  cpSync(join(FIXTURE, "upstream-pin"), dir, { recursive: true });
  git(dir, "init", "--quiet", "--initial-branch=main");
  // Lets the fetch tests ask for the pin by sha over file://, as GitHub allows.
  git(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "pin");
  const pin = git(dir, "rev-parse", "HEAD");
  rmSync(join(dir, "lib"), { recursive: true });
  cpSync(join(FIXTURE, "upstream-ref"), dir, { recursive: true });
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", "ref");
  return { dir, pin, ref: git(dir, "rev-parse", "HEAD") };
}

/** A scratch directory holding a copy of the pulse side (`root`) and the upstream repository. */
export function makeWorkspace(): { tmp: string; root: string; upstream: Upstream } {
  const tmp = mkdtempSync(join(tmpdir(), "ui-drift-"));
  const root = join(tmp, "pulse");
  cpSync(join(FIXTURE, "local"), root, { recursive: true });
  return { tmp, root, upstream: buildUpstream(tmp) };
}
