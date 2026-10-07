// apps/web/tests/mutations-inert-text.test.ts — inert-text guard for the M2 client surfaces
// (10 §5.1; REQ-SEC-07). DOM via describeDom (per file).
//
// ── Protects (10 §5.1): ──────────────────────────────────────────────────────────────────────────
// no `dangerouslySetInnerHTML` or `innerHTML =` in `apps/web/src/client/mutations/**`,
// `views/alerts/actions/**`, and the M2-touched files under `views/alerts/{detail,table,silences}/**`,
// `views/overview/{ribbon/FiringRibbon.tsx,drawer/AlertList.tsx,drawer/TargetDrawer.tsx}`,
// `views/estate/entity-page.tsx`; and a DOM render of a rationale/note/reason containing `<b>x</b>` and
// `\u0007` shows literal text and `�`.
//
// ── Non-goals (10 §5.1): ─────────────────────────────────────────────────────────────────────────
// obfuscated DOM writes (`Reflect.set`, string-built property names), third-party components,
// server-rendered HTML outside these paths.
//
// Method: comments are stripped before the token scan (a comment that names the banned sink never
// fails the guard); the whole detail/table/silences directories are scanned (a superset of the
// M2-touched files). A self-test proves the matchers catch a synthetic violation.

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createElement } from "react";
import type { ReactElement } from "react";

import type { ActiveAlert, AlertsPayload } from "@pulse/web-data/wire";
import { AckInfo } from "../src/client/mutations/AckInfo.js";
import { ProposalList } from "../src/client/mutations/proposals/ProposalList.js";
import { Silences } from "../src/client/views/alerts/detail/Silences.js";
import type { ProposalListBody } from "../src/shared/mutations.js";
import { describeDom } from "./dom.js";
import { FIXTURE_FINGERPRINTS, FIXTURE_SILENCE_IDS, makeAlertsPayload } from "./alerts-fixtures.js";
import { stubAnimationFrame } from "./mutations-dialog-dom.js";

const CLIENT = resolve(import.meta.dir, "../src/client");

/** Directories walked recursively (node:fs readdirSync). */
const SCAN_DIRS = [
  "mutations",
  "views/alerts/actions",
  "views/alerts/detail",
  "views/alerts/table",
  "views/alerts/silences",
] as const;
/** Individual files. */
const SCAN_FILES = [
  "views/overview/ribbon/FiringRibbon.tsx",
  "views/overview/drawer/AlertList.tsx",
  "views/overview/drawer/TargetDrawer.tsx",
  "views/estate/entity-page.tsx",
] as const;

function walk(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((p) => join(dir, p))
    .filter((p) => /\.tsx?$/.test(p) && statSync(p).isFile());
}

function scannedFiles(): string[] {
  const files = SCAN_DIRS.flatMap((d) => walk(join(CLIENT, d)));
  for (const f of SCAN_FILES) {
    const p = join(CLIENT, f);
    expect(statSync(p).isFile(), `${f} must exist`).toBe(true);
    files.push(p);
  }
  return files.sort();
}

/** Same lexical approach as mutation-darkness.test.ts (keeps `://` in URLs). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const DANGEROUS_PROP = /\bdangerouslySetInnerHTML\b/;
const INNER_HTML_WRITE = /\binnerHTML\s*=/;

/** Violations in one source text (after comment stripping). */
function violations(source: string): string[] {
  const code = stripComments(source);
  const out: string[] = [];
  if (DANGEROUS_PROP.test(code)) out.push("dangerouslySetInnerHTML");
  if (INNER_HTML_WRITE.test(code)) out.push("innerHTML =");
  return out;
}

