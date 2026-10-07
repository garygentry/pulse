// apps/web/tests/alerts-view-routing-labels.test.ts — routing explanation, labels/annotations, and
// safe links.
// DOM blocks are wrapped in describeDom (tests/dom.ts) so happy-dom is registered per file.

import { describe, expect, test } from "bun:test";

import type { ActiveAlert } from "@pulse/web-data/wire";
import type { ReactElement } from "react";
import { explainRouting } from "../src/client/views/alerts/routing-explain.js";
import { safeHref } from "../src/client/views/alerts/detail/labels-annotations-model.js";
import { SEVERITY_TAXONOMY } from "../src/client/views/alerts/taxonomy.js";
import { firingRows } from "../src/client/views/alerts/model.js";
import { describeDom } from "./dom.js";
import { FIXTURE_FINGERPRINTS, makeAlertsPayload } from "./alerts-fixtures.js";

const rows = firingRows(makeAlertsPayload({ scenario: "mixed" }));
function byFp(fp: string): ActiveAlert {
  const a = rows.find((x) => x.fingerprint === fp);
  if (a === undefined) throw new Error(`fixture alert ${fp} missing`);
  return a;
}

describe("explainRouting", () => {
  test("each taxonomy severity derives its policy from the vendored routing entry", () => {
    for (const entry of SEVERITY_TAXONOMY.severities) {
      const intent = explainRouting(entry.name);
      expect(intent.matched).toBe(true);
      expect(intent.response).toBe(entry.response);
      expect(intent.routing).toEqual(entry.routing);
      expect(intent.contractVersion).toBe(SEVERITY_TAXONOMY.contractVersion);
    }
  });

  test("critical: channels, repeat interval, quiet-hours bypass, webhook mirror", () => {
    const i = explainRouting("critical");
    expect(i.routing?.channels).toBe("critical-human + webhook-mirror");
    expect(i.routing?.repeatInterval).toBe("30m");
    expect(i.routing?.groupWindow).toBeNull();
    expect(i.routing?.bypassesQuietHours).toBe(true);
    expect(i.routing?.sendsResolved).toBe(true);
    expect(i.webhookMirror).toBe("always");
    expect(explainRouting("warning").webhookMirror).toBe("if-selected");
    expect(explainRouting("info").webhookMirror).toBe("never");
  });

  test("intent carries no receivers/urgency field", () => {
    const i = explainRouting("critical");
    expect(Object.keys(i).sort()).toEqual(
      ["contractVersion", "matched", "response", "routing", "severity", "webhookMirror"],
    );
    expect(Object.keys(i.routing ?? {})).not.toContain("receivers");
    expect(Object.keys(i.routing ?? {})).not.toContain("urgency");
  });

  test("unknown severity → matched:false with null policy, no throw", () => {
    for (const sev of ["page-me-now", "", "toString", "CRITICAL"]) {
      const i = explainRouting(sev);
      expect(i).toEqual({
        severity: sev,
        matched: false,
        response: null,
        routing: null,
        webhookMirror: null,
        contractVersion: 1,
      });
    }
  });
});

describe("safeHref", () => {
  test("allows only absolute http/https", () => {
    expect(safeHref("https://runbooks.example/cpu")).toBe("https://runbooks.example/cpu");
    expect(safeHref("http://runbooks.example/a?b=1")).toBe("http://runbooks.example/a?b=1");
  });

  test("rejects javascript:/data:/vbscript:/file:/relative/unparseable", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "/relative/path",
      "runbooks/cpu",
      "//evil.example/x",
      "",
      "not a url",
    ]) {
      expect(safeHref(bad)).toBeNull();
    }
  });
});

/** The `dt`/`dd` pairs of a KeyValueList as [term, definition] text tuples. */
function pairs(dl: Element | null): Array<[string, string]> {
  return [...(dl?.querySelectorAll("[data-slot=key-value]") ?? [])].map((kv) => [
    kv.querySelector("dt")?.textContent ?? "",
    kv.querySelector("dd")?.textContent ?? "",
  ]);
}

