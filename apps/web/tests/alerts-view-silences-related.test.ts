// apps/web/tests/alerts-view-silences-related.test.ts — matching silences + related alerts detail
// sections. DOM blocks use describeDom (tests/dom.ts), happy-dom per file.

import { describe, expect, test } from "bun:test";

import type { ActiveAlert, AlertsPayload, SilenceMatcher } from "@pulse/web-data/wire";
import type { ReactElement } from "react";
import { matcherExpression } from "../src/client/views/alerts/detail/silences-model.js";
import { firingRows } from "../src/client/views/alerts/model.js";
import { describeDom } from "./dom.js";
import { FIXTURE_FINGERPRINTS, makeAlertsPayload } from "./alerts-fixtures.js";

const payload = makeAlertsPayload({ scenario: "mixed" });
function byFp(fp: string): ActiveAlert {
  const a = firingRows(payload).find((x) => x.fingerprint === fp);
  if (a === undefined) throw new Error(`fixture alert ${fp} missing`);
  return a;
}

function m(isEqual: boolean, isRegex: boolean): SilenceMatcher {
  return { name: "job", value: "node", isEqual, isRegex };
}

describe("matcherExpression", () => {
  test("maps the four (isEqual x isRegex) combinations with a double-quoted value", () => {
    expect(matcherExpression(m(true, false))).toBe('job="node"');
    expect(matcherExpression(m(false, false))).toBe('job!="node"');
    expect(matcherExpression(m(true, true))).toBe('job=~"node"');
    expect(matcherExpression(m(false, true))).toBe('job!~"node"');
  });
});

function assertNoAffordance(c: HTMLElement): void {
  expect(c.querySelectorAll("a, input, form, textarea, select").length).toBe(0);
  for (const b of c.querySelectorAll("button")) {
    expect(b.textContent ?? "").not.toMatch(/expire|edit|create|silence/i);
  }
}

describeDom("Silences", (dom) => {
  async function mountSilences(alert: ActiveAlert, p: AlertsPayload | null): Promise<HTMLElement> {
    const { createElement: h } = await import("react");
    const { Silences } = await import("../src/client/views/alerts/detail/Silences.js");
    const { container } = await dom.mount(h(Silences, { alert, payload: p }) as unknown as ReactElement);
    return container;
  }

  test("renders nothing for an alert with empty silencedBy", async () => {
    const c = await mountSilences(byFp(FIXTURE_FINGERPRINTS.hostDown), payload);
    expect(c.querySelector("section")).toBeNull();
    expect((c.textContent ?? "").trim()).toBe("");
  });

  test("resolves ids against payload.silences and shows matchers/creator/comment/expiry", async () => {
    const c = await mountSilences(byFp(FIXTURE_FINGERPRINTS.backupAge), payload);
    const region = c.querySelector("section[aria-labelledby]");
    expect(c.querySelector(`#${region?.getAttribute("aria-labelledby")}`)?.textContent).toBe("Matching silences");
    const list = c.querySelector('[data-slot="list"][data-variant="card"]');
    expect(list?.getAttribute("role")).toBe("list");
    const items = list?.querySelectorAll("[data-slot=list-item]") ?? [];
    expect(items.length).toBe(1);
    const codes = [...c.querySelectorAll("code[data-matcher]")].map((e) => e.textContent);
    expect(codes).toEqual(['alertname="BackupTooOld"', 'service="backup"']);
    const kv = [...items[0]!.querySelectorAll("[data-slot=key-value]")].map((p) => [
      p.querySelector("dt")?.textContent,
      p.querySelector("dd")?.textContent,
    ]);
    expect(kv).toEqual([
      ["Creator", "operator@example.test"],
      ["Comment", "Backup window maintenance"],
      ["Expires", "2026-09-22T18:00:00.000Z"],
    ]);
    assertNoAffordance(c);
    expect(c.querySelectorAll("button").length).toBe(0);
  });

  test("surfaces (never drops) referenced ids missing from the snapshot", async () => {
    const c = await mountSilences(byFp(FIXTURE_FINGERPRINTS.backupAge), payload);
    const note = c.querySelector("[data-unresolved-count]");
    expect(note).not.toBeNull();
    expect(note?.getAttribute("data-unresolved-count")).toBe("1");
    expect(note?.textContent).toContain("1 referenced silence not present");
  });

  test("a null payload leaves every referenced id unresolved", async () => {
    const c = await mountSilences(byFp(FIXTURE_FINGERPRINTS.backupAge), null);
    expect(c.querySelectorAll("[data-slot=list-item]").length).toBe(0);
    const note = c.querySelector("[data-unresolved-count]");
    expect(note?.getAttribute("data-unresolved-count")).toBe("2");
    expect(note?.textContent).toContain("2 referenced silences");
  });
});

