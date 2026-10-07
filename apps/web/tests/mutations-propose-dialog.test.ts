// mutations-propose-dialog.test.ts — the estate propose-edit UI (09 §8; REQ-PROP-02, REQ-PROP-06,
// REQ-AUTHZ-04, REQ-SEC-07): ProposeDialog's current-value mirror and offered fields (pinned against the
// server readProposableValue and the core allowlist/value rules, which the client cannot import at runtime),
// the dialog form and submit, ProposeEditAction, and the read-only ProposalList.
// `globalThis.fetch` is stubbed per test and restored in afterEach.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createElement } from "react";
import { useState } from "react";
import type { ReactElement } from "react";

import { loadAndValidate } from "@pulse/core";
import {
  ANY_CONTROL_RE, CONTROL_EXCEPT_LF_RE, PROPOSABLE_FIELDS, PROPOSABLE_FIELD_NAMES, PROPOSAL_CHANGES_MAX, fieldApplies,
  fieldValueSchema, proposalValuesEqual,
} from "@pulse/core/proposals";
import type { ProposableField, ProposalValue } from "@pulse/core/proposals";
import { buildWebEstateModel } from "@pulse/renderer";
import type { WebEstateHostV2, WebEstateModelV2, WebEstateServiceV2 } from "@pulse/renderer";

import ProposeDialog from "../src/client/mutations/dialogs/ProposeDialog.js";
import {
  ANY_CONTROL_RE as CLIENT_ANY_CONTROL_RE, CONTROL_EXCEPT_LF_RE as CLIENT_CONTROL_EXCEPT_LF_RE, CLIENT_PROPOSABLE_FIELDS, CLIENT_PROPOSAL_CHANGES_MAX, clientFieldApplies, clientValuesEqual,
  coveredByStandaloneSuppression, offeredFields, proposedValueIssue, readDeclaredValue,
} from "../src/client/mutations/dialog-models/propose-model.js";
import type { ProposeDialogProps } from "../src/client/mutations/dialogs/ProposeDialog.js";
import { ProposeEditAction } from "../src/client/mutations/ProposeEditAction.js";
import {
  ProposalList, proposalListRefresh,
} from "../src/client/mutations/proposals/ProposalList.js";
import { formatValue } from "../src/client/mutations/proposals/format.js";
import { REASON_TEXT, fetchProposals, isProposalListBody } from "../src/client/mutations/client.js";
import { createAppStore } from "../src/client/store/index.js";
import type { AppStore } from "../src/client/store/index.js";
import type { ProposalListBody, ProposalView } from "../src/shared/mutations.js";
import { readProposableValue, resolveTarget } from "../src/server/mutations/estate-values.js";
import { MUTATION_STATE } from "../src/client/ui/index.js";
import { describeUi } from "./rtl.js";
import { makeEstatePayloadFixture } from "./factories/estate-payload.js";
import { setInputValue } from "./react-render.js";
import { getDialog, mountDialog as mountOpenDialog, queryDialog } from "./mutations-dialog-dom.js";

// ---------------------------------------------------------------------------
// Parity fixture model (loaded the way proposals-parity.test.ts does)
// ---------------------------------------------------------------------------

const FIXTURE = join(import.meta.dir, "../../../packages/core/tests/fixtures/proposals-parity");

function loadModel(): WebEstateModelV2 {
  const loaded = loadAndValidate(FIXTURE);
  if (!loaded.ok) throw new Error(`fixture failed to load: ${JSON.stringify(loaded.findings)}`);
  const web = buildWebEstateModel(loaded.model);
  if (!web.ok) throw new Error("fixture tripped web safety");
  return web.value;
}

const MODEL = loadModel();

function host(name: string): WebEstateHostV2 {
  const h0 = MODEL.hosts.find((x) => x.name === name);
  if (h0 === undefined) throw new Error(`fixture host ${name} missing`);
  return h0;
}
function service(hostName: string, name: string): WebEstateServiceV2 {
  const s = MODEL.services.find((x) => x.host === hostName && x.name === name);
  if (s === undefined) throw new Error(`fixture service ${hostName}/${name} missing`);
  return s;
}
const offeredNames = (kind: "host" | "service", e: WebEstateHostV2 | WebEstateServiceV2, model: WebEstateModelV2 | null = MODEL) =>
  offeredFields(model, kind, e).map((r) => r.spec.field);

// ---------------------------------------------------------------------------
// fetch stub
// ---------------------------------------------------------------------------

interface Call { readonly url: string; readonly method: string; readonly key: string | null; readonly body: unknown }
type Reply = { readonly status: number; readonly json: unknown };

