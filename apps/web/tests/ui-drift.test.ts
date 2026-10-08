// apps/web/tests/ui-drift.test.ts — the vendored @/ui drift check (scripts/ui-drift.ts, issue #5).
//
// The first block is the CI gate: the repository's own VENDORED.json must pass the offline check,
// so a vendored file that changes without a manifest update fails `bun test`. The rest drives the
// script over tests/fixtures/ui-drift (see tests/ui-drift-fixture.ts), one case per classification.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  checkOffline,
  compareUpstream,
  DEFAULT_MANIFEST,
  fetchSource,
  formatMarkdown,
  formatText,
  loadManifest,
  localSource,
  type Manifest,
  offlineFailed,
  record,
  serializeManifest,
  upstreamFailed,
} from "../scripts/ui-drift";
import { FIXTURE_MANIFEST, makeWorkspace } from "./ui-drift-fixture";

const REPO = resolve(import.meta.dir, "../../..");
const SCRIPT = resolve(import.meta.dir, "../scripts/ui-drift.ts");

describe("the repository's vendored @/ui manifest", () => {
  const manifest = loadManifest(REPO);
  const report = checkOffline(REPO, manifest);

  test("passes the offline drift check (run `bun run ui:drift` for details)", () => {
    expect({ problems: report.problems, unlisted: report.unlisted, bad: report.files.filter((f) => f.state === "undocumented" || f.state === "missing") }).toEqual({
      problems: [],
      unlisted: [],
      bad: [],
    });
  });

  test("records repo-relative paths only", () => {
    const paths = [
      ...manifest.files.flatMap((f) => [f.local, f.upstream]),
      ...manifest.localOnly.map((o) => o.local),
      ...manifest.excluded.map((e) => e.upstream),
      ...manifest.scope.local,
      ...manifest.scope.upstream,
    ];
    expect(paths.filter((p) => p.startsWith("/") || p.includes(".."))).toEqual([]);
    expect(manifest.files.every((f) => f.local.startsWith("apps/web/") && f.upstream.startsWith("apps/web/"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function workspace() {
  const ws = makeWorkspace();
  tmp = ws.tmp;
  const manifest = loadManifest(ws.root, FIXTURE_MANIFEST);
  return { ...ws, manifest };
}

const offline = (root: string, m: Manifest) => checkOffline(root, m, FIXTURE_MANIFEST);
const stateOf = (root: string, m: Manifest, local: string) => offline(root, m).files.find((f) => f.local === local);
const saveManifest = (root: string, m: Manifest) => writeFileSync(join(root, FIXTURE_MANIFEST), serializeManifest(m));

describe("offline classification", () => {
  test("the pristine fixture passes: identical and documented divergence", () => {
    const { root, manifest, upstream } = workspace();
    expect(manifest.upstream.commit).toBe(upstream.pin); // the fixture's pin is deterministic
    const r = offline(root, manifest);
    expect(Object.fromEntries(r.files.map((f) => [f.local, f.state]))).toEqual({
      "ui/same.txt": "identical",
      "ui/diverged.txt": "diverged",
      "ui/changed.txt": "identical",
      "ui/removed.txt": "identical",
    });
    expect(r.unlisted).toEqual([]);
    expect(r.problems).toEqual([]);
    expect(offlineFailed(r)).toBe(false);
  });

  test("an identical file edited without a manifest update is undocumented", () => {
    const { root, manifest } = workspace();
    appendFileSync(join(root, "ui/same.txt"), "pulse edit\n");
    const f = stateOf(root, manifest, "ui/same.txt");
    expect(f?.state).toBe("undocumented");
    expect(f?.detail).toContain("changed since recorded");
    expect(offlineFailed(offline(root, manifest))).toBe(true);
  });

  test("a diverged file edited again without a manifest update is undocumented", () => {
    const { root, manifest } = workspace();
    appendFileSync(join(root, "ui/diverged.txt"), "more pulse\n");
    expect(stateOf(root, manifest, "ui/diverged.txt")?.state).toBe("undocumented");
  });

  test("a CRLF checkout of an unchanged file still matches", () => {
    const { root, manifest } = workspace();
    writeFileSync(join(root, "ui/same.txt"), "same line\r\n");
    expect(stateOf(root, manifest, "ui/same.txt")?.state).toBe("identical");
  });

  test("a divergence without a note is undocumented", () => {
    const { root, manifest } = workspace();
    const entry = manifest.files.find((f) => f.local === "ui/diverged.txt")!;
    entry.notes = [];
    delete manifest.notes["pulse-text"];
    const f = stateOf(root, manifest, "ui/diverged.txt");
    expect(f?.state).toBe("undocumented");
    expect(f?.detail).toContain("no divergence note");
  });

  test("notes on a file identical to upstream are undocumented (stale)", () => {
    const { root, manifest } = workspace();
    manifest.files.find((f) => f.local === "ui/same.txt")!.notes = ["pulse-text"];
    expect(stateOf(root, manifest, "ui/same.txt")?.detail).toContain("identical to upstream but lists notes");
  });

  test("a deleted vendored file is missing", () => {
    const { root, manifest } = workspace();
    unlinkSync(join(root, "ui/same.txt"));
    expect(stateOf(root, manifest, "ui/same.txt")?.state).toBe("missing");
  });

  test("a new file in the local scope is unlisted until vendored or pulse-only", () => {
    const { root, manifest } = workspace();
    writeFileSync(join(root, "ui/stray.txt"), "?\n");
    expect(offline(root, manifest).unlisted).toEqual(["ui/stray.txt"]);
    manifest.localOnly.push({ local: "ui/stray.txt", source: "pulse", note: "Stray." });
    expect(offline(root, manifest).unlisted).toEqual([]);
  });

  test("manifest problems: unknown and unused notes, stale docs", () => {
    const { root, manifest } = workspace();
    manifest.notes.orphan = "Nobody uses this.";
    manifest.files[0]!.notes = ["ghost"];
    const problems = offline(root, manifest).problems.join("\n");
    expect(problems).toContain('unknown note "ghost"');
    expect(problems).toContain('note "orphan" is not used');
    expect(problems).toContain("generated sections are stale");
  });

  test("a hand edit inside a generated docs section is stale", () => {
    const { root, manifest } = workspace();
    const docs = join(root, "ui/VENDORED.md");
    writeFileSync(docs, readFileSync(docs, "utf8").replace("Pulse rewords the line.", "Edited by hand."));
    expect(offline(root, manifest).problems).toEqual(["ui/VENDORED.md: generated sections are stale; run bun run ui:drift --record"]);
  });
});

describe("upstream comparison", () => {
  test("against the pin only: recorded blobs match and every upstream file is accounted for", () => {
    const { root, manifest, upstream } = workspace();
    const r = compareUpstream(root, manifest, localSource(upstream.dir, upstream.pin));
    expect(r.pinMismatch).toEqual([]);
    expect(r.unaccountedAtPin).toEqual([]);
    expect(r.ref).toBeUndefined();
    expect(upstreamFailed(r, true)).toBe(false);
  });

  test("against a newer ref: changed, removed, new upstream and excluded changes", () => {
    const { root, manifest, upstream } = workspace();
    const r = compareUpstream(root, manifest, localSource(upstream.dir, upstream.pin, "main"));
    expect(r.ref?.sha).toBe(upstream.ref);
    expect(r.commits).toEqual([expect.stringMatching(/ ref$/)]);
    expect(r.unchanged).toBe(1); // same.txt
    expect(r.changes.map(({ upstream: u, change, pulse }) => ({ u, change, pulse }))).toEqual([
      { u: "lib/diverged.txt", change: "changed", pulse: "diverged" },
      { u: "lib/changed.txt", change: "changed", pulse: "identical" },
      { u: "lib/removed.txt", change: "removed", pulse: "identical" },
    ]);
    expect(r.newUpstream).toEqual(["lib/added.txt"]);
    expect(r.excludedChanged).toEqual(["lib/skip.txt"]);
    // Reported, not failed, unless --strict.
    expect(upstreamFailed(r, false)).toBe(false);
    expect(upstreamFailed(r, true)).toBe(true);
    const text = formatText(offline(root, manifest), r);
    expect(text).toContain("CHANGED lib/changed.txt -> ui/changed.txt (pulse identical at pin: take upstream)");
    expect(text).toContain("CHANGED lib/diverged.txt -> ui/diverged.txt (pulse diverged: merge, keep pulse-text)");
    expect(text).toContain("NEW UPSTREAM lib/added.txt");
    expect(formatMarkdown(offline(root, manifest), r)).toContain("| `lib/changed.txt` | changed | identical | take upstream |");
  });

  test("a pulse copy that already took the upstream change is marked in sync", () => {
    const { root, manifest, upstream } = workspace();
    writeFileSync(join(root, "ui/changed.txt"), "version 2\n");
    const r = compareUpstream(root, manifest, localSource(upstream.dir, upstream.pin, "main"));
    expect(r.changes.find((c) => c.upstream === "lib/changed.txt")?.alreadyInSync).toBe(true);
  });

  test("a recorded upstream blob that does not match the pin fails", () => {
    const { root, manifest, upstream } = workspace();
    manifest.files[0]!.upstreamBlob = "0".repeat(40);
    const r = compareUpstream(root, manifest, localSource(upstream.dir, upstream.pin));
    expect(r.pinMismatch).toEqual(["lib/same.txt: recorded 0000000, pin has 2a3ffa8"]);
    expect(upstreamFailed(r, false)).toBe(true);
  });

  test("an upstream file at the pin that is neither vendored nor excluded fails (new upstream)", () => {
    const { root, manifest, upstream } = workspace();
    manifest.excluded = [];
    const r = compareUpstream(root, manifest, localSource(upstream.dir, upstream.pin));
    expect(r.unaccountedAtPin).toEqual(["lib/skip.txt"]);
    expect(upstreamFailed(r, false)).toBe(true);
  });

  test("a pin that is not in the local checkout is a clear error", () => {
    const { upstream } = workspace();
    expect(() => localSource(upstream.dir, "1".repeat(40))).toThrow(/is not in/);
    // Refs reach git as arguments; one that reads as an option is refused.
    expect(() => localSource(upstream.dir, upstream.pin, "--upload-pack=touch x")).toThrow(/not a git ref/);
    expect(() => fetchSource(join(upstream.dir, "..", "c.git"), "file:///x", upstream.pin, "-x")).toThrow(/not a git ref/);
  });

  test("--fetch: depth-1 fetches of the pin and the ref into a bare cache", () => {
    const { tmp: dir, root, manifest, upstream } = workspace();
    const src = fetchSource(join(dir, "cache.git"), `file://${upstream.dir}`, upstream.pin, "main");
    expect(src.pin).toBe(upstream.pin);
    expect(src.ref?.sha).toBe(upstream.ref);
    const r = compareUpstream(root, manifest, src);
    expect(r.pinMismatch).toEqual([]);
    expect(r.commits).toBeUndefined(); // no history in a shallow cache
    expect(r.changes).toHaveLength(3);
    // A second run reuses the cached pin.
    expect(fetchSource(join(dir, "cache.git"), `file://${upstream.dir}`, upstream.pin).pin).toBe(upstream.pin);
  });
});

describe("--record", () => {
  test("re-records a reviewed edit and regenerates the docs", () => {
    const { root, manifest } = workspace();
    appendFileSync(join(root, "ui/diverged.txt"), "more pulse\n");
    manifest.notes["pulse-text"] = "Pulse rewords the line and adds one.";
    const r = record(root, manifest, { manifestPath: FIXTURE_MANIFEST });
    expect(r.errors).toEqual([]);
    expect(r.relocated).toEqual(["ui/diverged.txt"]);
    expect(r.written).toBe(true);
    const saved = loadManifest(root, FIXTURE_MANIFEST);
    expect(offlineFailed(offline(root, saved))).toBe(false);
    expect(readFileSync(join(root, "ui/VENDORED.md"), "utf8")).toContain("Pulse rewords the line and adds one.");
  });

  test("refuses to record a divergence without a note", () => {
    const { root, manifest } = workspace();
    const before = readFileSync(join(root, FIXTURE_MANIFEST), "utf8");
    appendFileSync(join(root, "ui/same.txt"), "pulse edit\n");
    const r = record(root, manifest, { manifestPath: FIXTURE_MANIFEST });
    expect(r.written).toBe(false);
    expect(r.errors).toEqual(["ui/same.txt: differs from upstream at the pin but lists no divergence note"]);
    expect(readFileSync(join(root, FIXTURE_MANIFEST), "utf8")).toBe(before);
  });

  test("bumps the pin once the sync is applied", () => {
    const { root, manifest, upstream } = workspace();
    const src = () => localSource(upstream.dir, upstream.ref);
    // Before the sync: the removed file, the new upstream file and the file that was identical
    // at the old pin (now behind the new one, with no note) block the bump.
    const blocked = record(root, manifest, { manifestPath: FIXTURE_MANIFEST, src: src() });
    expect(blocked.written).toBe(false);
    expect(blocked.errors).toEqual([
      "lib/removed.txt is not present at " + upstream.ref.slice(0, 7) + ": drop or remap its entry",
      "lib/added.txt is new upstream: vendor it (add a files entry) or add it to excluded",
      "ui/changed.txt: differs from upstream at the pin but lists no divergence note",
    ]);
    // Apply the sync: take changed.txt, merge diverged.txt, drop removed.txt, exclude added.txt.
    writeFileSync(join(root, "ui/changed.txt"), "version 2\n");
    writeFileSync(join(root, "ui/diverged.txt"), "pulse line\ndeck second line\n");
    unlinkSync(join(root, "ui/removed.txt"));
    manifest.files = manifest.files.filter((f) => f.local !== "ui/removed.txt");
    manifest.excluded.push({ upstream: "lib/added.txt", reason: "Not needed." });
    const r = record(root, manifest, { manifestPath: FIXTURE_MANIFEST, src: src() });
    expect(r.errors).toEqual([]);
    expect(r.rebased.sort()).toEqual(["ui/changed.txt", "ui/diverged.txt"]);
    const saved = loadManifest(root, FIXTURE_MANIFEST);
    expect(saved.upstream.commit).toBe(upstream.ref);
    expect(offlineFailed(offline(root, saved))).toBe(false);
    const after = compareUpstream(root, saved, localSource(upstream.dir, upstream.ref, "main"));
    expect(after.pinMismatch).toEqual([]);
    expect(after.changes).toEqual([]);
  });
});

describe("CLI", () => {
  const run = (...args: string[]) => spawnSync("bun", [SCRIPT, ...args], { encoding: "utf8" });

  test("exit 0 on a clean tree, 1 on drift, 2 on a usage error", () => {
    const { root, upstream } = workspace();
    const base = ["--root", root, "--manifest", FIXTURE_MANIFEST];
    const ok = run(...base, "--deck", upstream.dir, "--ref", "main");
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("unchanged upstream 1, changed 2, removed 1, new 1");
    expect(run(...base, "--deck", upstream.dir, "--ref", "main", "--strict").status).toBe(1);
    const diff = run(...base, "--deck", upstream.dir, "--ref", "main", "--diff");
    expect(diff.stdout).toContain("+version 2");
    appendFileSync(join(root, "ui/same.txt"), "x\n");
    const bad = run(...base);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("UNDOCUMENTED ui/same.txt");
    expect(run(...base, "--bogus").status).toBe(2);
    expect(run(...base, "--pin", "abc").status).toBe(2);
  });

  test("the default manifest path is the web app's VENDORED.json", () => {
    expect(DEFAULT_MANIFEST).toBe("apps/web/src/client/ui/VENDORED.json");
  });
});
