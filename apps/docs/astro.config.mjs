// apps/docs/astro.config.mjs
//
// Aggregated documentation site for the Pulse stack (spec 04 §8). It builds ALL
// repo Markdown behind ONE sidebar (Operator / Runbooks / Architecture) and
// fails the build on a broken internal link (§8.4, REQ-DOC-04) via the
// starlight-links-validator plugin — so `bun run docs:build` = astro build +
// link-check, single-sourced.
//
// Aggregation is the `src/content/docs/{operator,runbooks,architecture}`
// symlinks of `docs/**` (§8.1). Sidebar groups map 1:1 to those dirs and are
// ADDITIVE (autogenerate lists whatever pages exist; an empty/absent feature
// contributes nothing, never a build error — OQ-03). No bespoke accessibility
// code ships: the site relies on Starlight's accessible defaults (REQ-A11Y-01).
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLinksValidator from "starlight-links-validator";

// Absolute path of the aggregated content collection (follows the symlinks).
const CONTENT_DOCS = fileURLToPath(new URL("./src/content/docs", import.meta.url));

// Additive Architecture subgroups: one autogenerate entry per feature dir that
// actually exists under docs/architecture (via the architecture symlink).
// docs/architecture/** is generated architecture docs — read-only here and possibly absent;
// a feature with no architecture docs simply contributes nothing (OQ-03). We
// enumerate what exists at build time so we never reference a nonexistent
// autogenerate directory (which is the one thing Starlight errors on).
function architectureGroups() {
  const archDir = `${CONTENT_DOCS}/architecture`;
  if (!existsSync(archDir)) return [];
  return readdirSync(archDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      label: name,
      items: [{ autogenerate: { directory: `architecture/${name}` } }],
    }));
}

export default defineConfig({
  // REQ-CORE-02 / §8.2: derive site/base from env so the SAME build works at a
  // hosted subpath (BASE_PATH="/repo/") and at root (unset). Both are
  // undefined-safe: Astro treats an undefined `base` as "/" and an undefined
  // `site` as a relative build.
  site: process.env.SITE,
  base: process.env.BASE_PATH,
  integrations: [
    starlight({
      title: "Pulse Documentation",
      description: "Operator and architecture documentation for the Pulse stack.",
      // The single build-and-link-check gate (§8.4). Fails `astro build` on any
      // unresolved internal link so documentation drift reds CI. Links that
      // ORIGINATE from an aggregated architecture page are exempt: those pages
      // are read-only generated architecture docs authored for GitHub (relative `.md` links,
      // GitHub-style anchors) that this feature cannot fix — the gate still
      // fully covers the operator + runbook docs it owns.
      plugins: [
        starlightLinksValidator({
          exclude: ({ slug }) =>
            slug === "architecture" || slug.startsWith("architecture/"),
        }),
      ],
      sidebar: [
        { label: "Operator", items: [{ autogenerate: { directory: "operator" } }] },
        { label: "Runbooks", items: [{ autogenerate: { directory: "runbooks" } }] },
        { label: "Architecture", items: architectureGroups() },
      ],
    }),
  ],
});
