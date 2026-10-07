// stack/grafana/tests/static-guards.test.ts
//
// Tier A — the hermetic static guard suite (REQ-VERIF-01 checks 1–4). Reads the committed dashboard
// library off disk with ZERO external services and asserts it correct. Pattern source:
// stack/alerting/tests/static-rules.test.ts (committed-file reads, yaml/JSON parse, deny-list scan,
// labelled `expect`). Each check accumulates GuardFinding[] (00 §7) whose `kind` is drawn ONLY from
// the enumerated GuardFailureKind set, then asserts the list is empty with a labelled expect.
/// <reference path="./bun-test.d.ts" />
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import {
  BOARD_UIDS,
  DATASOURCE_VARS,
  DRILLDOWN_DOC,
  PROVENANCE_JSON,
  PULSE_BOARD_TAG,
  REPO_ROOT,
  TARGET_VARS,
  listBoardJsonFiles,
  loadArtifacts,
} from "./guards.js";
import type {
  BoardUid,
  DashboardModel,
  GuardFailureKind,
  GuardFinding,
  ProvenanceManifest,
} from "./guards.js";

// ─────────────────────────────────────────────────────────────────────────────
// Meta-guard: the suite's protection set is EXACTLY the GuardFailureKind enum (00 §7 / 05 §5.3).
// GuardFinding.kind is typed GuardFailureKind, so an ad-hoc failure string fails typecheck. The
// exhaustiveness assertion below proves ALL_FAILURE_KINDS covers the whole union in BOTH directions.
// ─────────────────────────────────────────────────────────────────────────────
const ALL_FAILURE_KINDS = [
  "invalid-json",
  "non-board-json",
  "duplicate-uid",
  "unknown-uid",
  "provenance-mismatch",
  "estate-literal",
  "credential-literal",
  "external-reference",
  "hardcoded-datasource",
  "unscoped-query",
] as const;

// Compile-time exhaustiveness (enforced by `bun run typecheck`): the array's element type and
// GuardFailureKind must be mutually assignable — no missing kind, no extra ad-hoc kind.
type _AssertExhaustive =
  (typeof ALL_FAILURE_KINDS)[number] extends GuardFailureKind
    ? GuardFailureKind extends (typeof ALL_FAILURE_KINDS)[number]
      ? true
      : never
    : never;
const _exhaustive: _AssertExhaustive = true;
void _exhaustive;

/** Repo-relative path for a finding, matching LoadedArtifact.path (00 §3). */
const rel = (p: string): string => relative(REPO_ROOT, p);

/** Labelled-expect message: one line per finding. */
const label = (findings: GuardFinding[]): string =>
  findings.map((f) => `${f.path}: [${f.check}] ${f.kind} — ${f.detail}`).join("\n");

/** True when a datasource ref is the template-variable form ${DS}/${DS_ALERTS} (00 §2). */
function isTemplateRef(ds: unknown): boolean {
  if (typeof ds === "string") return /^\$\{[A-Z_]+\}$/.test(ds);
  if (ds && typeof ds === "object" && "uid" in ds) {
    return /^\$\{[A-Z_]+\}$/.test(String((ds as { uid: unknown }).uid));
  }
  return false;
}

/** Set equality by membership. */
function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Parse the committed drilldown-links.md contract table (00 §6 / 04 §2.1). Returns one row per
 * board — a data row is a Markdown table line whose UID cell holds a backticked `pulse-*` handle.
 * The bound-variable cell is a backticked identifier, or the engine's `*(none — fixed link)*` → null.
 * The deep-link cell is the backticked `/d/<uid>...` URL (04 §2.2); null when the cell is absent.
 */