describe("inert text — static scan (REQ-SEC-07, 10 §5.1)", () => {
  test("self-test: the matchers catch synthetic violations and ignore comments (REQ-SEC-07)", () => {
    expect(violations(`const x = <div dangerouslySetInnerHTML={{ __html: s }} />;`)).toEqual(["dangerouslySetInnerHTML"]);
    expect(violations(`el.innerHTML = s;`)).toEqual(["innerHTML ="]);
    expect(violations(`el.innerHTML=s;`)).toEqual(["innerHTML ="]);
    expect(violations(`// never use dangerouslySetInnerHTML or el.innerHTML = s\nconst a = 1;`)).toEqual([]);
    expect(violations(`/* dangerouslySetInnerHTML */ const a = 1;`)).toEqual([]);
    // The item regex `/\binnerHTML\s*=/` is kept verbatim: it also flags `innerHTML ===` (strict by design);
    // a plain read is not a write.
    expect(violations(`const s = el.innerHTML;`)).toEqual([]);
  });

  test("the scanned file list is non-empty and covers every enumerated path (REQ-SEC-07)", () => {
    const files = scannedFiles().map((f) => relative(CLIENT, f));
    expect(files.length).toBeGreaterThan(0);
    for (const d of SCAN_DIRS) expect(files.some((f) => f.startsWith(`${d}/`)), d).toBe(true);
    for (const f of SCAN_FILES) expect(files).toContain(f);
    expect(files).toContain("mutations/dialogs/ProposeDialog.tsx");
    expect(files).toContain("mutations/proposals/ProposalList.tsx");
  });

  test("no dangerouslySetInnerHTML and no `innerHTML =` in the M2 client surfaces (REQ-SEC-07)", () => {
    const offenders: string[] = [];
    for (const f of scannedFiles()) {
      for (const v of violations(readFileSync(f, "utf8"))) offenders.push(`${relative(CLIENT, f)} :: ${v}`);
    }
    expect(offenders, offenders.join(", ")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DOM renders
// ---------------------------------------------------------------------------

const HOSTILE = "see <b>x</b>\u0007end";
const RENDERED = "see <b>x</b>�end";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const flush = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

describeDom("inert text — DOM renders (REQ-SEC-07, 10 §5.1)", (dom) => {
  test("AckInfo renders a hostile note and by literally, control char as U+FFFD (REQ-SEC-07)", async () => {
    const { container, unmount } = await dom.mount(
      createElement(AckInfo, { ack: { by: HOSTILE, at: "2026-09-30T01:00:00.000Z", note: HOSTILE } }) as ReactElement,
    );
    expect(container.querySelector("b")).toBeNull();
    expect([...container.querySelectorAll("dt")].find((d) => d.textContent === "Note")!.nextElementSibling!.textContent).toBe(RENDERED);
    expect(container.textContent).toContain(RENDERED);
    expect(container.textContent).not.toContain("\u0007");
    unmount();
  });

  test("ProposalList renders a hostile rationale and reason literally (REQ-SEC-07)", async () => {
    const body: ProposalListBody = {
      enabled: true,
      invalidCount: 0,
      proposals: [{
        id: "p-20260930T010000Z-deadbeef",
        state: "rejected",
        createdAt: "2026-09-30T01:00:00.000Z",
        proposer: HOSTILE,
        changes: [{ field: "expectedChurn", seen: false, proposed: true }],
        rationale: HOSTILE,
        reason: HOSTILE,
        commit: null,
      }],
    };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
    ) as unknown as typeof fetch;
    const restoreRaf = stubAnimationFrame();
    const { container, unmount } = await dom.mount(createElement(ProposalList, { target: { kind: "host", id: "host:app-01" } }) as ReactElement);
    await flush(150);
    container.querySelector<HTMLButtonElement>('[data-slot="disclosure"] button[aria-expanded]')!.click(); // mount the panel
    await flush(50);
    const item = container.querySelector("li[data-proposal-id]");
    expect(item).not.toBeNull();
    expect(container.querySelector("b")).toBeNull();
    const paras = [...item!.querySelectorAll("p")].map((p) => p.textContent);
    expect(paras.slice(1)).toEqual([RENDERED, `Reason: ${RENDERED}`]); // after the header line: rationale, reason
    expect(container.textContent).toContain(`by ${RENDERED}`);
    expect(container.textContent).not.toContain("\u0007");
    unmount();
    restoreRaf();
  });

  test("detail Silences renders a hostile comment and creator literally (REQ-SEC-07)", async () => {
    const base = makeAlertsPayload({ scenario: "mixed" });
    const payload = structuredClone(base) as { -readonly [K in keyof AlertsPayload]: AlertsPayload[K] };
    payload.silences = payload.silences.map((s) =>
      s.id === FIXTURE_SILENCE_IDS.backup ? { ...s, comment: HOSTILE, createdBy: HOSTILE } : s);
    const alert = payload.alerts.find((a: ActiveAlert) => a.fingerprint === FIXTURE_FINGERPRINTS.backupAge);
    if (alert === undefined) throw new Error("fixture alert backupAge missing");
    const { container, unmount } = await dom.mount(createElement(Silences, { alert, payload }) as ReactElement);
    expect(container.querySelector('[data-slot="list-item"]')).not.toBeNull();
    expect(container.querySelector("b")).toBeNull();
    const dds = [...container.querySelectorAll('[data-slot="list-item"] dd')].map((d) => d.textContent);
    expect(dds).toContain(RENDERED);
    expect(dds.filter((d) => d === RENDERED).length).toBe(2);
    expect(container.textContent).not.toContain("\u0007");
    unmount();
  });
});
