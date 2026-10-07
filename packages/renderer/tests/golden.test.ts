/** golden.test.ts — whole-tree golden compare, determinism, --only, version stamp, and the
 *  no-nondeterminism grep (07 §3.1, §3.2, §3.10; item 008).
 *
 *  - Whole-tree compare: render(multiclassModel).tree equals the committed golden byte-for-byte,
 *    AND the path SET is equal (an added/removed file fails). Regenerate goldens deliberately via
 *    `bun packages/renderer/tests/golden-update.ts` — never automatically.
 *  - Render-twice is byte-identical for every file.
 *  - renderOnly(["scrape"]) yields only scrape/file_sd/* files plus a manifest whose `files` list
 *    equals exactly those paths.
 *  - web-estate-model.json and .rendered-manifest.json both carry formatVersion === RENDER_FORMAT_VERSION.
 *  - A grep of the emit-path source finds no Date/Date.now/new Date/process.pid/hostname/cwd/Math.random. */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, describe } from "bun:test";

import type { RenderedTree } from "../src/tree.js";
import { RENDER_FORMAT_VERSION } from "../src/manifest.js";
import { MANIFEST_FILENAME } from "../src/manifest.js";
import { render, renderOnly } from "../src/render/index.js";
import { multiclassModel } from "./fixtures/multiclass/model.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Recursively list every file under `dir`, returning absolute paths. */
function walkAbs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walkAbs(abs));
    else out.push(abs);
  }
  return out;
}

/** Read a committed golden tree into a path → contents map (keys are tree-relative POSIX paths). */
function readGolden(caseName: string): Map<string, string> {
  const root = join(here, "golden", `${caseName}.golden`);
  const map = new Map<string, string>();
  for (const abs of walkAbs(root)) {
    const path = relative(root, abs).split(sep).join("/");
    map.set(path, readFileSync(abs, "utf8"));
  }
  return map;
}

/** Index a rendered tree by path. */
function indexTree(tree: RenderedTree): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of tree) map.set(f.path, f.contents);
  return map;
}

describe("render() whole-tree golden compare (multiclass)", () => {
  const { tree } = render(multiclassModel);
  const rendered = indexTree(tree);
  const golden = readGolden("multiclass");

  test("path SET equals the golden (added/removed file fails)", () => {
    expect([...rendered.keys()].sort()).toEqual([...golden.keys()].sort());
  });

  test("every file's contents match the golden byte-for-byte", () => {
    for (const [path, contents] of golden) {
      expect(rendered.get(path)).toBe(contents);
    }
  });

  test("no scrape/file_sd/excluded.json is emitted", () => {
    expect(rendered.has("scrape/file_sd/excluded.json")).toBe(false);
  });

  test("the whole-tree compare FAILS on an added file", () => {
    const withExtra = new Map(rendered);
    withExtra.set("scrape/file_sd/extra.json", "[]\n");
    expect([...withExtra.keys()].sort()).not.toEqual([...golden.keys()].sort());
  });

  test("the whole-tree compare FAILS on a removed file", () => {
    const withMissing = new Map(rendered);
    withMissing.delete("gatus/config.yaml");
    expect([...withMissing.keys()].sort()).not.toEqual([...golden.keys()].sort());
  });
});

describe("determinism", () => {
  test("render-twice is byte-identical for every file", () => {
    const a = render(multiclassModel).tree;
    const b = render(multiclassModel).tree;
    expect(a.map((f) => f.path)).toEqual(b.map((f) => f.path));
    const bi = indexTree(b);
    for (const f of a) expect(bi.get(f.path)).toBe(f.contents);
  });

  test("findings are stable across renders", () => {
    expect(render(multiclassModel).findings).toEqual(render(multiclassModel).findings);
  });

  test("agent files and the manifest are byte-identical across two renders (REQ-CFG-04)", () => {
    // Item 005: a focused idempotence witness for the agent render kind — rendering identical
    // estate input twice yields byte-identical agent/<host>.yaml files AND the same manifest ledger.
    const a = indexTree(render(multiclassModel).tree);
    const b = indexTree(render(multiclassModel).tree);

    // The agent BUNDLE configs are `agent/<host>.yaml` (emitAgent). The per-host prober config
    // (issue #8) also lives under agent/ (agent/<host>/prober/config.yaml, emitProber) but is a
    // different kind — exclude it here so this witness stays scoped to the bundle configs.
    const agentPaths = (m: Map<string, string>) =>
      [...m.keys()].filter((p) => /^agent\/[^/]+\.yaml$/.test(p)).sort();
    // Both renders emit the same set of agent bundle files, one per managed-linux host
    // (dns01 is the node-exporter-only, heartbeat-off host — issue #30).
    expect(agentPaths(a)).toEqual(["agent/app02.yaml", "agent/dns01.yaml", "agent/web01.yaml"]);
    expect(agentPaths(b)).toEqual(agentPaths(a));
    for (const p of agentPaths(a)) expect(b.get(p)).toBe(a.get(p));

    // The manifest ledger (which lists the agent files) is byte-identical too.
    expect(b.get(MANIFEST_FILENAME)).toBe(a.get(MANIFEST_FILENAME));
  });
});

