// apps/web/tests/mutations-ack-ui.test.ts — read-only acknowledgement surfaces (09 §7.2, §7.5):
// AckInfo mounted in the detail pane (desk AND wallboard), the 'Acked' glyph + PendingMarker in the
// triage table state cell, and inert rendering of server strings. DOM via describeDom (per file).

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";

import type { ActiveAlert, AlertAck, AlertsPayload } from "@pulse/web-data/wire";
import type { ReactElement } from "react";
import { pendingTracker } from "../src/client/mutations/pending.js";
import type { PendingTarget } from "../src/client/mutations/pending.js";
import { createAppStore } from "../src/client/store/index.js";
import type { AppStore } from "../src/client/store/index.js";
import type { SessionState } from "../src/client/store/types.js";
import { firingRows } from "../src/client/views/alerts/model.js";
import { describeDom } from "./dom.js";
import { installUiStubs } from "./rtl.js";
import { detailDialog } from "./alerts-dom-helpers.js";
import {
  FIXTURE_ACK,
  FIXTURE_FINGERPRINTS,
  makeAlertsPayload,
  makeHistoryPayload,
  withAck,
} from "./alerts-fixtures.js";

const F = FIXTURE_FINGERPRINTS;
const acked: AlertsPayload = withAck(makeAlertsPayload({ scenario: "mixed" }), [F.hostDown]);

/** A desk-or-wallboard store whose session grants EVERY capability (the wallboard must still hide
 *  affordances, REQ-AUTHZ-05). The identity carries a subject distinct from the displayName so a leak
 *  would be visible (REQ-SEC-06). */
function storeFor(density: "desk" | "wallboard"): AppStore {
  const store = createAppStore({ storage: null, initialQuery: {} });
  const session: SessionState = {
    identity: { displayName: "Viewer" },
    authMode: "proxy-header",
    capabilities: { silence: true, ack: true, proposeEstateEdit: true },
  } as unknown as SessionState;
  store.session.value = session;
  store.density.value = density;
  return store;
}

function row(payload: AlertsPayload, fp: string): ActiveAlert {
  const a = firingRows(payload).find((x) => x.fingerprint === fp);
  if (a === undefined) throw new Error(`fixture alert ${fp} missing`);
  return a;
}

const flush = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

const originalFetch = globalThis.fetch;

