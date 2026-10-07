// stack/alerting/tests/paths.ts
// Filesystem path constants for the alerting test suite, anchored on `import.meta.dir` so every
// path is absolute regardless of the CWD `bun test` runs from (06 §1, mirrors stack/tests/harness.ts).
// `import.meta.dir` is a Bun runtime built-in typed by the ambient decl in `bun-test.d.ts` (a global
// script included in this project's tsconfig).

import { resolve } from "node:path";

/** This tests directory (`stack/alerting/tests`). */
export const TESTS_DIR = import.meta.dir;

/** The `stack/alerting` package root: tests → up one. */
export const PKG_ROOT = resolve(TESTS_DIR, "..");

/** Repo root: `stack/alerting/tests` → up three. */
export const REPO_ROOT = resolve(TESTS_DIR, "..", "..", "..");

/** The estate/golden fixture tree. Each `<name>/` holds `estate.json`, `alertmanager/routing.yaml`,
 *  `prober/config.yaml`, and the committed goldens `alertmanager.yml`/`deep-health.yml`/`backup.yml`. */
export const FIXTURE_DIR = resolve(TESTS_DIR, "fixtures");

/** Golden outputs live alongside their fixture inputs under `fixtures/<name>/` (06 §5.1/§11.2). */
export const GOLDEN_DIR = FIXTURE_DIR;

/** The committed static vmalert rule library (item 009) — assembled into the promtool workspace (§3). */
export const STATIC_RULES_DIR = resolve(REPO_ROOT, "stack", "compose", "config", "vmalert", "rules");

/** The promtool `test rules` fixture YAMLs (item 014). */
export const PROMTOOL_FIXTURE_DIR = resolve(FIXTURE_DIR, "promtool");

/** The webhook payload fixtures (item 013). */
export const WEBHOOK_FIXTURE_DIR = resolve(FIXTURE_DIR, "webhook");

/** The published contract artifacts (item 010) — consumed by the conformance tests (§7.4). */
export const CONTRACT_DIR = resolve(PKG_ROOT, "contract");

/** host-agent's published metrics contract — the backup-gating helper reads this (§10, item 014). */
export const AGENT_METRICS_JSON = resolve(REPO_ROOT, "agent", "contract", "metrics.json");
