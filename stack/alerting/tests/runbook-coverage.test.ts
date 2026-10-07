// stack/alerting/tests/runbook-coverage.test.ts
// Regression guard for issue #28: every `runbook_url` slug an alert can carry MUST resolve to an
// authored runbook page under docs/runbooks/. Slugs come from two sources — the committed static
// rule files (which bake `${RUNBOOK_BASE_URL}/<family>` literals) and the dynamic builders (which
// use RUNBOOK_SLUGS via runbookUrl()). Adding an alert family with a new slug but no runbook keeps
// this red until the doc exists.
/// <reference path="./bun-test.d.ts" />
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { RUNBOOK_BASE_URL, RUNBOOK_SLUGS } from "../src/constants.js";
import { REPO_ROOT, STATIC_RULES_DIR } from "./paths.js";

/** docs/runbooks — where each `<slug>.md` incident runbook lives. */
const RUNBOOKS_DIR = resolve(REPO_ROOT, "docs", "runbooks");

/** Minimal shape of a vmalert rule file for reading runbook_url annotations. */
type RuleFile = {
  groups?: Array<{ rules?: Array<{ annotations?: Record<string, unknown> }> }>;
};

/** The exact `<base>/` prefix a well-formed runbook_url carries — used for BOTH the match and the
 *  strip so a URL that shares the host but not the `/<slug>` shape can never yield a bogus slug. */
const RUNBOOK_URL_PREFIX = `${RUNBOOK_BASE_URL}/`;

/** Bare slug from a full runbook_url (e.g. `…/churn` → `churn`), or `undefined` if it is not the
 *  expected `<base>/<slug>` shape. */
function slugOf(url: string): string | undefined {
  return url.startsWith(RUNBOOK_URL_PREFIX) ? url.slice(RUNBOOK_URL_PREFIX.length) : undefined;
}

/** Every distinct slug the static rule files bake into a `runbook_url` annotation. */
function staticRuleSlugs(): Set<string> {
  const slugs = new Set<string>();
  for (const file of readdirSync(STATIC_RULES_DIR).filter((f) => f.endsWith(".yml"))) {
    const doc = parse(readFileSync(join(STATIC_RULES_DIR, file), "utf8")) as RuleFile;
    for (const group of doc.groups ?? []) {
      for (const rule of group.rules ?? []) {
        const url = rule.annotations?.runbook_url;
        const slug = typeof url === "string" ? slugOf(url) : undefined;
        if (slug !== undefined) slugs.add(slug);
      }
    }
  }
  return slugs;
}

/** Read the `slug:` value from a runbook markdown file's YAML front-matter — the leading
 *  `---`-fenced block only, so a `slug:`-initial line in the prose body can never be mistaken for it. */
function frontmatterSlug(mdPath: string): string | undefined {
  const frontmatter = readFileSync(mdPath, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  return frontmatter?.match(/^slug:\s*(\S+)\s*$/m)?.[1];
}

// Static-file slugs (availability, canary, capacity, churn, deadman, engine, pipeline-health) plus
// the dynamic-builder slugs (deep-health, backup-freshness) — the complete set an operator can be
// paged onto.
const allSlugs = [...new Set([...staticRuleSlugs(), ...Object.values(RUNBOOK_SLUGS)])].sort();

describe("runbook coverage — every runbook_url slug has an authored runbook (issue #28)", () => {
  test("the static rules contribute the expected seven family slugs", () => {
    // Guards against a rule file silently dropping (or typo-ing) its runbook_url so the slug set
    // never quietly shrinks below the known families.
    expect([...staticRuleSlugs()].sort()).toEqual([
      "availability",
      "canary",
      "capacity",
      "churn",
      "deadman",
      "engine",
      "pipeline-health",
    ]);
  });

  for (const slug of allSlugs) {
    test(`slug ${slug} → docs/runbooks/${slug}.md exists with a matching slug`, () => {
      const mdPath = join(RUNBOOKS_DIR, `${slug}.md`);
      expect(existsSync(mdPath)).toBe(true);
      // The page slug must equal the runbook_url slug so a repointed runbooks host resolves the path.
      expect(frontmatterSlug(mdPath)).toBe(slug);
    });
  }
});