function parseDrilldownRows(
  md: string,
): { uid: string; boundVar: string | null; deepLink: string | null }[] {
  const rows: { uid: string; boundVar: string | null; deepLink: string | null }[] = [];
  for (const line of md.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    // cells[0] is "" (leading pipe); data cells are [1]=category, [2]=UID, [3]=bound variable,
    // [4]=deep-link.
    const uidMatch = (cells[2] ?? "").match(/`(pulse-[a-z-]+)`/);
    if (!uidMatch) continue; // header / separator / non-data row
    const boundMatch = (cells[3] ?? "").match(/`([A-Za-z_][A-Za-z0-9_]*)`/);
    const deepMatch = (cells[4] ?? "").match(/`([^`]+)`/);
    rows.push({
      uid: uidMatch[1]!,
      boundVar: boundMatch ? boundMatch[1]! : null,
      deepLink: deepMatch ? deepMatch[1]! : null,
    });
  }
  return rows;
}

describe("Tier A — static guard suite (REQ-VERIF-01 checks 1–4)", () => {
  const files = listBoardJsonFiles();

  test("the five committed boards are discovered under the scanned json/ path", () => {
    expect(files.length, `expected 5 board JSON files, found ${files.length}`).toBe(
      BOARD_UIDS.length,
    );
  });

  test("meta-guard — protection set is exactly the GuardFailureKind enum (00 §7)", () => {
    // Uniqueness + count; the compile-time _AssertExhaustive above enforces the enum ↔ array match.
    expect(new Set(ALL_FAILURE_KINDS).size).toBe(ALL_FAILURE_KINDS.length);
    expect(ALL_FAILURE_KINDS.length).toBe(10);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Check 1 — JSON validity (json-validity) [REQ-VERIF-01 #1, REQ-REPRO-01]
  // ───────────────────────────────────────────────────────────────────────────
  test("check 1 — every json/**.json parses to a DashboardModel (json-validity)", () => {
    const findings: GuardFinding[] = [];
    for (const file of files) {
      const raw = readFileSync(file, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        findings.push({
          check: "json-validity",
          kind: "invalid-json",
          path: rel(file),
          detail: "file is not valid JSON",
        });
        continue;
      }
      const m = parsed as Partial<DashboardModel>;
      const isBoard = typeof m.uid === "string" && Array.isArray(m.panels);
      if (!isBoard) {
        // A valid .json that is not a dashboard would fail Grafana provisioning loudly (file-provider gotcha).
        findings.push({
          check: "json-validity",
          kind: "non-board-json",
          path: rel(file),
          detail: "json under scanned path is not a dashboard model (no uid/panels)",
        });
        continue;
      }
      if (!Number.isInteger(m.schemaVersion)) {
        findings.push({
          check: "json-validity",
          kind: "invalid-json",
          path: rel(file),
          detail: `schemaVersion must be an integer (REQ-REPRO-01), got ${String(m.schemaVersion)}`,
        });
      }
      if (!(m.tags ?? []).includes(PULSE_BOARD_TAG)) {
        findings.push({
          check: "json-validity",
          kind: "invalid-json",
          path: rel(file),
          detail: `board must carry the "${PULSE_BOARD_TAG}" tag`,
        });
      }
    }
    expect(findings, label(findings)).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Check 2 — UID stability & convention (uid-convention) [REQ-VERIF-01 #2, REQ-CUR-02, REQ-LINK-01/02]
  // ───────────────────────────────────────────────────────────────────────────
  test("check 2 — uids unique & ∈ BOARD_UIDS; boards === provenance === drilldown (uid-convention)", () => {
    const findings: GuardFinding[] = [];
    const known = new Set<string>(BOARD_UIDS);

    // Collect board uids (uniqueness + membership).
    const seen = new Set<string>();
    for (const file of files) {
      const board = JSON.parse(readFileSync(file, "utf8")) as DashboardModel;
      const uid = board.uid as string;
      if (seen.has(uid)) {
        findings.push({
          check: "uid-convention",
          kind: "duplicate-uid",
          path: rel(file),
          detail: `uid "${uid}" is declared by more than one board`,
        });
      }
      seen.add(uid);
      if (!known.has(uid)) {
        findings.push({
          check: "uid-convention",
          kind: "unknown-uid",
          path: rel(file),
          detail: `uid "${uid}" ∉ BOARD_UIDS`,
        });
      }
    }

    // Provenance key set === board uid set (REQ-CUR-02).
    const provenance = JSON.parse(readFileSync(PROVENANCE_JSON, "utf8")) as ProvenanceManifest;
    const provenanceKeys = new Set<string>(Object.keys(provenance));
    if (!setsEqual(seen, provenanceKeys)) {
      findings.push({
        check: "uid-convention",
        kind: "provenance-mismatch",
        path: rel(PROVENANCE_JSON),
        detail: `provenance.json key set {${[...provenanceKeys].sort().join(", ")}} ≠ board uid set {${[...seen].sort().join(", ")}}`,
      });
    }

    // Drilldown-links.md rows: uid set === board uid set, and boundVar === TARGET_VARS[uid].
    const rows = parseDrilldownRows(readFileSync(DRILLDOWN_DOC, "utf8"));
    const drilldownUids = new Set<string>(rows.map((r) => r.uid));
    if (!setsEqual(seen, drilldownUids)) {
      findings.push({
        check: "uid-convention",
        kind: "provenance-mismatch",
        path: rel(DRILLDOWN_DOC),
        detail: `drilldown-links.md uid set {${[...drilldownUids].sort().join(", ")}} ≠ board uid set {${[...seen].sort().join(", ")}}`,
      });
    }
    for (const row of rows) {
      if (!known.has(row.uid)) continue; // membership already reported against the boards
      const expected = TARGET_VARS[row.uid as BoardUid];
      if (row.boundVar !== expected) {
        findings.push({
          check: "uid-convention",
          kind: "provenance-mismatch",
          path: rel(DRILLDOWN_DOC),
          detail: `drilldown row "${row.uid}" boundVar ${JSON.stringify(row.boundVar)} ≠ TARGET_VARS[${row.uid}] ${JSON.stringify(expected)}`,
        });
      }
      // Deep-link convention (SUCCESS-03 convention half, proven statically — 04 §2.2 item 3): a
      // board with a target variable embeds `var-<boundVar>=` in its `/d/<uid>` link; the engine
      // (no target var) carries the bare `/d/<uid>` with no `var-` query. This catches drift in the
      // Deep-link cell that the boundVar check above cannot see.
      if (row.deepLink === null) {
        findings.push({
          check: "uid-convention",
          kind: "provenance-mismatch",
          path: rel(DRILLDOWN_DOC),
          detail: `drilldown row "${row.uid}" has no Deep-link cell`,
        });
      } else if (expected === null) {
        if (row.deepLink !== `/d/${row.uid}`) {
          findings.push({
            check: "uid-convention",
            kind: "provenance-mismatch",
            path: rel(DRILLDOWN_DOC),
            detail: `engine drilldown deep-link ${JSON.stringify(row.deepLink)} ≠ fixed "/d/${row.uid}" (no target var)`,
          });
        }
      } else if (!row.deepLink.startsWith(`/d/${row.uid}`) || !row.deepLink.includes(`var-${expected}=`)) {
        findings.push({
          check: "uid-convention",
          kind: "provenance-mismatch",
          path: rel(DRILLDOWN_DOC),
          detail: `drilldown row "${row.uid}" deep-link ${JSON.stringify(row.deepLink)} must be "/d/${row.uid}" embedding "var-${expected}="`,
        });
      }
    }

    expect(findings, label(findings)).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Check 3 — No estate literals (no-estate-literals) [REQ-VERIF-01 #3, REQ-TMPL-01, REQ-SEC-01/02]
  // ───────────────────────────────────────────────────────────────────────────
  test("check 3 — no estate/credential literal in any committed artifact (no-estate-literals)", () => {
    const findings: GuardFinding[] = [];

    // Credential shapes → credential-literal (REQ-SEC-01) — inherited verbatim from static-rules.test.ts.
    const CREDENTIAL_DENY = [
      { name: "url-embedded-credentials", re: /[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i },
      { name: "op-secret-ref", re: /\bop:\/\//i },
      { name: "bearer-token", re: /\bbearer\s+[A-Za-z0-9._-]{8,}/i },
      { name: "secret-assignment", re: /\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S/i },
    ] as const;

    // Estate-identity shapes → estate-literal (REQ-TMPL-01, REQ-SEC-02). Tuned against the real
    // library: ipv4 excludes 3-octet version strings; single-label in-stack DNS has no dot so
    // `http://alertmanager:9093` never matches domain-like.
    const ESTATE_SIMPLE = [
      { name: "ipv4-literal", re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
      { name: "ipv6-literal", re: /\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f]{0,4}\b/i },
    ] as const;
    const DOMAIN_LIKE =
      /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|dev|local|lan|internal|home|arpa)\b/gi;

    // Allow-list carve-out: `grafana.com` is the upstream dashboard registry recorded in
    // provenance.json (REQ-CUR-02) and named in pulse.yaml's explanatory comment — a curated
    // provenance/source token, NOT an estate identity. Board-level protection against a live
    // grafana.com reference is independently preserved by check 4's `external-reference`.
    const ALLOWED_DOMAINS = new Set(["grafana.com"]);

    for (const artifact of loadArtifacts()) {
      for (const { name, re } of CREDENTIAL_DENY) {
        if (re.test(artifact.raw)) {
          findings.push({
            check: "no-estate-literals",
            kind: "credential-literal",
            path: artifact.path,
            detail: `matched credential-literal shape "${name}"`,
          });
        }
      }
      for (const { name, re } of ESTATE_SIMPLE) {
        const m = artifact.raw.match(re);
        if (m) {
          findings.push({
            check: "no-estate-literals",
            kind: "estate-literal",
            path: artifact.path,
            detail: `matched estate-literal shape "${name}" => "${m[0]}"`,
          });
        }
      }
      for (const m of artifact.raw.matchAll(DOMAIN_LIKE)) {
        const domain = m[0].toLowerCase();
        if (ALLOWED_DOMAINS.has(domain)) continue;
        findings.push({
          check: "no-estate-literals",
          kind: "estate-literal",
          path: artifact.path,
          detail: `matched estate-literal shape "domain-like" => "${m[0]}"`,
        });
      }
    }

    expect(findings, label(findings)).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Check 4 — No external / hardcoded-datasource refs (no-external-datasource)
  //           [REQ-VERIF-01 #4, REQ-TMPL-02, REQ-CUR-03, REQ-PERF-01]
  // ───────────────────────────────────────────────────────────────────────────
  test("check 4 — no external ref; every DS ref templated; metric queries target-scoped (no-external-datasource)", () => {
    const findings: GuardFinding[] = [];
    for (const file of files) {
      const raw = readFileSync(file, "utf8");
      const board = JSON.parse(raw) as DashboardModel;
      const targetVar = TARGET_VARS[board.uid]; // null for pulse-engine (whole-engine board)

      // (1) No external reference (REQ-CUR-03): a committed board is never live-referenced. The only
      //     URL this feature commits is http://alertmanager:9093 in alertmanager.yml — not a board.
      if (/grafana\.com/i.test(raw)) {
        findings.push({
          check: "no-external-datasource",
          kind: "external-reference",
          path: rel(file),
          detail: "board contains a grafana.com reference (REQ-CUR-03)",
        });
      }
      const externalUrl = raw.match(/https?:\/\/(?:[a-z0-9-]+\.)+[a-z]{2,}[^\s"']*/i);
      if (externalUrl) {
        findings.push({
          check: "no-external-datasource",
          kind: "external-reference",
          path: rel(file),
          detail: `board contains an external URL: "${externalUrl[0]}"`,
        });
      }

      // (2) No hardcoded datasource UID (REQ-TMPL-02): every datasource ref is ${DS}/${DS_ALERTS}.
      const templatingList = board.templating?.list ?? [];
      for (const v of templatingList) {
        const vds: unknown = (v as { datasource?: unknown }).datasource;
        if (vds !== undefined && !isTemplateRef(vds)) {
          findings.push({
            check: "no-external-datasource",
            kind: "hardcoded-datasource",
            path: rel(file),
            detail: `template variable "${v.name}" references a literal datasource UID`,
          });
        }
      }
      for (const panel of board.panels) {
        const pds: unknown = (panel as { datasource?: unknown }).datasource;
        // A panel may legitimately carry no datasource (e.g. a text panel) — only flag a present,
        // non-templated ref.
        if (pds !== undefined && !isTemplateRef(pds)) {
          findings.push({
            check: "no-external-datasource",
            kind: "hardcoded-datasource",
            path: rel(file),
            detail: `panel "${panel.title}" references a literal datasource UID`,
          });
        }
        for (const t of panel.targets ?? []) {
          const tds: unknown = (t as { datasource?: unknown }).datasource;
          if (tds !== undefined && !isTemplateRef(tds)) {
            findings.push({
              check: "no-external-datasource",
              kind: "hardcoded-datasource",
              path: rel(file),
              detail: `a target in panel "${panel.title}" references a literal datasource UID`,
            });
          }
        }

        // (3) Target-scoped queries (REQ-PERF-01): every metric (${DS}) panel target on a board that
        //     declares a target var MUST reference it. The alert panel (${DS_ALERTS}) is not a metric
        //     panel (no ${DS} substring) and is exempt; pulse-engine (targetVar === null) is exempt.
        const isMetricPanel =
          pds !== undefined &&
          JSON.stringify(pds).includes(`\${${DATASOURCE_VARS.metrics}}`);
        if (targetVar !== null && isMetricPanel) {
          const scoped = new RegExp(`\\$\\{?${targetVar}\\b`);
          for (const t of panel.targets ?? []) {
            if (!scoped.test(t.expr)) {
              findings.push({
                check: "no-external-datasource",
                kind: "unscoped-query",
                path: rel(file),
                detail: `panel "${panel.title}" query is not scoped by $${targetVar} (REQ-PERF-01): ${t.expr}`,
              });
            }
          }
        }
      }
    }

    expect(findings, label(findings)).toEqual([]);
  });
});