const realFetch = globalThis.fetch;
let calls: Call[] = [];

/** Route by URL prefix; POSTs consume `posts` in order, GET /api/proposals answers `list`. */
function stubFetch(opts: { posts?: readonly Reply[]; list?: Reply }): void {
  calls = [];
  let i = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url, method: init?.method ?? "GET", key: headers.get("idempotency-key"),
      body: init?.body !== undefined ? JSON.parse(String(init.body)) : null,
    });
    let r: Reply;
    if (url.startsWith("/api/proposals")) r = opts.list ?? { status: 200, json: EMPTY_LIST };
    else if (url.startsWith("/api/mutations/")) {
      const posts = opts.posts ?? [];
      r = posts[Math.min(i++, posts.length - 1)] ?? { status: 500, json: {} };
    } else r = { status: 404, json: {} };
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const EMPTY_LIST: ProposalListBody = { enabled: true, proposals: [], invalidCount: 0 };
const ok = (result: unknown): Reply => ({ status: 201, json: { outcome: "succeeded", requestId: "req-ok", result } });
const refusal = (status: number, code: string, reason: string, fields?: string): Reply => ({
  status,
  json: { code, message: "catalog text", details: { reason, requestId: "req-bad", ...(fields !== undefined ? { fields } : {}) } },
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// Mirrors pinned against core and the server (REQ-PROP-02)
// ---------------------------------------------------------------------------

describe("ProposeDialog mirrors equal core and the server reader (REQ-PROP-02)", () => {
  test("control-character regexes equal core's; free text also refuses bidi controls (REQ-SEC-07)", () => {
    expect(CLIENT_ANY_CONTROL_RE.source).toBe(ANY_CONTROL_RE.source);
    expect(CLIENT_CONTROL_EXCEPT_LF_RE.source).toBe(CONTROL_EXCEPT_LF_RE.source);
    for (const ch of ["\u200E", "\u202E", "\u2066"]) expect(CONTROL_EXCEPT_LF_RE.test(`ok${ch}`)).toBe(true);
    expect(CONTROL_EXCEPT_LF_RE.test("line\nbreak")).toBe(false);
    expect(ANY_CONTROL_RE.test("Name\u200F")).toBe(false); // identity-derived fields may carry RLM
  });
  test("CLIENT_PROPOSABLE_FIELDS deep-equals core PROPOSABLE_FIELDS; the changes cap matches", () => {
    expect(CLIENT_PROPOSABLE_FIELDS).toEqual(PROPOSABLE_FIELDS);
    expect(CLIENT_PROPOSAL_CHANGES_MAX).toBe(PROPOSAL_CHANGES_MAX);
  });

  test("clientFieldApplies ≡ fieldApplies for every field × kind × host class", () => {
    const classes = ["managed-linux", "hypervisor-api", "nas-api", "probe-only", "excluded", null];
    for (const field of PROPOSABLE_FIELD_NAMES) {
      for (const kind of ["host", "service"] as const) {
        for (const c of classes) {
          expect({ field, kind, c, v: clientFieldApplies(field, kind, c) }).toEqual({ field, kind, c, v: fieldApplies(field, kind, c) });
        }
      }
    }
  });

  test("proposedValueIssue accepts exactly what fieldValueSchema accepts (PROP-04 mirror)", () => {
    const corpus: unknown[] = [
      true, false, null, "", "fast", " fast", "fast ", "a".repeat(128), "a".repeat(129), "bad\u0007", "line\nbreak", 0,
      { class: "excluded", rationale: "Retired box." }, { class: "known-expected", rationale: "   " },
      { class: "expected-churn", rationale: "ok\nmultiline" }, { class: "expected-churn", rationale: "tab\there" },
      { class: "bogus", rationale: "Some text." }, { class: "excluded", rationale: "x".repeat(500) },
      { class: "excluded", rationale: "x".repeat(501) }, { class: "excluded", rationale: "Why", extra: 1 }, { class: "excluded" },
    ];
    let compared = 0;
    for (const field of PROPOSABLE_FIELD_NAMES) {
      for (const kind of ["host", "service"] as const) {
        for (const v of corpus) {
          const core = fieldValueSchema(field, kind).safeParse(v).success;
          expect({ field, kind, v, ok: proposedValueIssue(field, kind, v as ProposalValue) === null }).toEqual({ field, kind, v, ok: core });
          compared++;
        }
      }
    }
    expect(compared).toBe(PROPOSABLE_FIELD_NAMES.length * 2 * corpus.length);
  });

  test("clientValuesEqual ≡ proposalValuesEqual (marks compare by value, key order ignored)", () => {
    const values: ProposalValue[] = [
      true, false, null, "fast", "slow",
      { class: "excluded", rationale: "a" }, { rationale: "a", class: "excluded" } as ProposalValue,
      { class: "excluded", rationale: "b" }, { class: "known-expected", rationale: "a" },
    ];
    for (const a of values) for (const b of values) expect(clientValuesEqual(a, b)).toBe(proposalValuesEqual(a, b));
  });

  test("readDeclaredValue deep-equals server readProposableValue for every host/service × field of the parity model", () => {
    let compared = 0;
    for (const e of MODEL.hosts) {
      const resolved = resolveTarget(MODEL, "host", e.drilldownId)!;
      for (const f of PROPOSABLE_FIELD_NAMES) {
        expect({ id: e.drilldownId, f, v: readDeclaredValue(MODEL, "host", e, f) })
          .toEqual({ id: e.drilldownId, f, v: readProposableValue(MODEL, resolved, f) });
        compared++;
      }
    }
    for (const e of MODEL.services) {
      const resolved = resolveTarget(MODEL, "service", e.drilldownId)!;
      for (const f of PROPOSABLE_FIELD_NAMES) {
        expect({ id: e.drilldownId, f, v: readDeclaredValue(MODEL, "service", e, f) })
          .toEqual({ id: e.drilldownId, f, v: readProposableValue(MODEL, resolved, f) });
        compared++;
      }
    }
    expect(compared).toBe((MODEL.hosts.length + MODEL.services.length) * PROPOSABLE_FIELD_NAMES.length);
    expect(MODEL.hosts.length).toBeGreaterThanOrEqual(4);
    expect(MODEL.services.length).toBeGreaterThanOrEqual(3);
  });
});

describe("offeredFields — only applicable fields with an applicable current value (REQ-PROP-02)", () => {
  test("every offered field satisfies fieldApplies(field, kind, hostClass) and has an applicable value", () => {
    for (const e of MODEL.hosts) {
      const expected = PROPOSABLE_FIELD_NAMES.filter((f) => fieldApplies(f, "host", e.collectionClass)
        && readProposableValue(MODEL, resolveTarget(MODEL, "host", e.drilldownId)!, f).applicable);
      expect({ host: e.name, offered: offeredNames("host", e) }).toEqual({ host: e.name, offered: expected });
    }
    for (const e of MODEL.services) {
      const expected = PROPOSABLE_FIELD_NAMES.filter((f) => fieldApplies(f, "service", null)
        && readProposableValue(MODEL, resolveTarget(MODEL, "service", e.drilldownId)!, f).applicable);
      expect({ svc: e.drilldownId, offered: offeredNames("service", e) }).toEqual({ svc: e.drilldownId, offered: expected });
    }
  });

  test("cadvisor/heartbeat are offered only for managed-linux hosts, with prefilled seen values", () => {
    expect(offeredFields(MODEL, "host", host("app-01")).map((r) => [r.spec.field, r.seen])).toEqual([
      ["expectedChurn", false], ["scrapeIntervalClass", null], ["cadvisor", false], ["heartbeat", true],
    ]);
    expect(offeredNames("host", host("db-01"))).toContain("cadvisor");
    expect(offeredNames("host", host("edge-probe"))).toEqual(["expectedChurn", "scrapeIntervalClass"]);
    expect(offeredNames("host", host("old-nas"))).toEqual(["expectedChurn", "scrapeIntervalClass", "suppressed"]);
  });

  test("suppressed is absent for a standalone-suppression-covered service; a null model fails closed", () => {
    const cache = service("db-01", "cache");
    expect(coveredByStandaloneSuppression(MODEL, cache)).toBe(true);
    expect(offeredNames("service", cache)).toEqual([]);
    expect(coveredByStandaloneSuppression(MODEL, service("app-01", "batch"))).toBe(false);
    expect(offeredFields(MODEL, "service", service("app-01", "batch"))).toEqual([
      { spec: PROPOSABLE_FIELDS[4]!, seen: { class: "known-expected", rationale: service("app-01", "batch").suppressed!.rationale } },
    ]);
    expect(offeredNames("service", service("app-01", "api"), null)).toEqual([]);
  });

  test("host suppressed is set-only (not nullable) while service suppressed may be cleared", () => {
    const row = offeredFields(MODEL, "host", host("old-nas")).find((r) => r.spec.field === "suppressed")!;
    expect(row.spec.nullable.host).toBe(false);
    expect(row.spec.nullable.service).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function flush(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function newStore(): AppStore {
  const store = createAppStore({ storage: null, initialQuery: {} });
  store.estate.value = makeEstatePayloadFixture({ estate: MODEL, liveTargets: [] });
  store.density.value = "desk";
  store.session.value = { identity: null, authMode: "proxy-header", capabilities: { silence: false, ack: false, proposeEstateEdit: true } };
  return store;
}

function buttonTexts(root: ParentNode): string[] {
  return [...root.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "").filter((t) => t !== "");
}
function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const b = [...root.querySelectorAll("button")].find((x) => x.textContent?.trim() === text);
  if (b === undefined) throw new Error(`no button "${text}"`);
  return b as HTMLButtonElement;
}
function fieldset(root: ParentNode, field: ProposableField): HTMLElement {
  const f = root.querySelector<HTMLElement>(`fieldset[data-field="${field}"]`);
  if (f === null) throw new Error(`no row ${field}`);
  return f;
}
/** Radix checkboxes/radios are `button[role=checkbox|radio]`; their state is aria-checked. */
function isChecked(el: Element): boolean {
  return el.getAttribute("aria-checked") === "true";
}
function controlByLabel(root: ParentNode, label: string): HTMLElement | null {
  const l = [...root.querySelectorAll("label")].find((x) => x.textContent?.trim() === label);
  if (l === undefined) return null;
  return root.querySelector<HTMLElement>(`#${CSS.escape(l.getAttribute("for") ?? "")}`);
}
function checkboxByLabel(root: ParentNode, label: string): HTMLElement | null {
  const c = controlByLabel(root, label);
  return c !== null && c.getAttribute("role") === "checkbox" ? c : null;
}
function radioByLabel(root: ParentNode, label: string): HTMLElement {
  const r = controlByLabel(root, label);
  if (r === null || r.getAttribute("role") !== "radio") throw new Error(`no radio "${label}"`);
  return r;
}
function typeInto(el: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  setInputValue(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
function rationaleBox(root: ParentNode): HTMLTextAreaElement {
  const t = root.querySelector<HTMLTextAreaElement>('textarea[name="rationale"]');
  if (t === null) throw new Error("no rationale textarea");
  return t;
}
function region(politeness: "polite" | "assertive"): string {
  return document.querySelector(`[data-politeness="${politeness}"]`)?.textContent ?? "";
}

interface Spies { done: unknown[]; closed: number }
type Mount = { mount(v: ReactElement): Promise<{ container: HTMLElement; unmount(): void }> };

async function mountDialog(dom: Mount, kind: "host" | "service", declared: WebEstateHostV2 | WebEstateServiceV2) {
  const spies: Spies = { done: [], closed: 0 };
  const props: ProposeDialogProps = {
    store: newStore(), target: { kind, id: declared.drilldownId }, declared, open: true,
    onClose: () => { spies.closed += 1; }, onDone: (r) => { spies.done.push(r); },
  };
  const m = await mountOpenDialog(dom, createElement(ProposeDialog, props) as ReactElement);
  return { ...m, spies };
}

const RATIONALE = "Host was rebuilt and now churns on every deploy.";

// ---------------------------------------------------------------------------
// ProposeDialog DOM
// ---------------------------------------------------------------------------

describeUi("ProposeDialog form and submit (REQ-PROP-02, REQ-AUTHZ-04, REQ-SEC-07)", (dom) => {
  test("rows follow offeredFields; host suppressed has no 'Clear' option, service suppressed does", async () => {
    stubFetch({});
    const nas = await mountDialog(dom, "host", host("old-nas"));
    expect([...nas.dialog.querySelectorAll("fieldset[data-field]")].map((f) => f.getAttribute("data-field")))
      .toEqual(["expectedChurn", "scrapeIntervalClass", "suppressed"]);
    checkboxByLabel(fieldset(nas.dialog, "suppressed"), "Include this change (Suppression)")!.click();
    await flush();
    expect(checkboxByLabel(fieldset(nas.dialog, "suppressed"), "Clear suppression")).toBeNull();
    // scrapeIntervalClass is nullable on hosts
    checkboxByLabel(fieldset(nas.dialog, "scrapeIntervalClass"), "Include this change (Scrape interval class)")!.click();
    await flush();
    expect(checkboxByLabel(fieldset(nas.dialog, "scrapeIntervalClass"), "Clear (remove overlay value)")).not.toBeNull();
    nas.unmount();

    const batch = await mountDialog(dom, "service", service("app-01", "batch"));
    checkboxByLabel(fieldset(batch.dialog, "suppressed"), "Include this change (Suppression)")!.click();
    await flush();
    expect(checkboxByLabel(fieldset(batch.dialog, "suppressed"), "Clear suppression")).not.toBeNull();
    batch.unmount();
  });

  test("no offered rows → 'No proposable fields apply to this entity.' and only Close", async () => {
    stubFetch({});
    const { dialog, unmount } = await mountDialog(dom, "service", service("db-01", "cache"));
    expect(dialog.textContent).toContain("No proposable fields apply to this entity.");
    expect(buttonTexts(dialog)).toEqual(["Close"]);
    unmount();
  });

  test("current values render as inert text (REQ-SEC-07)", async () => {
    stubFetch({});
    const { dialog, unmount } = await mountDialog(dom, "service", service("app-01", "batch"));
    expect(fieldset(dialog, "suppressed").textContent).toContain(`Current: known-expected: ${service("app-01", "batch").suppressed!.rationale}`);
    unmount();
  });

  test("row choices stay with their field when the offered rows change while open (no positional state)", async () => {
    stubFetch({});
    let swap: (d: WebEstateHostV2) => void = () => {};
    function Harness(): ReactElement | null {
      const [declared, setDeclared] = useState<WebEstateHostV2>(host("edge-probe"));
      swap = setDeclared;
      return createElement(ProposeDialog, {
        store: newStore(), target: { kind: "host", id: declared.drilldownId }, declared, open: true,
        onClose: () => {}, onDone: () => {},
      }) as ReactElement;
    }
    const { dialog, unmount } = await mountOpenDialog(dom, createElement(Harness, {}) as ReactElement);
    await flush();
    const before = [...dialog.querySelectorAll("fieldset[data-field]")].length;
    checkboxByLabel(fieldset(dialog, "scrapeIntervalClass"), "Include this change (Scrape interval class)")!.click();
    await flush();
    // A managed-linux host offers more rows (cadvisor, heartbeat) than a probe-only one.
    swap({ ...host("app-01"), scrapeIntervalClass: host("edge-probe").scrapeIntervalClass } as WebEstateHostV2);
    await flush();
    const fields = [...dialog.querySelectorAll("fieldset[data-field]")].map((f) => f.getAttribute("data-field"));
    expect(fields.length).toBeGreaterThan(before);
    expect(isChecked(checkboxByLabel(fieldset(dialog, "scrapeIntervalClass"), "Include this change (Scrape interval class)")!)).toBe(true);
    for (const f of fields.filter((x) => x !== "scrapeIntervalClass")) {
      const cb = [...fieldset(dialog, f as ProposableField).querySelectorAll<HTMLElement>("[role=checkbox]")][0]!;
      expect(isChecked(cb)).toBe(false);
    }
    unmount();
  });

  test("an edited row resets when a new cycle changes that field's current value (no silent revert)", async () => {
    stubFetch({});
    let swap: (d: WebEstateHostV2) => void = () => {};
    function Harness(): ReactElement | null {
      const [declared, setDeclared] = useState<WebEstateHostV2>(host("app-01"));
      swap = setDeclared;
      return createElement(ProposeDialog, {
        store: newStore(), target: { kind: "host", id: declared.drilldownId }, declared, open: true,
        onClose: () => {}, onDone: () => {},
      }) as ReactElement;
    }
    const { dialog, unmount } = await mountOpenDialog(dom, createElement(Harness, {}) as ReactElement);
    await flush();
    checkboxByLabel(fieldset(dialog, "expectedChurn"), "Include this change (Expected churn)")!.click();
    await flush();
    expect(isChecked(checkboxByLabel(fieldset(dialog, "expectedChurn"), "Include this change (Expected churn)")!)).toBe(true);
    const cur = host("app-01");
    swap({ ...cur, expectedChurn: !(cur.expectedChurn ?? false) } as WebEstateHostV2); // someone else changed it
    await flush();
    expect(isChecked(checkboxByLabel(fieldset(dialog, "expectedChurn"), "Include this change (Expected churn)")!)).toBe(false);
    unmount();
  });

  test("submit sends target, changes with seen prefilled, and the trimmed rationale to /api/mutations/proposals", async () => {
    stubFetch({ posts: [ok({ proposalId: "p-20260930T031100Z-deadbeef" })] });
    const { dialog, unmount, spies } = await mountDialog(dom, "host", host("app-01"));
    const row = fieldset(dialog, "expectedChurn");
    checkboxByLabel(row, "Include this change (Expected churn)")!.click();
    await flush();
    radioByLabel(row, "Yes").click();
    typeInto(rationaleBox(dialog), `  ${RATIONALE}  `);
    await flush();
    buttonByText(dialog, "Submit proposal").click();
    await flush(50);
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.length).toBe(1);
    expect(posts[0]!.url).toBe("/api/mutations/proposals");
    expect(posts[0]!.key).not.toBeNull();
    expect(posts[0]!.body).toEqual({
      target: { kind: "host", id: "host:app-01" },
      changes: [{ field: "expectedChurn", seen: false, proposed: true }],
      rationale: RATIONALE,
    });
    expect(spies.done).toEqual([{ proposalId: "p-20260930T031100Z-deadbeef" }]);
    expect(spies.closed).toBe(1);
    unmount();
  });

  test("proposed === seen is a client error: no fetch and the row is marked invalid", async () => {
    stubFetch({ posts: [ok({ proposalId: "p-x" })] });
    const { dialog, unmount, spies } = await mountDialog(dom, "host", host("app-01"));
    const row = fieldset(dialog, "heartbeat");
    checkboxByLabel(row, "Include this change (Heartbeat)")!.click(); // seen true; radio starts at Yes
    typeInto(rationaleBox(dialog), RATIONALE);
    await flush();
    buttonByText(dialog, "Submit proposal").click();
    await flush(50);
    expect(calls.filter((c) => c.method === "POST").length).toBe(0);
    expect(row.textContent).toContain("No change from the current value.");
    expect(checkboxByLabel(row, "Include this change (Heartbeat)")!.getAttribute("aria-invalid")).toBe("true");
    expect(spies.done).toEqual([]);
    unmount();
  });

  test("no included change or a short rationale blocks submit (no fetch)", async () => {
    stubFetch({ posts: [ok({ proposalId: "p-x" })] });
    const { dialog, unmount } = await mountDialog(dom, "host", host("app-01"));
    typeInto(rationaleBox(dialog), "too short");
    await flush();
    buttonByText(dialog, "Submit proposal").click();
    await flush(50);
    expect(calls.length).toBe(0);
    expect(dialog.textContent).toContain("Include at least one change.");
    expect(rationaleBox(dialog).getAttribute("aria-invalid")).toBe("true");
    unmount();
  });

  test("stale-proposal shows REASON_TEXT and rotates the Idempotency-Key; invalid-body keeps it and marks changes.<i>", async () => {
    stubFetch({ posts: [
      refusal(400, "INVALID_REQUEST", "invalid-body", "changes.0.proposed"),
      refusal(409, "CONFLICT", "stale-proposal"),
      ok({ proposalId: "p-y" }),
    ] });
    const { dialog, unmount } = await mountDialog(dom, "host", host("db-01"));
    const row = fieldset(dialog, "expectedChurn");
    checkboxByLabel(row, "Include this change (Expected churn)")!.click();
    await flush();
    radioByLabel(row, "No").click();
    typeInto(rationaleBox(dialog), RATIONALE);
    await flush();

    buttonByText(dialog, "Submit proposal").click();
    await flush(50);
    expect(checkboxByLabel(row, "Include this change (Expected churn)")!.getAttribute("aria-invalid")).toBe("true");
    expect(row.textContent).toContain("This change was refused by the server.");

    buttonByText(dialog, "Submit proposal").click();
    await flush(50);
    expect(dialog.querySelector("[data-mut-result]")?.textContent).toContain(REASON_TEXT["stale-proposal"]);
    expect(region("assertive")).toContain(REASON_TEXT["stale-proposal"]);

    buttonByText(dialog, "Submit proposal").click();
    await flush(50);
    const keys = calls.filter((c) => c.method === "POST").map((c) => c.key);
    expect(keys.length).toBe(3);
    expect(keys[1]).toBe(keys[0]!); // invalid-body is never stored: key reused
    expect(keys[2]).not.toBe(keys[1]!); // stale-proposal is stored: key rotated
    unmount();
  });

  test("a set suppression mark on a service is sent as {class, rationale}; clearing sends null", async () => {
    stubFetch({ posts: [ok({ proposalId: "p-z" })] });
    const batch = service("app-01", "batch");
    const { dialog, unmount } = await mountDialog(dom, "service", batch);
    const row = fieldset(dialog, "suppressed");
    checkboxByLabel(row, "Include this change (Suppression)")!.click();
    await flush();
    checkboxByLabel(row, "Clear suppression")!.click();
    typeInto(rationaleBox(dialog), RATIONALE);
    await flush();
    buttonByText(dialog, "Submit proposal").click();
    await flush(50);
    expect(calls[0]!.body).toEqual({
      target: { kind: "service", id: batch.drilldownId },
      changes: [{ field: "suppressed", seen: { class: "known-expected", rationale: batch.suppressed!.rationale }, proposed: null }],
      rationale: RATIONALE,
    });
    unmount();
  });
});

describeUi("ProposeEditAction opens the lazy dialog and refreshes the list (REQ-PROP-02, REQ-PROP-06)", (dom) => {
  test("'Propose edit…' loads the dialog; success bumps proposalListRefresh and announces politely", async () => {
    stubFetch({ posts: [ok({ proposalId: "p-20260930T031100Z-cafef00d" })] });
    const store = newStore();
    const declared = host("app-01");
    const { container, unmount } = await dom.mount(
      createElement(ProposeEditAction, { store, target: { kind: "host", id: declared.drilldownId }, declared }) as ReactElement,
    );
    const trigger = buttonByText(container, "Propose edit…");
    trigger.focus();
    trigger.click();
    for (let i = 0; i < 50 && queryDialog() === null; i++) await flush(10);
    const dialog = getDialog(`Propose edit: ${declared.drilldownId}`);
    expect(dialog.contains(document.activeElement)).toBe(true);
    const row = fieldset(dialog, "cadvisor");
    checkboxByLabel(row, "Include this change (cAdvisor)")!.click();
    await flush();
    radioByLabel(row, "Yes").click();
    typeInto(rationaleBox(dialog), RATIONALE);
    await flush();
    const before = proposalListRefresh.value;
    buttonByText(dialog, "Submit proposal").click();
    await flush(80);
    expect(proposalListRefresh.value).toBe(before + 1);
    expect(region("polite")).toContain("Proposal submitted. It is pending review.");
    expect(queryDialog()).toBeNull(); // closed
    expect(document.activeElement).toBe(buttonByText(container, "Propose edit…")); // focus returned to the trigger
    unmount();
  });
});

// ---------------------------------------------------------------------------
// ProposalList
// ---------------------------------------------------------------------------

const VIEW = (over: Partial<ProposalView>): ProposalView => ({
  id: "p-20260930T010000Z-00000001",
  createdAt: "2026-09-30T01:00:00.000Z",
  proposer: "Gary Gentry",
  changes: [{ field: "expectedChurn", seen: false, proposed: true }],
  rationale: "Rebuilt host churns on deploy.",
  state: "pending",
  reason: null,
  commit: null,
  ...over,
});

const LIST: ProposalListBody = {
  enabled: true,
  invalidCount: 2,
  proposals: [
    VIEW({ id: "p-20260930T030000Z-00000003", rationale: "see <b>x</b>\u0007\nsecond line" }),
    VIEW({ id: "p-20260930T020000Z-00000002", state: "applied", commit: "0123456789abcdef0123456789abcdef01234567",
      changes: [{ field: "suppressed", seen: null, proposed: { class: "known-expected", rationale: "Idles." } }] }),
    VIEW({ id: "p-20260930T010000Z-00000001", state: "rejected", reason: "Not needed <i>now</i>." }),
  ],
};

describe("ProposalList helpers (REQ-PROP-06, REQ-SEC-07)", () => {
  test("formatValue covers booleans, null, strings and marks", () => {
    expect(formatValue(true)).toBe("yes");
    expect(formatValue(false)).toBe("no");
    expect(formatValue(null)).toBe("(cleared)");
    expect(formatValue("fast")).toBe("fast");
    expect(formatValue({ class: "excluded", rationale: "Retired." })).toBe("excluded: Retired.");
  });

  test("isProposalListBody accepts the wire shape and refuses malformed bodies", () => {
    expect(isProposalListBody(LIST)).toBe(true);
    expect(isProposalListBody(EMPTY_LIST)).toBe(true);
    expect(isProposalListBody({ enabled: false, proposals: [], invalidCount: 0 })).toBe(true);
    expect(isProposalListBody(null)).toBe(false);
    expect(isProposalListBody({ enabled: "yes", proposals: [], invalidCount: 0 })).toBe(false);
    expect(isProposalListBody({ enabled: true, proposals: [{ id: 1, state: "pending" }], invalidCount: 0 })).toBe(false);
    expect(isProposalListBody({ enabled: true, proposals: [VIEW({ state: "bogus" as "pending" })], invalidCount: 0 })).toBe(false);
    expect(isProposalListBody({ enabled: true, proposals: [], invalidCount: -1 })).toBe(false);
  });

  test("MUTATION_STATE gives each proposal state a distinct glyph and label", () => {
    const s = (["pending", "applied", "rejected"] as const).map((k) => MUTATION_STATE[k]);
    expect(new Set(s.map((x) => x.icon)).size).toBe(3);
    expect(new Set(s.map((x) => x.label)).size).toBe(3);
  });

  test("fetchProposals GETs /api/proposals with an encoded id and returns null on any failure", async () => {
    const seen: string[] = [];
    const f = (reply: () => Response) => (async (u: RequestInfo | URL) => { seen.push(String(u)); return reply(); }) as unknown as typeof fetch;
    const json = (b: unknown, status = 200) => () => new Response(JSON.stringify(b), { status });
    expect(await fetchProposals("service", "svc:app-01/batch", f(json(LIST)))).toEqual(LIST);
    expect(seen[0]).toBe("/api/proposals?kind=service&id=svc%3Aapp-01%2Fbatch");
    expect(await fetchProposals("host", "host:a", f(json(LIST, 500)))).toBeNull();
    expect(await fetchProposals("host", "host:a", f(json({ nope: true })))).toBeNull();
    expect(await fetchProposals("host", "host:a", f(() => new Response("not json")))).toBeNull();
    const throwing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await fetchProposals("host", "host:a", throwing)).toBeNull();
  });
});

/** The disclosure trigger's text (its accessible name; the chevron icon has none). */
function disclosureText(container: Element): string {
  return container.querySelector<HTMLButtonElement>('[data-slot="disclosure"] button[aria-expanded]')!.textContent ?? "";
}

/** Expand the (collapsed by default) disclosure so its panel mounts. */
async function expand(container: Element): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>('[data-slot="disclosure"] button[aria-expanded]')!;
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  trigger.click();
  await flush(50);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
}

describeUi("ProposalList renders inert, state-chipped proposals (REQ-PROP-06, REQ-SEC-07)", (dom) => {
  const target = { kind: "host" as const, id: "host:app-01" };

  test("pending/applied/rejected chips, 'Reason:' and 'Commit:' lines, invalid notice, literal rationale", async () => {
    stubFetch({ list: { status: 200, json: LIST } });
    const { container, unmount } = await dom.mount(createElement(ProposalList, { target }) as ReactElement);
    await flush(150);
    expect(calls[0]!.url).toBe("/api/proposals?kind=host&id=host%3Aapp-01");
    expect(disclosureText(container)).toBe("Proposals (3)");
    await expand(container);
    const items = [...container.querySelectorAll("li[data-proposal-id]")];
    expect(items.map((li) => li.querySelector("[data-state]")?.textContent)).toEqual(["Pending", "Applied", "Rejected"]);
    expect(items.every((li) => li.querySelector("[data-state] svg") !== null)).toBe(true);
    expect(items[1]!.textContent).toContain("Commit: 0123456789abcdef0123456789abcdef01234567");
    expect(items[1]!.textContent).toContain("suppressed: (cleared) → known-expected: Idles.");
    expect(items[2]!.textContent).toContain("Reason: Not needed <i>now</i>.");
    expect(items[0]!.textContent).not.toContain("Reason:");
    expect(items[0]!.textContent).toContain("expectedChurn: no → yes");
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("i")).toBeNull();
    expect([...items[0]!.querySelectorAll("p")].map((p) => p.textContent)).toContain("see <b>x</b>�\nsecond line");
    expect(container.textContent).toContain("2 proposal file(s) could not be verified and are not shown.");
    expect(items[0]!.querySelector("time")?.getAttribute("datetime")).toBe("2026-09-30T01:00:00.000Z");
    unmount();
  });

  test("enabled:false renders nothing; a failed load renders a notice", async () => {
    stubFetch({ list: { status: 200, json: { enabled: false, proposals: [], invalidCount: 0 } } });
    const a = await dom.mount(createElement(ProposalList, { target }) as ReactElement);
    await flush(150);
    expect(a.container.innerHTML).toBe("");
    a.unmount();

    stubFetch({ list: { status: 500, json: {} } });
    const b = await dom.mount(createElement(ProposalList, { target }) as ReactElement);
    await flush(150);
    await expand(b.container);
    expect(b.container.textContent).toContain("Proposals could not be loaded.");
    b.unmount();
  });

  test("bumping proposalListRefresh refetches", async () => {
    stubFetch({ list: { status: 200, json: EMPTY_LIST } });
    const { container, unmount } = await dom.mount(createElement(ProposalList, { target }) as ReactElement);
    await flush(150);
    expect(disclosureText(container)).toBe("Proposals (0)");
    stubFetch({ list: { status: 200, json: LIST } });
    proposalListRefresh.value += 1;
    await flush(150);
    expect(calls.length).toBe(1);
    expect(disclosureText(container)).toBe("Proposals (3)");
    unmount();
  });
});