describe("renderOnly(['scrape'])", () => {
  const { tree } = renderOnly(multiclassModel, ["scrape"]);
  const paths = tree.map((f) => f.path).sort();

  test("emits only scrape/file_sd/* files plus the manifest", () => {
    const nonManifest = paths.filter((p) => p !== MANIFEST_FILENAME);
    expect(nonManifest.length).toBeGreaterThan(0);
    for (const p of nonManifest) expect(p.startsWith("scrape/file_sd/")).toBe(true);
    expect(paths.includes(MANIFEST_FILENAME)).toBe(true);
  });

  test("the manifest's files list equals exactly the emitted scrape paths", () => {
    const manifestFile = tree.find((f) => f.path === MANIFEST_FILENAME);
    expect(manifestFile).toBeDefined();
    const manifest = JSON.parse(manifestFile!.contents) as { files: string[]; formatVersion: number };
    const scrapePaths = paths.filter((p) => p !== MANIFEST_FILENAME);
    expect(manifest.files).toEqual(scrapePaths);
    expect(manifest.formatVersion).toBe(RENDER_FORMAT_VERSION);
  });
});

describe("version stamp (SC-07, REQ-RND-10)", () => {
  const rendered = indexTree(render(multiclassModel).tree);

  test("all three v2 web artifacts carry formatVersion === RENDER_FORMAT_VERSION", () => {
    for (const artifact of ["web-estate-model.json", "web-coverage.json", "web-findings.json"]) {
      const parsed = JSON.parse(rendered.get(artifact)!) as { formatVersion: number };
      expect(parsed.formatVersion).toBe(RENDER_FORMAT_VERSION);
    }
  });

  test("the three web artifacts share one valid bundleId (coherent per-tree identity)", () => {
    const ids = ["web-estate-model.json", "web-coverage.json", "web-findings.json"].map(
      (a) => (JSON.parse(rendered.get(a)!) as { bundleId: string }).bundleId,
    );
    expect(/^sha256:[0-9a-f]{64}$/.test(ids[0]!)).toBe(true);
    expect(new Set(ids).size).toBe(1);
  });

  test(".rendered-manifest.json carries formatVersion === RENDER_FORMAT_VERSION", () => {
    const manifest = JSON.parse(rendered.get(MANIFEST_FILENAME)!) as { formatVersion: number };
    expect(manifest.formatVersion).toBe(RENDER_FORMAT_VERSION);
  });

  test("the manifest excludes itself", () => {
    const manifest = JSON.parse(rendered.get(MANIFEST_FILENAME)!) as { files: string[] };
    expect(manifest.files.includes(MANIFEST_FILENAME)).toBe(false);
  });
});

describe("determinism grep of the emit path (REQ-DET-01)", () => {
  // The modules reachable from render() — the emit path. After the item-010 cutover the `web` kind
  // is the coordinated emitter, so web-artifacts/web-safety/web-command and coverage.ts join the
  // path. (web-artifacts.ts's `node:crypto` digest is deterministic and not a FORBIDDEN token.)
  const EMIT_PATH = [
    "render/index.ts",
    "render/scrape.ts",
    "render/gatus.ts",
    "render/alertmanager.ts",
    "render/prober.ts",
    "render/web-model.ts",
    "render/web-artifacts.ts",
    "render/web-safety.ts",
    "render/web-command.ts",
    "render/secrets.ts",
    "render/artifact-index.ts",
    "render/emit-result.ts",
    "coverage.ts",
    "order.ts",
    "format.ts",
    "findings.ts",
    "manifest.ts",
    "tree.ts",
  ];

  // Strip line and block comments so a comment that merely mentions a forbidden word
  // (e.g. "no clock/PID/hostname read") never trips the grep.
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  const FORBIDDEN: RegExp[] = [
    /\bDate\b/, // Date, Date.now, new Date
    /process\.pid\b/,
    /\bhostname\b/,
    /\bcwd\b/, // process.cwd
    /Math\.random\b/,
  ];

  for (const rel of EMIT_PATH) {
    test(`${rel} contains no nondeterminism source`, () => {
      const code = stripComments(readFileSync(join(here, "..", "src", rel), "utf8"));
      for (const re of FORBIDDEN) expect(re.test(code)).toBe(false);
    });
  }
});
