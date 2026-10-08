/**
 * ui-drift: checks the vendored `@/ui` library against deck, the upstream it was copied from.
 *
 * The machine-readable record is `apps/web/src/client/ui/VENDORED.json`. For every vendored file
 * it holds the upstream path, the git blob id of the upstream file at the pinned deck commit
 * (`upstreamBlob`), the blob id of pulse's copy as last reviewed (`localBlob`), and the ids of the
 * divergence notes that explain any difference. A note's prose lives once, in `notes`, and the
 * mapping and pulse-only tables in `VENDORED.md` are generated from the manifest.
 *
 * Offline mode (the default, run by `bun test` in CI) needs no network and no deck checkout:
 *   - a file whose content no longer matches `localBlob` changed without a manifest update;
 *   - a file that differs from `upstreamBlob` must list at least one note, and a file equal to
 *     it must list none;
 *   - every file under the local scope is either vendored or listed as pulse-only;
 *   - the generated sections of `VENDORED.md` match the manifest.
 *
 * Upstream mode (`--deck <dir>` or `--fetch`) also reads deck's git history:
 *   - every recorded `upstreamBlob` must match deck at the pin, and every upstream file in scope
 *     at the pin must be vendored or excluded;
 *   - against a newer ref (`--ref`, default the manifest's `defaultRef`) it reports the vendored
 *     files deck changed or removed since the pin and the files deck added. That part only
 *     reports; `--strict` turns it into a failure.
 *
 * `--record` rewrites the hashes (and, with `--pin` and a deck source, bumps the pin) after a
 * reviewed change, then regenerates `VENDORED.md`. It refuses to write a manifest that would not
 * pass the offline check. Usage: `bun run ui:drift --help`.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const DEFAULT_MANIFEST = "apps/web/src/client/ui/VENDORED.json";
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const DEFAULT_CACHE = "node_modules/.cache/ui-drift/upstream.git";

// ---------------------------------------------------------------------------------------------
// Manifest

export interface FileEntry {
  /** Repo-relative path of pulse's copy. */
  local: string;
  /** Path of the file in the upstream repository. */
  upstream: string;
  /** Git blob id of the upstream file at the pinned commit. */
  upstreamBlob: string;
  /** Git blob id of pulse's copy as last reviewed (CRLF normalised to LF). */
  localBlob: string;
  /** Ids of the `notes` that explain how pulse's copy differs; empty when identical. */
  notes: string[];
}

export interface Manifest {
  $comment?: string;
  upstream: {
    /** Clone URL used by `--fetch`. */
    repo: string;
    /** Full sha of the pinned upstream commit. */
    commit: string;
    /** Human description of the pin (version, provenance). */
    describe?: string;
    /** Ref compared against the pin in upstream mode when `--ref` is not given. */
    defaultRef: string;
  };
  /** Repo-relative markdown file with generated sections that mirror this manifest. */
  docs?: string;
  /** Path prefixes (ending in `/`) or exact files: what counts as "the library" on each side. */
  scope: { upstream: string[]; local: string[] };
  notes: Record<string, string>;
  files: FileEntry[];
  /** Upstream files in scope that are deliberately not vendored. */
  excluded: { upstream: string; reason: string }[];
  /** Local files in scope that are not vendored (a trailing `/` covers a directory). */
  localOnly: { local: string; source: string; note: string }[];
}

export function loadManifest(root: string, manifestPath = DEFAULT_MANIFEST): Manifest {
  const raw = readFileSync(join(root, manifestPath), "utf8");
  return JSON.parse(raw) as Manifest;
}

export function serializeManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function inScope(path: string, scope: readonly string[]): boolean {
  return scope.some((s) => (s.endsWith("/") ? path.startsWith(s) : path === s));
}

// ---------------------------------------------------------------------------------------------
// Hashing and file listing

