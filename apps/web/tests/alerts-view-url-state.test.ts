// apps/web/tests/alerts-view-url-state.test.ts — url-state.ts triage-state codec (02 §3).

import { describe, expect, test } from "bun:test";

import {
  FACET_DELIMITER,
  FACET_KEYS,
  QUERY_KEYS,
  decodeTriageState,
  encodeTriageState,
  resolveSelected,
  type FacetSelection,
  type TriageUrlState,
} from "../src/client/views/alerts/url-state.js";
import { FIXTURE_FINGERPRINTS, UNKNOWN_SEL_FINGERPRINT, makeAlertsPayload } from "./alerts-fixtures.js";

const EMPTY_FACETS: FacetSelection = {
  severity: [],
  state: [],
  group: [],
  hostService: [],
  ruleFamily: [],
  ack: [],
};

/** Mirror the router's parseQuery: a URL-decoded flat record of the query string. */
function parse(qs: string): Readonly<Record<string, string>> {
  return Object.fromEntries(new URLSearchParams(qs));
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

const FULL: TriageUrlState = {
  facets: {
    severity: ["warning", "critical"],
    state: ["silenced", "firing"],
    group: ["node", "backup"],
    hostService: ["service:backup", "host:web-01"],
    ruleFamily: ["ungrouped", "availability"],
    ack: ["unacked", "acked"],
  },
  selected: FIXTURE_FINGERPRINTS.hostDown,
};

describe("constants", () => {
  test("values are verbatim from 00 §6", () => {
    expect(FACET_KEYS).toEqual(["severity", "state", "group", "hostService", "ruleFamily", "ack"]);
    expect(QUERY_KEYS).toEqual({
      severity: "sev",
      state: "state",
      group: "group",
      hostService: "hs",
      ruleFamily: "family",
      ack: "ack",
      selected: "sel",
    });
    expect(FACET_DELIMITER).toBe(",");
  });
});

describe("encodeTriageState", () => {
  test("fully-default state encodes to the empty string", () => {
    expect(encodeTriageState({ facets: EMPTY_FACETS, selected: null })).toBe("");
    expect(encodeTriageState({ facets: EMPTY_FACETS, selected: "" })).toBe("");
  });

  test("uses QUERY_KEYS names, FACET_KEYS order, sorted comma-joined values, no leading '?'", () => {
    const qs = encodeTriageState(FULL);
    expect(qs.startsWith("?")).toBe(false);
    const entries = [...new URLSearchParams(qs)];
    expect(entries).toEqual([
      ["sev", "critical,warning"],
      ["state", "firing,silenced"],
      ["group", "backup,node"],
      ["hs", "host:web-01,service:backup"],
      ["family", "availability,ungrouped"],
      ["ack", "acked,unacked"],
      ["sel", FIXTURE_FINGERPRINTS.hostDown],
    ]);
  });

  test("omits empty facets and a null selection", () => {
    const qs = encodeTriageState({
      facets: { ...EMPTY_FACETS, ruleFamily: ["disk"] },
      selected: null,
    });
    expect(qs).toBe("family=disk");
  });

  test("set-equal selections encode to the identical string", () => {
    const a = encodeTriageState({
      facets: { ...EMPTY_FACETS, severity: ["critical", "info", "warning"], group: ["b", "a"] },
      selected: "fp-x",
    });
    const b = encodeTriageState({
      facets: { ...EMPTY_FACETS, severity: ["warning", "critical", "info"], group: ["a", "b"] },
      selected: "fp-x",
    });
    expect(a).toBe(b);
  });

  test("does not mutate the input arrays", () => {
    const severity = ["warning", "critical"];
    encodeTriageState({ facets: { ...EMPTY_FACETS, severity }, selected: null });
    expect(severity).toEqual(["warning", "critical"]);
  });

  test("never emits kiosk or rotate", () => {
    const params = new URLSearchParams(encodeTriageState(FULL));
    expect(params.has("kiosk")).toBe(false);
    expect(params.has("rotate")).toBe(false);
  });
});

describe("decodeTriageState", () => {
  test("round-trips facets (up to value order) and selection", () => {
    const decoded = decodeTriageState(parse(encodeTriageState(FULL)));
    for (const key of FACET_KEYS) {
      expect(sorted(decoded.facets[key])).toEqual(sorted(FULL.facets[key]));
    }
    expect(decoded.selected).toBe(FULL.selected);
  });

  test("round-trips the fully-default state", () => {
    expect(decodeTriageState(parse(encodeTriageState({ facets: EMPTY_FACETS, selected: null })))).toEqual({
      facets: EMPTY_FACETS,
      selected: null,
    });
  });

  test("missing / empty params decode to [] and null selection", () => {
    expect(decodeTriageState({ sev: "", sel: "" })).toEqual({ facets: EMPTY_FACETS, selected: null });
    expect(decodeTriageState({})).toEqual({ facets: EMPTY_FACETS, selected: null });
  });

  test("unknown facet values and unrelated keys do not throw", () => {
    const decoded = decodeTriageState({ state: "bogus,firing", sev: "nope", kiosk: "1", rotate: "30" });
    expect(decoded.facets.state).toEqual(["bogus", "firing"] as unknown as FacetSelection["state"]);
    expect(decoded.facets.severity).toEqual(["nope"]);
    expect(decoded.selected).toBeNull();
  });

  test("drops empty segments from stray delimiters", () => {
    expect(decodeTriageState({ sev: ",critical,,warning," }).facets.severity).toEqual(["critical", "warning"]);
  });
});

describe("resolveSelected", () => {
  const payload = makeAlertsPayload({ scenario: "mixed" });

  test("returns the firing alert whose fingerprint matches sel", () => {
    const alert = resolveSelected(payload, FIXTURE_FINGERPRINTS.hostDown);
    expect(alert).not.toBeNull();
    expect(alert?.fingerprint).toBe(FIXTURE_FINGERPRINTS.hostDown);
    expect(alert).toBe(payload.alerts.find((a) => a.fingerprint === FIXTURE_FINGERPRINTS.hostDown) ?? null);
  });

  test("returns null for a churned fingerprint", () => {
    expect(resolveSelected(payload, UNKNOWN_SEL_FINGERPRINT)).toBeNull();
    expect(resolveSelected(makeAlertsPayload({ scenario: "unknown-sel" }), UNKNOWN_SEL_FINGERPRINT)).toBeNull();
  });

  test("returns null for a null payload or null / empty selection", () => {
    expect(resolveSelected(null, FIXTURE_FINGERPRINTS.hostDown)).toBeNull();
    expect(resolveSelected(payload, null)).toBeNull();
    expect(resolveSelected(payload, "")).toBeNull();
  });
});

describe("ack facet codec (09 §7.6, REQ-ACK-07c)", () => {
  test("FACET_KEYS ends with 'ack' and QUERY_KEYS.ack === 'ack' (REQ-ACK-07c)", () => {
    expect(FACET_KEYS[FACET_KEYS.length - 1]).toBe("ack");
    expect(QUERY_KEYS.ack).toBe("ack");
  });

  test("?ack=acked round-trips through decode/encode (REQ-ACK-07c)", () => {
    const decoded = decodeTriageState(parse("ack=acked"));
    expect(decoded.facets).toEqual({ ...EMPTY_FACETS, ack: ["acked"] });
    expect(encodeTriageState(decoded)).toBe("ack=acked");
    expect(decodeTriageState(parse("ack=unacked,acked")).facets.ack).toEqual(["unacked", "acked"]);
    expect(encodeTriageState(decodeTriageState(parse("ack=unacked,acked")))).toBe("ack=acked%2Cunacked");
  });

  test("an unknown ack value (ack=foo) is dropped (REQ-ACK-07c)", () => {
    expect(decodeTriageState({ ack: "foo" }).facets.ack).toEqual([]);
    expect(decodeTriageState({ ack: "foo,acked,ACKED" }).facets.ack).toEqual(["acked"]);
    expect(encodeTriageState(decodeTriageState({ ack: "foo" }))).toBe("");
  });
});