describeDom("Routing", (dom) => {
  async function mountRouting(alert: ActiveAlert): Promise<HTMLElement> {
    const { createElement: h } = await import("react");
    const { Routing } = await import("../src/client/views/alerts/detail/Routing.js");
    const { container } = await dom.mount(h(Routing, { alert }) as unknown as ReactElement);
    return container;
  }

  test("matched severity renders the intended policy alongside actual receivers", async () => {
    const c = await mountRouting(byFp(FIXTURE_FINGERPRINTS.hostDown));
    const region = c.querySelector("section[aria-labelledby]");
    expect(c.querySelector(`#${region?.getAttribute("aria-labelledby")}`)?.textContent).toBe("Routing");
    const intent = c.querySelector('[data-slot="key-value-list"][data-routing="intent"]');
    expect(pairs(intent)).toEqual([
      ["Severity policy", "immediate human action"],
      ["Channels", "critical-human + webhook-mirror"],
      ["Repeat interval", "30m"],
      ["Group window", "—"], // null groupWindow
      ["Bypasses quiet hours", "yes"],
      ["Sends resolved", "yes"],
      ["Webhook mirror", "always"],
    ]);
    const actual = c.querySelector('[role="group"][aria-label="Actual receivers"]');
    const receivers = [...(actual?.querySelectorAll("[data-slot=badge]") ?? [])];
    expect(receivers.map((b) => b.textContent)).toEqual(["pager", "chat"]);
    expect(receivers.every((b) => b.getAttribute("data-variant") === "secondary")).toBe(true);
    expect(c.querySelector("button, input, select, a")).toBeNull();
  });

  test("empty receivers shows 'No receivers matched'", async () => {
    const c = await mountRouting({ ...byFp(FIXTURE_FINGERPRINTS.hostDown), receivers: [] });
    const actual = c.querySelector('[role="group"][aria-label="Actual receivers"]');
    expect(actual?.textContent).toBe("No receivers matched");
    expect(actual?.querySelector("[data-slot=badge]")).toBeNull();
  });

  test("unknown severity renders the unmatched note, no policy list", async () => {
    const c = await mountRouting({ ...byFp(FIXTURE_FINGERPRINTS.hostDown), severity: "page-me-now" });
    expect(c.querySelector("[data-slot=key-value-list]")).toBeNull();
    const note = c.querySelector('[data-routing="unmatched"]');
    expect(note?.textContent).toContain("No routing policy");
    expect(note?.querySelector("code")?.textContent).toBe("page-me-now");
  });
});

describeDom("LabelsAnnotations", (dom) => {
  async function mountLabels(alert: ActiveAlert): Promise<HTMLElement> {
    const { createElement: h } = await import("react");
    const { LabelsAnnotations } = await import(
      "../src/client/views/alerts/detail/LabelsAnnotations.js"
    );
    const { container } = await dom.mount(h(LabelsAnnotations, { alert }) as unknown as ReactElement);
    return container;
  }

  test("description as body text; safe runbook_url as a noopener anchor with glyph", async () => {
    const c = await mountLabels(byFp(FIXTURE_FINGERPRINTS.hostDown));
    const region = c.querySelector("section[aria-labelledby]");
    expect(c.querySelector(`#${region?.getAttribute("aria-labelledby")}`)?.textContent).toBe(
      "Labels and annotations",
    );
    expect(c.querySelector("[data-detail-description]")?.textContent).toBe(
      "No heartbeat from web-01 for more than 5 minutes.",
    );
    const anchors = c.querySelectorAll("a");
    expect(anchors.length).toBe(1);
    const a = anchors[0]!;
    expect(a.getAttribute("data-slot")).toBe("external-link");
    expect(a.getAttribute("href")).toBe("https://runbooks.example.test/host-down");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.textContent).toBe("Runbook (opens in new tab)");
    expect(a.querySelector("svg")).not.toBeNull();
    // Remaining labels + other annotations (summary) render as KeyValueList rows; description/runbook
    // do not repeat. Labels and annotations are told apart by data-kind and visible text, not colour.
    const dl = c.querySelector("[data-slot=key-value-list]");
    const text = dl?.textContent ?? "";
    expect(text).not.toContain("runbook_url");
    expect(text).not.toContain("description");
    const labelRows = [...(dl?.querySelectorAll('[data-slot=key-value][data-kind="label"]') ?? [])];
    const terms = labelRows.map((r) => r.querySelector("dt")?.textContent);
    expect(terms).toContain("team");
    const team = labelRows.find((r) => r.querySelector("dt")?.textContent === "team");
    expect(team?.querySelector("dd")?.textContent).toBe("platform");
    const annotationRows = [...(dl?.querySelectorAll('[data-slot=key-value][data-kind="annotation"]') ?? [])];
    expect(annotationRows.length).toBe(1);
    expect(annotationRows[0]!.querySelector("dt [data-slot=badge]")?.textContent).toBe("summary");
    expect(annotationRows[0]!.querySelector("dt")?.textContent).toContain("annotation");
    expect(annotationRows[0]!.querySelector("dd")?.textContent).not.toBe("");
  });

  test("unsafe runbook scheme renders inert text, never an anchor", async () => {
    const c = await mountLabels(byFp(FIXTURE_FINGERPRINTS.diskFull));
    expect(c.querySelector("a")).toBeNull();
    expect(c.querySelector("[data-slot=external-link]")).toBeNull();
    const inert = c.querySelector('[data-runbook="unsafe"]');
    expect(inert?.tagName).toBe("P");
    expect(inert?.textContent).toContain("unsupported URL scheme");
    expect(inert?.querySelector("code")?.textContent).toBe("javascript:alert(1)");
  });

  test("missing description/runbook_url keys skip their blocks", async () => {
    const c = await mountLabels({ ...byFp(FIXTURE_FINGERPRINTS.hostDown), annotations: {} });
    expect(c.querySelector("[data-detail-description]")).toBeNull();
    expect(c.querySelector("[data-runbook]")).toBeNull();
    expect(c.querySelector('[data-kind="annotation"]')).toBeNull();
    expect(c.textContent).not.toContain("undefined");
  });
});