/** The git blob id of `content` (what `git hash-object` prints), with CRLF normalised to LF. */
export function blobId(content: Uint8Array): string {
  let bytes = Buffer.from(content);
  if (bytes.includes(13)) bytes = Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function localBlob(root: string, path: string): string | null {
  const abs = join(root, path);
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  return blobId(readFileSync(abs));
}

function walk(root: string, rel: string, out: string[]): void {
  const abs = join(root, rel);
  if (!existsSync(abs)) return;
  if (statSync(abs).isFile()) {
    out.push(rel);
    return;
  }
  for (const name of readdirSync(abs).sort()) walk(root, rel.endsWith("/") ? rel + name : `${rel}/${name}`, out);
}

function listLocal(root: string, scope: readonly string[]): string[] {
  const out: string[] = [];
  for (const s of scope) walk(root, s, out);
  return [...new Set(out)].sort();
}

// ---------------------------------------------------------------------------------------------
// Offline check

export type FileState = "identical" | "diverged" | "undocumented" | "missing";

export interface FileResult {
  local: string;
  upstream: string;
  state: FileState;
  /** Why the file is undocumented or missing. */
  detail?: string;
  notes: string[];
  /** The file's current blob id (null when missing). */
  actualBlob: string | null;
}

export interface OfflineReport {
  pin: string;
  describe?: string | undefined;
  files: FileResult[];
  /** Local files in scope that are neither vendored nor pulse-only. */
  unlisted: string[];
  /** Manifest-level problems (bad note references, stale docs, missing pulse-only paths, …). */
  problems: string[];
}

const BLOB_RE = /^[0-9a-f]{40}$/;

function validateManifest(m: Manifest, problems: string[]): void {
  if (!/^[0-9a-f]{40}$/.test(m.upstream.commit)) problems.push(`upstream.commit must be a full 40-char sha, got "${m.upstream.commit}"`);
  const seenLocal = new Set<string>();
  const seenUpstream = new Set<string>();
  const used = new Set<string>();
  for (const f of m.files) {
    if (seenLocal.has(f.local)) problems.push(`duplicate local path in files: ${f.local}`);
    if (seenUpstream.has(f.upstream)) problems.push(`duplicate upstream path in files: ${f.upstream}`);
    seenLocal.add(f.local);
    seenUpstream.add(f.upstream);
    if (!BLOB_RE.test(f.upstreamBlob)) problems.push(`${f.local}: upstreamBlob is not a blob id (run --record with a deck source)`);
    if (!BLOB_RE.test(f.localBlob)) problems.push(`${f.local}: localBlob is not a blob id (run --record)`);
    if (!inScope(f.upstream, m.scope.upstream)) problems.push(`${f.local}: upstream path ${f.upstream} is outside scope.upstream`);
    for (const n of f.notes) {
      if (!(n in m.notes)) problems.push(`${f.local}: unknown note "${n}"`);
      used.add(n);
    }
  }
  for (const id of Object.keys(m.notes)) if (!used.has(id)) problems.push(`note "${id}" is not used by any file`);
  for (const e of m.excluded) {
    if (seenUpstream.has(e.upstream)) problems.push(`${e.upstream} is both vendored and excluded`);
    if (!e.reason.trim()) problems.push(`excluded ${e.upstream} has no reason`);
  }
}

export function checkOffline(root: string, manifest: Manifest, manifestPath = DEFAULT_MANIFEST): OfflineReport {
  const problems: string[] = [];
  validateManifest(manifest, problems);
  const files: FileResult[] = manifest.files.map((f) => {
    const actual = localBlob(root, f.local);
    const base = { local: f.local, upstream: f.upstream, notes: f.notes, actualBlob: actual };
    if (actual === null) return { ...base, state: "missing", detail: "vendored file is missing in pulse" };
    if (actual !== f.localBlob)
      return {
        ...base,
        state: "undocumented",
        detail: `changed since recorded (blob ${actual.slice(0, 7)}, recorded ${f.localBlob.slice(0, 7)}): review its divergence notes, then run --record`,
      };
    if (actual === f.upstreamBlob) {
      if (f.notes.length > 0) return { ...base, state: "undocumented", detail: `identical to upstream but lists notes (${f.notes.join(", ")}): drop them` };
      return { ...base, state: "identical" };
    }
    if (f.notes.length === 0) return { ...base, state: "undocumented", detail: "differs from upstream at the pin but lists no divergence note" };
    return { ...base, state: "diverged" };
  });

  const vendored = new Set(manifest.files.map((f) => f.local));
  const ignored = new Set([manifestPath, manifest.docs].filter((p): p is string => !!p));
  const unlisted = listLocal(root, manifest.scope.local).filter(
    (p) => !vendored.has(p) && !ignored.has(p) && !inScope(p, manifest.localOnly.map((o) => o.local)),
  );
  for (const o of manifest.localOnly) {
    if (!existsSync(join(root, o.local))) problems.push(`pulse-only path ${o.local} does not exist`);
    if (vendored.has(o.local)) problems.push(`${o.local} is both vendored and pulse-only`);
  }

  if (manifest.docs) problems.push(...docsProblems(root, manifest));
  return { pin: manifest.upstream.commit, describe: manifest.upstream.describe, files, unlisted, problems };
}

export function offlineFailed(r: OfflineReport): boolean {
  return r.problems.length > 0 || r.unlisted.length > 0 || r.files.some((f) => f.state === "undocumented" || f.state === "missing");
}

// ---------------------------------------------------------------------------------------------
// Generated docs sections

const SECTIONS = ["source", "mapping", "notes", "pulse-only"] as const;
type Section = (typeof SECTIONS)[number];

const begin = (s: Section) => `<!-- ui-drift:begin ${s} (generated from VENDORED.json by \`bun run ui:drift --record\`; do not edit) -->`;
const end = (s: Section) => `<!-- ui-drift:end ${s} -->`;

export function renderSections(m: Manifest): Record<Section, string> {
  const code = (s: string) => `\`${s}\``;
  const source = [
    `Pinned upstream: ${m.upstream.repo.replace(/\.git$/, "")} at ${code(m.upstream.commit.slice(0, 7))}` +
      (m.upstream.describe ? ` (${m.upstream.describe})` : "") +
      `. Vendored files: ${m.files.length}, ${m.files.filter((f) => f.notes.length > 0).length} of them with pulse divergences. ` +
      `Upstream files in scope that are deliberately not vendored: ${m.excluded.length}.`,
  ].join("\n");

  const mapping = [
    "| Pulse path | Deck path | Divergence notes |",
    "|---|---|---|",
    ...m.files.map((f) => `| ${code(f.local)} | ${code(f.upstream)} | ${f.notes.length ? f.notes.map(code).join(", ") : "None"} |`),
    "",
    "Not vendored:",
    "",
    ...m.excluded.map((e) => `- ${code(e.upstream)}: ${e.reason}`),
  ].join("\n");

  const notes = Object.entries(m.notes)
    .map(([id, text]) => {
      const users = m.files.filter((f) => f.notes.includes(id)).map((f) => code(f.local.split("/").pop() ?? f.local));
      return `- **${code(id)}** (${users.join(", ")}): ${text}`;
    })
    .join("\n");

  const pulseOnly = [
    "| Pulse path | Source | Notes |",
    "|---|---|---|",
    ...m.localOnly.map((o) => `| ${code(o.local)} | ${o.source} | ${o.note.replace(/\|/g, "\\|")} |`),
  ].join("\n");

  return { source, mapping, notes, "pulse-only": pulseOnly };
}

function replaceSection(doc: string, s: Section, body: string): string | null {
  const b = doc.indexOf(begin(s));
  const e = doc.indexOf(end(s));
  if (b < 0 || e < b) return null;
  return `${doc.slice(0, b)}${begin(s)}\n${body}\n${doc.slice(e)}`;
}

function renderDocs(doc: string, m: Manifest): { doc: string; missing: Section[] } {
  const rendered = renderSections(m);
  const missing: Section[] = [];
  let out = doc;
  for (const s of SECTIONS) {
    const next = replaceSection(out, s, rendered[s]);
    if (next === null) missing.push(s);
    else out = next;
  }
  return { doc: out, missing };
}

function docsProblems(root: string, m: Manifest): string[] {
  if (!m.docs) return [];
  const path = join(root, m.docs);
  if (!existsSync(path)) return [`docs file ${m.docs} does not exist`];
  const doc = readFileSync(path, "utf8");
  const { doc: next, missing } = renderDocs(doc, m);
  const out = missing.map((s) => `${m.docs}: missing generated section markers for "${s}"`);
  if (missing.length === 0 && next !== doc) out.push(`${m.docs}: generated sections are stale; run bun run ui:drift --record`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Upstream (git) sources

function git(dir: string, args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

/** Refs reach `git fetch` and `git rev-parse` as arguments: never let one read as an option. */
function assertRef(ref: string): string {
  if (ref.startsWith("-") || !/^[\w./@^~{}-]+$/.test(ref)) throw new Error(`not a git ref: ${JSON.stringify(ref)}`);
  return ref;
}

function resolveCommit(dir: string, ref: string): string | null {
  assertRef(ref);
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export interface UpstreamSource {
  /** A git directory (checkout or bare) holding the commits. */
  dir: string;
  /** How the source was obtained, for the report. */
  label: string;
  /** Full sha of the pin. */
  pin: string;
  /** The newer ref to compare against, if any. */
  ref?: { name: string; sha: string };
}

/** Use a local deck checkout. The pin (and ref) must already be in its object store. */
export function localSource(dir: string, pin: string, ref?: string): UpstreamSource {
  if (!existsSync(dir)) throw new Error(`deck directory ${dir} does not exist`);
  const pinSha = resolveCommit(dir, pin);
  if (!pinSha) throw new Error(`pinned commit ${pin} is not in ${dir}; fetch it first (git -C <deck> fetch origin ${pin})`);
  const out: UpstreamSource = { dir, label: "local checkout", pin: pinSha };
  if (ref) {
    const sha = resolveCommit(dir, ref);
    if (!sha) throw new Error(`ref ${ref} does not resolve in ${dir}`);
    out.ref = { name: ref, sha };
  }
  return out;
}

/**
 * Fetch the pin (and ref) from `repo` into a bare cache repository with depth-1 fetches. Fetching
 * a commit by sha works against GitHub; for other servers it needs `uploadpack.allowAnySHA1InWant`.
 */
export function fetchSource(cacheDir: string, repo: string, pin: string, ref?: string): UpstreamSource {
  if (!existsSync(join(cacheDir, "HEAD"))) {
    mkdirSync(cacheDir, { recursive: true });
    git(cacheDir, ["init", "--bare", "--quiet"]);
  }
  if (ref) assertRef(ref);
  if (repo.startsWith("-")) throw new Error(`not a repository URL: ${repo}`);
  if (!resolveCommit(cacheDir, pin)) git(cacheDir, ["fetch", "--quiet", "--depth=1", "--no-tags", repo, pin]);
  const pinSha = resolveCommit(cacheDir, pin);
  if (!pinSha) throw new Error(`could not fetch pinned commit ${pin} from ${repo}`);
  const out: UpstreamSource = { dir: cacheDir, label: `fetched from ${repo}`, pin: pinSha };
  if (ref) {
    git(cacheDir, ["fetch", "--quiet", "--depth=1", "--no-tags", repo, ref]);
    out.ref = { name: ref, sha: git(cacheDir, ["rev-parse", "FETCH_HEAD^{commit}"]).trim() };
  }
  return out;
}

/** Map of path → blob id for the files in scope at `commit`. */
export function listTree(dir: string, commit: string, scope: readonly string[]): Map<string, string> {
  const specs = scope.map((s) => (s.endsWith("/") ? s.slice(0, -1) : s));
  const out = new Map<string, string>();
  const text = git(dir, ["ls-tree", "-r", "--full-tree", "-z", commit, "--", ...specs]);
  for (const line of text.split("\0")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    const [, type, sha] = line.slice(0, tab).split(" ");
    const path = line.slice(tab + 1);
    if (type === "blob" && sha && inScope(path, scope)) out.set(path, sha);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Upstream comparison

export interface UpstreamChange {
  local: string;
  upstream: string;
  change: "changed" | "removed";
  /** Pulse's copy is identical to the pin (copy the new upstream file) or diverged (merge). */
  pulse: "identical" | "diverged";
  notes: string[];
  /** Pulse's copy already equals upstream at the ref. */
  alreadyInSync: boolean;
}

export interface UpstreamReport {
  source: string;
  pin: string;
  /** Recorded `upstreamBlob`s that do not match deck at the pin (or files missing there). */
  pinMismatch: string[];
  /** Upstream files in scope at the pin that are neither vendored nor excluded. */
  unaccountedAtPin: string[];
  ref?: { name: string; sha: string };
  /** Commits between the pin and the ref, when the history is available. */
  commits?: string[];
  changes: UpstreamChange[];
  /** Files in scope at the ref that are not at the pin and are neither vendored nor excluded. */
  newUpstream: string[];
  /** Excluded files that changed upstream (informational). */
  excludedChanged: string[];
  unchanged: number;
}

export function compareUpstream(root: string, manifest: Manifest, src: UpstreamSource): UpstreamReport {
  const scope = manifest.scope.upstream;
  const atPin = listTree(src.dir, src.pin, scope);
  const vendored = new Set(manifest.files.map((f) => f.upstream));
  const excluded = new Set(manifest.excluded.map((e) => e.upstream));
  const pinMismatch: string[] = [];
  for (const f of manifest.files) {
    const blob = atPin.get(f.upstream);
    if (!blob) pinMismatch.push(`${f.upstream}: not present at the pin`);
    else if (blob !== f.upstreamBlob) pinMismatch.push(`${f.upstream}: recorded ${f.upstreamBlob.slice(0, 7)}, pin has ${blob.slice(0, 7)}`);
  }
  const unaccountedAtPin = [...atPin.keys()].filter((p) => !vendored.has(p) && !excluded.has(p));
  const report: UpstreamReport = {
    source: src.label,
    pin: src.pin,
    pinMismatch,
    unaccountedAtPin,
    changes: [],
    newUpstream: [],
    excludedChanged: [],
    unchanged: 0,
  };
  if (!src.ref) return report;

  report.ref = src.ref;
  const r = spawnSync("git", ["-C", src.dir, "log", "--format=%h %s", `${src.pin}..${src.ref.sha}`], { encoding: "utf8" });
  // A shallow fetch has no history between the two commits, so the log is left out there.
  if (r.status === 0 && !existsSync(join(src.dir, "shallow"))) report.commits = r.stdout.split("\n").filter(Boolean);

  const atRef = listTree(src.dir, src.ref.sha, scope);
  for (const f of manifest.files) {
    const pinBlob = atPin.get(f.upstream);
    const refBlob = atRef.get(f.upstream);
    if (pinBlob && refBlob === pinBlob) {
      report.unchanged++;
      continue;
    }
    const actual = localBlob(root, f.local);
    report.changes.push({
      local: f.local,
      upstream: f.upstream,
      change: refBlob ? "changed" : "removed",
      pulse: f.localBlob === f.upstreamBlob ? "identical" : "diverged",
      notes: f.notes,
      alreadyInSync: !!refBlob && actual === refBlob,
    });
  }
  for (const [p, blob] of atRef) {
    if (vendored.has(p)) continue;
    if (excluded.has(p)) {
      if (atPin.get(p) !== blob) report.excludedChanged.push(p);
    } else if (!atPin.has(p)) report.newUpstream.push(p);
  }
  for (const p of excluded) if (atPin.has(p) && !atRef.has(p)) report.excludedChanged.push(`${p} (removed)`);
  return report;
}

export function upstreamFailed(r: UpstreamReport, strict: boolean): boolean {
  if (r.pinMismatch.length > 0 || r.unaccountedAtPin.length > 0) return true;
  return strict && (r.changes.length > 0 || r.newUpstream.length > 0);
}

export function upstreamDiff(src: UpstreamSource, paths: string[]): string {
  if (!src.ref || paths.length === 0) return "";
  return git(src.dir, ["diff", "--no-color", src.pin, src.ref.sha, "--", ...paths]);
}

// ---------------------------------------------------------------------------------------------
// Record

export interface RecordResult {
  written: boolean;
  errors: string[];
  /** Files whose recorded local blob changed: their notes need a human look. */
  relocated: string[];
  /** Files whose recorded upstream blob changed (pin bump). */
  rebased: string[];
  manifest: Manifest;
}

/**
 * Re-record hashes and regenerate the docs. With `src`, the upstream blobs are re-read at
 * `src.pin`, which becomes the manifest's pin (that is how the pin is bumped). Writes nothing
 * unless the result passes the offline check (and, with `src`, the pin check).
 */
export function record(root: string, manifest: Manifest, opts: { src?: UpstreamSource; manifestPath?: string; dryRun?: boolean } = {}): RecordResult {
  const manifestPath = opts.manifestPath ?? DEFAULT_MANIFEST;
  const next: Manifest = structuredClone(manifest);
  const errors: string[] = [];
  const relocated: string[] = [];
  const rebased: string[] = [];
  if (opts.src) {
    next.upstream.commit = opts.src.pin;
    const atPin = listTree(opts.src.dir, opts.src.pin, next.scope.upstream);
    for (const f of next.files) {
      const blob = atPin.get(f.upstream);
      if (!blob) errors.push(`${f.upstream} is not present at ${opts.src.pin.slice(0, 7)}: drop or remap its entry`);
      else if (blob !== f.upstreamBlob) {
        rebased.push(f.local);
        f.upstreamBlob = blob;
      }
    }
    const vendored = new Set(next.files.map((f) => f.upstream));
    const excluded = new Set(next.excluded.map((e) => e.upstream));
    for (const p of atPin.keys()) if (!vendored.has(p) && !excluded.has(p)) errors.push(`${p} is new upstream: vendor it (add a files entry) or add it to excluded`);
  }
  for (const f of next.files) {
    const actual = localBlob(root, f.local);
    if (actual === null) continue; // reported by the check below
    if (actual !== f.localBlob) {
      relocated.push(f.local);
      f.localBlob = actual;
    }
  }
  const report = checkOffline(root, next, manifestPath);
  errors.push(
    ...report.problems.filter((p) => !p.includes("generated sections are stale")),
    ...report.unlisted.map((p) => `${p} is in the local scope but neither vendored nor pulse-only: add it to files or localOnly`),
    ...report.files.filter((f) => f.state === "undocumented" || f.state === "missing").map((f) => `${f.local}: ${f.detail}`),
  );
  const result: RecordResult = { written: false, errors, relocated, rebased, manifest: next };
  if (errors.length > 0 || opts.dryRun) return result;
  writeFileSync(join(root, manifestPath), serializeManifest(next));
  if (next.docs) {
    const path = join(root, next.docs);
    writeFileSync(path, renderDocs(readFileSync(path, "utf8"), next).doc);
  }
  result.written = true;
  return result;
}

// ---------------------------------------------------------------------------------------------
// Reports

const short = (sha: string) => sha.slice(0, 7);

export function formatText(off: OfflineReport, up?: UpstreamReport): string {
  const lines: string[] = [];
  const count = (s: FileState) => off.files.filter((f) => f.state === s).length;
  lines.push(`ui-drift: ${off.files.length} vendored files, pin ${short(off.pin)}${off.describe ? ` (${off.describe})` : ""}`);
  lines.push(`  identical ${count("identical")}, diverged (documented) ${count("diverged")}, undocumented ${count("undocumented")}, missing ${count("missing")}`);
  for (const f of off.files) if (f.state === "undocumented" || f.state === "missing") lines.push(`  ${f.state.toUpperCase()} ${f.local}: ${f.detail}`);
  for (const p of off.unlisted) lines.push(`  UNLISTED ${p}: neither vendored nor pulse-only`);
  for (const p of off.problems) lines.push(`  PROBLEM ${p}`);
  if (!offlineFailed(off)) lines.push("  ok: every vendored file matches its recorded hash and divergence notes");
  if (up) {
    lines.push("", `upstream (${up.source}): pin ${short(up.pin)}`);
    if (up.pinMismatch.length === 0 && up.unaccountedAtPin.length === 0) lines.push("  ok: recorded upstream blobs match the pin, and every upstream file at the pin is vendored or excluded");
    for (const p of up.pinMismatch) lines.push(`  PIN MISMATCH ${p}`);
    for (const p of up.unaccountedAtPin) lines.push(`  NEW UPSTREAM AT PIN ${p}: vendor it or exclude it`);
    if (up.ref) {
      lines.push(`  compared with ${up.ref.name} (${short(up.ref.sha)})${up.commits ? `, ${up.commits.length} commits since the pin` : ""}:`);
      lines.push(`  unchanged upstream ${up.unchanged}, changed ${up.changes.filter((c) => c.change === "changed").length}, removed ${up.changes.filter((c) => c.change === "removed").length}, new ${up.newUpstream.length}`);
      for (const c of up.changes) {
        const how = c.alreadyInSync ? "pulse already matches" : c.pulse === "identical" ? "pulse identical at pin: take upstream" : `pulse diverged: merge, keep ${c.notes.join(", ")}`;
        lines.push(`  ${c.change.toUpperCase()} ${c.upstream} -> ${c.local} (${how})`);
      }
      for (const p of up.newUpstream) lines.push(`  NEW UPSTREAM ${p}: not vendored or excluded`);
      for (const p of up.excludedChanged) lines.push(`  excluded, changed upstream: ${p}`);
    }
  }
  return lines.join("\n");
}

export function formatMarkdown(off: OfflineReport, up?: UpstreamReport): string {
  const code = (s: string) => `\`${s}\``;
  const out: string[] = [];
  const count = (s: FileState) => off.files.filter((f) => f.state === s).length;
  out.push(`### Vendored \`@/ui\` drift`, "");
  out.push(`Pin ${code(short(off.pin))}${off.describe ? ` (${off.describe})` : ""}: ${off.files.length} files, ${count("identical")} identical, ${count("diverged")} diverged as documented, ${count("undocumented")} undocumented, ${count("missing")} missing, ${off.unlisted.length} unlisted.`);
  const bad = off.files.filter((f) => f.state === "undocumented" || f.state === "missing");
  if (bad.length || off.unlisted.length || off.problems.length) {
    out.push("", "| File | State | Detail |", "|---|---|---|");
    for (const f of bad) out.push(`| ${code(f.local)} | ${f.state} | ${f.detail ?? ""} |`);
    for (const p of off.unlisted) out.push(`| ${code(p)} | unlisted | neither vendored nor pulse-only |`);
    for (const p of off.problems) out.push(`| | problem | ${p} |`);
  }
  if (up) {
    out.push("", `#### Upstream (${up.source})`, "");
    out.push(up.pinMismatch.length || up.unaccountedAtPin.length ? "Pin check **failed**:" : `Pin ${code(short(up.pin))}: recorded blobs match, every upstream file is vendored or excluded.`);
    for (const p of up.pinMismatch) out.push(`- pin mismatch: ${p}`);
    for (const p of up.unaccountedAtPin) out.push(`- new upstream at the pin: ${code(p)}`);
    if (up.ref) {
      out.push("", `Compared with ${code(up.ref.name)} (${code(short(up.ref.sha))})${up.commits ? `, ${up.commits.length} commits since the pin` : ""}: ${up.unchanged} vendored files unchanged upstream.`);
      if (up.changes.length) {
        out.push("", "| Deck path | Change | Pulse copy | Action |", "|---|---|---|---|");
        for (const c of up.changes) {
          const action = c.alreadyInSync ? "already in sync" : c.change === "removed" ? "decide: drop or keep as pulse-only" : c.pulse === "identical" ? "take upstream" : `merge; keep ${c.notes.map(code).join(", ")}`;
          out.push(`| ${code(c.upstream)} | ${c.change} | ${c.pulse} | ${action} |`);
        }
      }
      if (up.newUpstream.length) out.push("", "New upstream files (not vendored, not excluded):", "", ...up.newUpstream.map((p) => `- ${code(p)}`));
      if (up.excludedChanged.length) out.push("", "Excluded files changed upstream:", "", ...up.excludedChanged.map((p) => `- ${code(p)}`));
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------
// CLI

const HELP = `Usage: bun run ui:drift [options]

Checks the vendored @/ui library (apps/web/src/client/ui/VENDORED.json) against deck.

Modes:
  (no source)            Offline check: hashes, divergence notes, unlisted files, generated docs.
  --deck <dir>           Also compare with deck from a local git checkout.
  --fetch                Also compare with deck fetched from the manifest's repo into a cache.

Options:
  --ref <ref>            Newer deck ref to compare with the pin (default: the manifest's
                         defaultRef). --ref none checks the pin only.
  --repo <url>           Clone URL for --fetch (default: the manifest's upstream.repo).
  --cache <dir>          Cache for --fetch (default: ${DEFAULT_CACHE}).
  --diff                 Print the upstream diff (pin..ref) of the vendored files that changed.
  --strict               Fail when deck changed vendored files or added files since the pin.
  --record               Re-record local hashes and regenerate VENDORED.md. With a source and
                         --pin <ref>, also re-read the upstream blobs at that commit (bump).
  --pin <ref>            The commit to pin with --record (default: the current pin).
  --format <f>           text (default), markdown or json.
  --root <dir>           Repository root (default: this repository).
  --manifest <path>      Manifest path relative to the root (default: ${DEFAULT_MANIFEST}).

Exit codes: 0 ok, 1 check failed, 2 usage or source error.`;

interface Args {
  root: string;
  manifest: string;
  deck?: string;
  fetch: boolean;
  ref?: string;
  repo?: string;
  cache?: string;
  diff: boolean;
  strict: boolean;
  record: boolean;
  pin?: string;
  format: "text" | "markdown" | "json";
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { root: REPO_ROOT, manifest: DEFAULT_MANIFEST, fetch: false, diff: false, strict: false, record: false, format: "text", help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--root": a.root = resolve(value()); break;
      case "--manifest": a.manifest = value(); break;
      case "--deck": a.deck = resolve(value()); break;
      case "--fetch": a.fetch = true; break;
      case "--ref": a.ref = value(); break;
      case "--repo": a.repo = value(); break;
      case "--cache": a.cache = value(); break;
      case "--diff": a.diff = true; break;
      case "--strict": a.strict = true; break;
      case "--record": a.record = true; break;
      case "--pin": a.pin = value(); break;
      case "--format": {
        const f = value();
        if (f !== "text" && f !== "markdown" && f !== "json") throw new Error(`unknown format ${f}`);
        a.format = f;
        break;
      }
      case "-h":
      case "--help": a.help = true; break;
      default: throw new Error(`unknown option ${flag}`);
    }
  }
  if (a.deck && a.fetch) throw new Error("--deck and --fetch are exclusive");
  if (a.pin && !a.record) throw new Error("--pin only applies with --record");
  if (a.pin && !a.deck && !a.fetch) throw new Error("--pin needs a source (--deck or --fetch)");
  return a;
}

export function main(argv: string[]): number {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`ui-drift: ${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const manifest = loadManifest(args.root, args.manifest);
  const pin = args.pin ?? manifest.upstream.commit;
  const ref = args.record ? undefined : args.ref === "none" ? undefined : (args.ref ?? manifest.upstream.defaultRef);

  let src: UpstreamSource | undefined;
  try {
    if (args.deck) src = localSource(args.deck, pin, ref);
    else if (args.fetch) src = fetchSource(resolve(args.root, args.cache ?? DEFAULT_CACHE), args.repo ?? manifest.upstream.repo, pin, ref);
  } catch (e) {
    console.error(`ui-drift: ${(e as Error).message}`);
    return 2;
  }

  if (args.record) {
    const r = record(args.root, manifest, { manifestPath: args.manifest, ...(src ? { src } : {}) });
    for (const e of r.errors) console.error(`ui-drift: ${e}`);
    if (!r.written) {
      console.error("ui-drift: manifest not written");
      return 1;
    }
    if (src && src.pin !== manifest.upstream.commit) console.log(`ui-drift: pin ${short(manifest.upstream.commit)} -> ${short(src.pin)}`);
    for (const p of r.rebased) console.log(`ui-drift: upstream changed: ${p}`);
    const notesOf = new Map(r.manifest.files.map((f) => [f.local, f.notes]));
    for (const p of r.relocated) {
      const notes = notesOf.get(p) ?? [];
      console.log(`ui-drift: re-recorded ${p}: ${notes.length ? `check that ${notes.join(", ")} still describe it` : "identical to deck"}`);
    }
    console.log(`ui-drift: wrote ${args.manifest}${manifest.docs ? ` and ${manifest.docs}` : ""}`);
    return 0;
  }

  const off = checkOffline(args.root, manifest, args.manifest);
  let up: UpstreamReport | undefined;
  try {
    if (src) up = compareUpstream(args.root, manifest, src);
  } catch (e) {
    console.error(`ui-drift: ${(e as Error).message}`);
    return 2;
  }
  if (args.format === "json") console.log(JSON.stringify({ offline: off, upstream: up }, null, 2));
  else if (args.format === "markdown") console.log(formatMarkdown(off, up));
  else console.log(formatText(off, up));
  if (args.diff && src && up) {
    const diff = upstreamDiff(src, up.changes.filter((c) => c.change === "changed").map((c) => c.upstream));
    if (diff) console.log(args.format === "markdown" ? `\n<details><summary>Upstream diff</summary>\n\n\`\`\`diff\n${diff}\`\`\`\n\n</details>` : `\n${diff}`);
  }
  return offlineFailed(off) || (up && upstreamFailed(up, args.strict)) ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));