describeDom("triage table acked glyph and pending marker (REQ-ACK-07a)", (dom) => {
  const added: PendingTarget[] = [];
  afterEach(() => {
    for (const t of added.splice(0)) pendingTracker.dismiss(t);
  });

  async function mountTable(rows: readonly ActiveAlert[]): Promise<{ container: HTMLElement; unmount(): void }> {
    const { createElement: h, createRef } = await import("react");
    const { signal } = await import("@preact/signals-core");
    const { TriageTable } = await import("../src/client/views/alerts/table/TriageTable.js");
    return dom.mount(
      h(TriageTable, {
        rows,
        selectedIndex: signal(-1),
        onOpenAlert: () => {},
        sourcesCurrent: true,
        containerRef: createRef<HTMLDivElement>(),
      }) as unknown as ReactElement,
    );
  }

  function stateCellOf(container: HTMLElement, fp: string): Element {
    const btn = container.querySelector(`[data-triage-open="${fp}"]`);
    const tr = btn?.closest("tr");
    if (tr === null || tr === undefined) throw new Error(`row ${fp} missing`);
    const cells = [...tr.querySelectorAll("td")];
    return cells[cells.length - 1]!;
  }

  test("an acked row shows an 'Acked' badge with a glyph; an un-acked row shows none (REQ-ACK-07a)", async () => {
    const { container, unmount } = await mountTable(firingRows(acked));
    const ackedCell = stateCellOf(container, F.hostDown);
    // The alert's own state badge still renders beside the ack badge.
    const status = ackedCell.querySelector('[data-slot="status-badge"][data-status]');
    expect(status).not.toBeNull();
    expect(status!.getAttribute("data-status")).toBe("critical");
    expect(status!.textContent).toBe("firing");
    const badge = ackedCell.querySelector('[data-state="acked"]');
    expect(badge).not.toBeNull();
    const ackBadge = badge!.querySelector('[data-slot="status-badge"]')!;
    expect(ackBadge.textContent).toBe("Acked");
    expect(ackBadge.querySelector("svg")).not.toBeNull();
    expect(ackBadge.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    // Never an affordance.
    expect(badge!.querySelector("button, a, input")).toBeNull();

    const plainCell = stateCellOf(container, F.diskFull);
    expect(plainCell.querySelector('[data-state="acked"]')).toBeNull();
    expect(plainCell.textContent).not.toContain("Acked");
    unmount();
  });

  test("after pendingTracker.add for its fingerprint the row shows 'Pending' (REQ-ACK-07a)", async () => {
    const { container, unmount } = await mountTable(firingRows(acked));
    expect(stateCellOf(container, F.diskFull).querySelector('[data-state="pending"]')).toBeNull();

    const target: PendingTarget = { kind: "alert", fingerprint: F.diskFull };
    added.push(target);
    pendingTracker.add({ target, reflected: () => false, since: performance.now() });
    await flush();

    const pending = stateCellOf(container, F.diskFull).querySelector('[data-state="pending"]');
    expect(pending).not.toBeNull();
    expect(pending!.textContent).toBe("Pending");
    // Other rows are unaffected.
    expect(stateCellOf(container, F.hostDown).querySelector('[data-state="pending"]')).toBeNull();

    pendingTracker.dismiss(target);
    await flush();
    expect(stateCellOf(container, F.diskFull).querySelector('[data-state="pending"]')).toBeNull();
    unmount();
  });
});

describeDom("detail pane acknowledgement info (REQ-ACK-07b, REQ-AUTHZ-05)", (dom) => {
  // The pane is a Radix Sheet portalled into document.body: queries go through the dialog element.
  let restoreStubs: (() => void) | null = null;
  beforeAll(() => {
    restoreStubs = installUiStubs();
  });
  afterAll(() => restoreStubs?.());
  beforeEach(() => {
    globalThis.fetch = (() =>
      Promise.resolve({ json: () => Promise.resolve(makeHistoryPayload({ kind: "ready" })) })) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function mountPane(
    store: AppStore,
    payload: AlertsPayload,
    selected: string,
  ): Promise<{ container: HTMLElement; unmount(): void }> {
    const { createElement: h } = await import("react");
    const { DetailPane } = await import("../src/client/views/alerts/detail/DetailPane.js");
    const m = await dom.mount(h(DetailPane, { store, payload, selected, onClose: () => {} }) as unknown as ReactElement);
    await flush(10);
    const dialog = detailDialog();
    if (dialog === null) throw new Error("detail Sheet did not open");
    return { container: dialog, unmount: m.unmount };
  }

  function ackFields(container: HTMLElement): Record<string, string> {
    const info = container.querySelector('section[aria-label="Acknowledgement"]');
    if (info === null) throw new Error("AckInfo missing");
    const out: Record<string, string> = {};
    for (const div of info.querySelectorAll("dl > div")) {
      out[div.querySelector("dt")!.textContent ?? ""] = div.querySelector("dd")!.textContent ?? "";
    }
    return out;
  }

  for (const density of ["desk", "wallboard"] as const) {
    test(`shows By/At/Note for an acked alert on ${density} density, before LabelsAnnotations (REQ-ACK-07b)`, async () => {
      const { container, unmount } = await mountPane(storeFor(density), acked, F.hostDown);
      const detail = container.querySelector("[data-detail-body]")!;
      expect(detail.firstElementChild!.matches('section[aria-label="Acknowledgement"]')).toBe(true);
      expect(ackFields(container)).toEqual({
        By: FIXTURE_ACK.by,
        At: FIXTURE_ACK.at,
        Note: FIXTURE_ACK.note!,
      });
      expect(container.querySelector('section[aria-label="Acknowledgement"] time')!.getAttribute("datetime")).toBe(FIXTURE_ACK.at);
      expect(container.querySelector('section[aria-label="Acknowledgement"] [data-state="acked"]')).not.toBeNull();
      unmount();
    });
  }

  test("wallboard: AckInfo shows but the action slot regions contain no button (REQ-AUTHZ-05)", async () => {
    const { container, unmount } = await mountPane(storeFor("wallboard"), acked, F.hostDown);
    await flush(150);
    expect(container.querySelector('section[aria-label="Acknowledgement"]')).not.toBeNull();
    const slots = [...container.querySelectorAll("[data-action-slot]")];
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) expect(slot.querySelector("button")).toBeNull();
    unmount();
  });

  test("an un-acked alert renders no AckInfo (REQ-ACK-07b)", async () => {
    const { container, unmount } = await mountPane(storeFor("desk"), acked, F.diskFull);
    expect(container.querySelector("[data-detail-body] section[aria-labelledby]")).not.toBeNull();
    expect(container.querySelector('section[aria-label="Acknowledgement"]')).toBeNull();
    unmount();
  });

  test("ack.by / ack.note render as inert text with control chars as U+FFFD; only displayName is shown (REQ-SEC-06, REQ-SEC-07)", async () => {
    const hostile: AlertAck = {
      by: "<b>x</b>\u0007Eve",
      at: FIXTURE_ACK.at,
      note: "<b>x</b> note\u0007end",
    };
    // A would-be leaked identity field riding on the wire object must never reach the DOM.
    const leaky = { ...hostile, subject: "subject-canary-7f3", source: "source-canary-7f3" } as unknown as AlertAck;
    const payload = withAck(makeAlertsPayload({ scenario: "mixed" }), [F.hostDown], leaky);
    const { container, unmount } = await mountPane(storeFor("desk"), payload, F.hostDown);
    const info = container.querySelector('section[aria-label="Acknowledgement"]')!;
    expect(info.querySelector("b")).toBeNull();
    const fields = ackFields(container);
    expect(fields["By"]).toBe("<b>x</b>�Eve");
    expect(fields["Note"]).toBe("<b>x</b> note�end");
    expect(info.textContent).not.toContain("\u0007");
    expect(Object.keys(fields)).toEqual(["By", "At", "Note"]);
    expect(document.body.textContent).not.toContain("subject-canary-7f3");
    expect(document.body.textContent).not.toContain("source-canary-7f3");
    unmount();
  });
});