describeDom("Related", (dom) => {
  async function mountRelated(
    alert: ActiveAlert,
    p: AlertsPayload | null,
    onSelect?: (fp: string) => void,
  ): Promise<HTMLElement> {
    const { createElement: h } = await import("react");
    const { Related } = await import("../src/client/views/alerts/detail/Related.js");
    const props = { alert, payload: p, ...(onSelect !== undefined ? { onSelect } : {}) };
    const { container } = await dom.mount(h(Related, props) as unknown as ReactElement);
    return container;
  }

  test("lists exact-target alerts excluding self, with status via data-status + glyph + label", async () => {
    const c = await mountRelated(byFp(FIXTURE_FINGERPRINTS.hostDown), payload);
    const region = c.querySelector("section[aria-labelledby]");
    expect(c.querySelector(`#${region?.getAttribute("aria-labelledby")}`)?.textContent).toBe(
      "Related alerts on this target",
    );
    const list = c.querySelector('[data-slot="list"][role="list"]');
    const rows = [...(list?.querySelectorAll<HTMLButtonElement>("li > button[data-related]") ?? [])];
    // host:web-01 siblings in payload order; the service:backup + null-target alerts are excluded.
    expect(rows.map((r) => r.getAttribute("data-related"))).toEqual([
      FIXTURE_FINGERPRINTS.diskFull,
      FIXTURE_FINGERPRINTS.loadHigh,
    ]);
    expect(rows.map((r) => r.lastElementChild?.textContent)).toEqual(["DiskAlmostFull", "LoadHigh"]);
    for (const r of rows) {
      expect(r.getAttribute("type")).toBe("button");
      const badge = r.querySelector("[data-slot=status-badge]");
      expect(badge?.getAttribute("data-status")).toBeTruthy();
      expect(badge?.querySelector("svg")).not.toBeNull(); // glyph
      // label = the severity word
      expect(badge?.textContent).toBe(badge?.getAttribute("data-severity") ?? "missing");
    }
    expect(rows[0]?.querySelector("[data-slot=status-badge]")?.getAttribute("data-status")).toBe("warning");
    expect(rows[0]?.querySelector("[data-slot=status-badge]")?.textContent).toBe("warning");
    // the inhibited sibling maps to "suppressed"
    expect(rows[1]?.querySelector("[data-slot=status-badge]")?.getAttribute("data-status")).toBe("suppressed");
    assertNoAffordance(c);
  });

  test("a firing info sibling takes the info severity tone, not unknown", async () => {
    const infoFiring: AlertsPayload = {
      ...payload,
      alerts: payload.alerts.map((a) =>
        a.fingerprint === FIXTURE_FINGERPRINTS.loadHigh ? { ...a, state: "firing" as const } : a,
      ),
    };
    const c = await mountRelated(byFp(FIXTURE_FINGERPRINTS.hostDown), infoFiring);
    const badge = c.querySelector(`button[data-related="${FIXTURE_FINGERPRINTS.loadHigh}"] [data-slot=status-badge]`);
    expect(badge?.getAttribute("data-status")).toBe("info");
    expect(badge?.getAttribute("data-tone")).toBe("info");
    expect(badge?.textContent).toBe("info");
  });

  test("clicking a related row calls onSelect with its fingerprint", async () => {
    const picked: string[] = [];
    const c = await mountRelated(byFp(FIXTURE_FINGERPRINTS.hostDown), payload, (fp) => picked.push(fp));
    c.querySelector<HTMLButtonElement>("button[data-related]")?.click();
    expect(picked).toEqual([FIXTURE_FINGERPRINTS.diskFull]);
  });

  test("a null target renders the distinct 'No target' state (no label-based guess)", async () => {
    const c = await mountRelated(byFp(FIXTURE_FINGERPRINTS.unattributed), payload);
    const empty = c.querySelector('[data-slot="empty-state"][role="status"]');
    expect(empty?.textContent).toContain("No target");
    expect(c.textContent).not.toContain("No related alerts");
    expect(c.querySelectorAll("button").length).toBe(0);
  });

  test("a target with no other firing alerts renders 'No related alerts'", async () => {
    const c = await mountRelated(byFp(FIXTURE_FINGERPRINTS.backupAge), payload);
    expect(c.querySelector('[data-slot="empty-state"]')?.textContent).toContain("No related alerts");
    expect(c.querySelectorAll("button").length).toBe(0);
    expect(c.textContent).not.toContain("No target");
  });

  test("a null payload renders 'No related alerts'", async () => {
    const c = await mountRelated(byFp(FIXTURE_FINGERPRINTS.hostDown), null);
    expect(c.textContent).toContain("No related alerts");
  });
});
