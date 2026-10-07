// Unit tests for views/timeline/url-state.ts: decode decision table (05 §4.8), notice copy (05 §4.2),
// kiosk, generated round trip, encoding/injection, validateSel, paused-window text, transitions and
// the canonical check (05 §4, 08 §3.3). Pure: no DOM.

import { describe, expect, test } from "bun:test";

import type { RangeId } from "@pulse/web-data/wire";
import { buildLaneTree } from "../src/client/views/timeline/model.js";
import type { LaneNode } from "../src/client/views/timeline/model.js";
import { RANGE_SECONDS, TIMELINE_RANGES, timelineStepSeconds } from "../src/client/views/_shared/timeseries/query-meta.js";
import {
  decodeTimelineUrl,
  encodeTimelineUrl,
  END_FUTURE_TOLERANCE_S,
  isCanonicalTimelineQuery,
  PAUSED_WINDOW_OUT_OF_HISTORY_TEXT,
  pausedWindowOutOfHistoryText,
  pausedWindowOutsideHistory,
  TIMELINE_QUERY_KEYS,
  URL_CHANGE_MODE,
  validateSel,
  withPause,
  withRange,
  withResetZoom,
  withResume,
  withSel,
  withZoom,
} from "../src/client/views/timeline/url-state.js";
import type { TimelineUrlState } from "../src/client/views/timeline/url-state.js";
import { makeHierarchySnapshot, makeTimelineIndex } from "./timeline-fixtures.js";

const NOW = 1_790_208_000;
const LIVE: TimelineUrlState = { range: "24h", end: null, zoom: null, sel: null };

/** Parse a query string the way the router does (URLSearchParams → flat record). */
function parse(qs: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(qs)) out[k] = v;
  return out;
}

function messages(q: Record<string, string>, now = NOW): string[] {
  return decodeTimelineUrl(q, now).notices.map((n) => n.message);
}

// ---------------------------------------------------------------------------

describe("constants", () => {
  test("TIMELINE_QUERY_KEYS and END_FUTURE_TOLERANCE_S match 00 §6.3/§6.4", () => {
    expect(TIMELINE_QUERY_KEYS).toEqual({ range: "range", end: "end", zoom: "zoom", sel: "sel" });
    expect(END_FUTURE_TOLERANCE_S).toBe(60);
  });
});

describe("decodeTimelineUrl — 05 §4.8 worked examples (now = 1_790_208_000)", () => {
  test("REQ-URL-01: {} → 24h live, no zoom, no sel, no notices", () => {
    expect(decodeTimelineUrl({}, NOW)).toEqual({ state: LIVE, notices: [] });
  });

  test("REQ-URL-02: {range:'2d'} → 24h with the unknown-range notice", () => {
    expect(decodeTimelineUrl({ range: "2d" }, NOW)).toEqual({
      state: LIVE,
      notices: [{ key: "range", message: "Unknown range '2d' — showing 24h" }],
    });
  });

  test("REQ-URL-01: full valid query decodes as given; sel splits at the first ':'", () => {
    const d = decodeTimelineUrl(
      { range: "6h", end: "1790200000", zoom: "1790190000-1790195000", sel: "host:host:web01" },
      NOW,
    );
    expect(d).toEqual({
      state: { range: "6h", end: 1790200000, zoom: { start: 1790190000, end: 1790195000 }, sel: { kind: "host", id: "host:web01" } },
      notices: [],
    });
  });

  test("REQ-URL-02: end in the future (> now + 60) → live with notice", () => {
    expect(decodeTimelineUrl({ end: "1790300000" }, NOW)).toEqual({
      state: LIVE,
      notices: [{ key: "end", message: "Pause time '1790300000' is in the future — showing live" }],
    });
  });

  test("REQ-URL-02: 1h zoom of 60 s (< 120 s) → zoom null with the narrower-than-2-steps notice", () => {
    // Spec conflict: the §4.8 row's literal zoom "1790200000-1790200060" ends 60 s after end=1790200000,
    // so the normative §4.3 reference hits the outside-range check first. The in-window 60 s
    // window below exercises the row's intent (narrower than 2 steps).
    expect(decodeTimelineUrl({ range: "1h", end: "1790200000", zoom: "1790199940-1790200000" }, NOW)).toEqual({
      state: { range: "1h", end: 1790200000, zoom: null, sel: null },
      notices: [{ key: "zoom", message: "Zoom window '1790199940-1790200000' is narrower than 2 data steps — showing the full range" }],
    });
    expect(decodeTimelineUrl({ range: "1h", end: "1790200000", zoom: "1790200000-1790200060" }, NOW)).toEqual({
      state: { range: "1h", end: 1790200000, zoom: null, sel: null },
      notices: [{ key: "zoom", message: "Zoom window '1790200000-1790200060' is outside the selected range — showing the full range" }],
    });
  });

  test("REQ-URL-02: 1h zoom before now − 3600 → zoom null with the outside-range notice", () => {
    expect(decodeTimelineUrl({ range: "1h", zoom: "1790150000-1790160000" }, NOW)).toEqual({
      state: { range: "1h", end: null, zoom: null, sel: null },
      notices: [{ key: "zoom", message: "Zoom window '1790150000-1790160000' is outside the selected range — showing the full range" }],
    });
  });

  test("REQ-URL-02 / REQ-FOLLOW-02: valid zoom without end is kept and pins end = floor(now)", () => {
    const d = decodeTimelineUrl({ range: "1h", zoom: "1790206000-1790207000" }, NOW + 0.75);
    expect(d).toEqual({
      state: { range: "1h", end: 1790208000, zoom: { start: 1790206000, end: 1790207000 }, sel: null },
      notices: [],
    });
    // …and the URL is not canonical, so 07 rewrites it to add `end`.
    expect(isCanonicalTimelineQuery({ range: "1h", zoom: "1790206000-1790207000" }, d.state)).toBe(false);
    expect(encodeTimelineUrl(d.state, { range: "1h", zoom: "1790206000-1790207000" })).toBe(
      "?range=1h&end=1790208000&zoom=1790206000-1790207000",
    );
  });

  test("REQ-URL-01: paused end older than now − R is valid; pausedWindowOutsideHistory is true", () => {
    const d = decodeTimelineUrl({ range: "1h", end: "1790000000" }, NOW);
    expect(d).toEqual({ state: { range: "1h", end: 1790000000, zoom: null, sel: null }, notices: [] });
    expect(pausedWindowOutsideHistory(d.state, NOW)).toBe(true);
    expect(pausedWindowOutOfHistoryText(d.state.range)).toBe(
      "History is only available for the latest 1h; the paused window is older",
    );
  });

  test("REQ-KIOSK-03: kiosk=1 honours range and ignores end/zoom/sel without notices", () => {
    expect(decodeTimelineUrl({ kiosk: "1", range: "6h", end: "1", zoom: "x", sel: "y" }, NOW)).toEqual({
      state: { range: "6h", end: null, zoom: null, sel: null },
      notices: [],
    });
  });

  test("REQ-URL-02: sel with endpoint kind → null with the invalid-selection notice", () => {
    expect(decodeTimelineUrl({ sel: "endpoint:web01/nginx" }, NOW)).toEqual({
      state: LIVE,
      notices: [{ key: "sel", message: "Invalid selection 'endpoint:web01/nginx' — showing no selection" }],
    });
  });
});

describe("decodeTimelineUrl — 05 §4.2 notice rows (REQ-URL-02)", () => {
  test("REQ-URL-02: range not a timeline range", () => {
    expect(messages({ range: "90d" })).toEqual(["Unknown range '90d' — showing 24h"]);
    expect(messages({ range: "24H" })).toEqual(["Unknown range '24H' — showing 24h"]);
  });

  test("REQ-URL-02: end not an integer ≥ 1 with at most 12 digits", () => {
    for (const raw of ["abc", "0", "-5", "1.5", "1234567890123", " 1790200000", "1e9"]) {
      expect(messages({ end: raw })).toEqual([`Invalid pause time '${raw}' — showing live`]);
    }
  });

  test("REQ-URL-02: end > now + 60 is in the future; now + 60 exactly is accepted", () => {
    const over = String(NOW + END_FUTURE_TOLERANCE_S + 1);
    expect(messages({ end: over })).toEqual([`Pause time '${over}' is in the future — showing live`]);
    const edge = decodeTimelineUrl({ end: String(NOW + 60) }, NOW);
    expect(edge.notices).toEqual([]);
    expect(edge.state.end).toBe(NOW + 60);
  });

  test("REQ-URL-02: zoom malformed or start ≥ end → invalid zoom window", () => {
    const base = { end: String(NOW) };
    for (const raw of ["garbage", "1790200000", "1790200000-", "a-b", "1790207000-1790206000", "1790206000-1790206000", "1-2-3"]) {
      expect(messages({ ...base, zoom: raw })).toEqual([`Invalid zoom window '${raw}' — showing the full range`]);
    }
  });

  test("REQ-URL-02: zoom not inside [E − R, E] → outside the selected range (end side too)", () => {
    const raw = `${NOW - 1000}-${NOW + 10}`;
    expect(messages({ zoom: raw })).toEqual([`Zoom window '${raw}' is outside the selected range — showing the full range`]);
    // Validated against the post-fallback end: an invalid end falls back to live (E = now).
    const raw2 = `${NOW - 3000}-${NOW - 1000}`;
    expect(messages({ range: "1h", end: "junk", zoom: raw2 })).toEqual(["Invalid pause time 'junk' — showing live"]);
  });

  test("REQ-URL-02: zoom narrower than 2 steps, per range minimum (120/120/290/2024 s)", () => {
    const min: Record<RangeId, number> = { "1h": 120, "6h": 120, "24h": 290, "7d": 2024 };
    for (const r of TIMELINE_RANGES) {
      expect(2 * timelineStepSeconds(r)).toBe(min[r]);
      const ok = `${NOW - min[r]}-${NOW}`;
      expect(decodeTimelineUrl({ range: r, end: String(NOW), zoom: ok }, NOW).notices).toEqual([]);
      const narrow = `${NOW - min[r] + 1}-${NOW}`;
      expect(messages({ range: r, end: String(NOW), zoom: narrow })).toEqual([
        `Zoom window '${narrow}' is narrower than 2 data steps — showing the full range`,
      ]);
    }
  });

  test("REQ-URL-02: zoom validated against the post-fallback range (bad range → 24h window)", () => {
    // Inside 24h but outside 1h: with range "bogus" → 24h, the zoom is kept.
    const raw = `${NOW - 20000}-${NOW - 10000}`;
    const d = decodeTimelineUrl({ range: "bogus", end: String(NOW), zoom: raw }, NOW);
    expect(d.state.zoom).toEqual({ start: NOW - 20000, end: NOW - 10000 });
    expect(d.notices.map((n) => n.key)).toEqual(["range"]);
  });

  test("REQ-URL-02: sel malformed (kind, empty id, id over 512, no colon)", () => {
    for (const raw of ["endpoint:x", "hostweb01", "host:", ":web01", "Host:web01", `host:${"a".repeat(513)}`]) {
      expect(messages({ sel: raw })).toEqual([`Invalid selection '${raw.length <= 40 ? raw : raw.slice(0, 40) + "…"}' — showing no selection`]);
    }
    const max = `service:${"b".repeat(512)}`;
    expect(decodeTimelineUrl({ sel: max }, NOW).state.sel).toEqual({ kind: "service", id: "b".repeat(512) });
  });

  test("REQ-URL-02: displayRaw passes 40 code units through and truncates longer values with '…'", () => {
    const forty = "x".repeat(40);
    expect(messages({ range: forty })).toEqual([`Unknown range '${forty}' — showing 24h`]);
    const long = "y".repeat(41) + "TAIL";
    expect(messages({ range: long })).toEqual([`Unknown range '${"y".repeat(40)}…' — showing 24h`]);
    const zoomLong = `${"1".repeat(12)}-${"2".repeat(12)}-${"3".repeat(20)}`;
    expect(messages({ zoom: zoomLong })).toEqual([`Invalid zoom window '${zoomLong.slice(0, 40)}…' — showing the full range`]);
  });

  test("REQ-URL-02 / REQ-SEC-02: markup in a raw value is echoed as plain text in the message", () => {
    expect(messages({ range: "<b>x</b>" })).toEqual(["Unknown range '<b>x</b>' — showing 24h"]);
  });

  test("REQ-URL-02: empty values are treated as absent (no notice)", () => {
    expect(decodeTimelineUrl({ range: "", end: "", zoom: "", sel: "" }, NOW)).toEqual({ state: LIVE, notices: [] });
  });

  test("REQ-URL-02: every key invalid → one notice per key, in range → end → zoom → sel order", () => {
    const d = decodeTimelineUrl({ sel: "nope", zoom: "x", end: "y", range: "z" }, NOW);
    expect(d.state).toEqual(LIVE);
    expect(d.notices.map((n) => n.key)).toEqual(["range", "end", "zoom", "sel"]);
  });

  test("REQ-URL-01: never throws on hostile or odd input", () => {
    const odd = ["\u0000", "%zz", "💥".repeat(30), "99999999999999999999", "-", ":", "1-", "NaN-Infinity"];
    for (const v of odd) {
      expect(() => decodeTimelineUrl({ range: v, end: v, zoom: v, sel: v }, NOW)).not.toThrow();
      expect(() => decodeTimelineUrl({ range: v }, Number.NaN)).not.toThrow();
    }
  });
});

describe("decodeTimelineUrl — kiosk (REQ-KIOSK-03)", () => {
  test("REQ-KIOSK-03: kiosk=1 with a valid range honours it, is live, and ignores end/zoom/sel silently", () => {
    const d = decodeTimelineUrl(
      { kiosk: "1", range: "7d", end: "1790200000", zoom: "1790190000-1790195000", sel: "host:host:web01" },
      NOW,
    );
    expect(d).toEqual({ state: { range: "7d", end: null, zoom: null, sel: null }, notices: [] });
  });

  test("REQ-KIOSK-03: kiosk=1 still reports an invalid range but nothing for the ignored keys", () => {
    expect(decodeTimelineUrl({ kiosk: "1", range: "2d", end: "junk", sel: "junk" }, NOW).notices).toEqual([
      { key: "range", message: "Unknown range '2d' — showing 24h" },
    ]);
  });

  test("REQ-KIOSK-03: kiosk values other than '1' are desk mode", () => {
    expect(decodeTimelineUrl({ kiosk: "0", end: "junk" }, NOW).notices.map((n) => n.key)).toEqual(["end"]);
  });
});

// ---------------------------------------------------------------------------

/** Seeded PRNG (mulberry32) so the generated round trip is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ID_ALPHABET = ["a", "Z", "0", "-", "_", ".", ":", "/", "&", "=", "#", "?", "%", "+", " ", "é", "💥", "<", ">"];

function genState(rand: () => number): TimelineUrlState {
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
  const range = TIMELINE_RANGES[int(0, TIMELINE_RANGES.length - 1)] as RangeId;
  const R = RANGE_SECONDS[range];
  const minW = 2 * timelineStepSeconds(range);
  const paused = rand() < 0.6;
  const end = paused ? int(Math.max(1, NOW - 3 * R), NOW + 60) : null;
  let zoom: TimelineUrlState["zoom"] = null;
  if (end !== null && rand() < 0.6) {
    const width = int(minW, R);
    const start = int(end - R, end - width);
    zoom = { start, end: start + width };
  }
  let sel: TimelineUrlState["sel"] = null;
  if (rand() < 0.7) {
    const len = int(1, 40);
    let id = "";
    for (let i = 0; i < len; i++) id += ID_ALPHABET[int(0, ID_ALPHABET.length - 1)];
    sel = { kind: rand() < 0.5 ? "host" : "service", id };
  }
  return { range, end, zoom, sel };
}

describe("encodeTimelineUrl (REQ-URL-01, REQ-SEC-04)", () => {
  test("REQ-URL-01: 200 generated valid states round-trip decode(parse(encode(s))) with no notices", () => {
    const rand = mulberry32(0x5eed_0009);
    let zoomed = 0;
    let selected = 0;
    for (let i = 0; i < 200; i++) {
      const s = genState(rand);
      if (s.zoom !== null) zoomed++;
      if (s.sel !== null) selected++;
      const qs = encodeTimelineUrl(s, {});
      const q = parse(qs);
      const d = decodeTimelineUrl(q, NOW);
      expect(d.notices).toEqual([]);
      expect(d.state).toEqual(s);
      expect(isCanonicalTimelineQuery(q, s)).toBe(true);
    }
    expect(zoomed).toBeGreaterThan(20);
    expect(selected).toBeGreaterThan(50);
  });

  test("REQ-URL-01: matches the 05 §4.8 encode example exactly", () => {
    expect(
      encodeTimelineUrl(
        { range: "6h", end: 1790200000, zoom: null, sel: { kind: "service", id: "svc:web01/nginx" } },
        { kiosk: "1", rotate: "overview,timeline", range: "24h" },
      ),
    ).toBe("?kiosk=1&rotate=overview%2Ctimeline&range=6h&end=1790200000&sel=service%3Asvc%3Aweb01%2Fnginx");
  });

  test("REQ-URL-01: defaults omitted; empty state and no unrelated keys → ''", () => {
    expect(encodeTimelineUrl(LIVE, {})).toBe("");
    expect(encodeTimelineUrl(LIVE, { range: "6h", end: "1", zoom: "1-2", sel: "host:x" })).toBe("");
  });

  test("REQ-URL-01: unrelated keys (incl. kiosk/rotate) kept first, in insertion order, owned keys last", () => {
    const qs = encodeTimelineUrl(
      { range: "1h", end: 1790200000, zoom: { start: 1790197000, end: 1790199000 }, sel: { kind: "host", id: "host:web01" } },
      { sel: "host:old", tab: "catalog", kiosk: "1", zoom: "1-2", rotate: "overview", z: "last" },
    );
    expect(qs).toBe(
      "?tab=catalog&kiosk=1&rotate=overview&z=last&range=1h&end=1790200000&zoom=1790197000-1790199000&sel=host%3Ahost%3Aweb01",
    );
  });

  test("REQ-URL-01: zoom bounds rounded outward and end floored when written", () => {
    expect(
      encodeTimelineUrl({ range: "24h", end: 1790200000.9, zoom: { start: 1790100000.7, end: 1790150000.2 }, sel: null }, {}),
    ).toBe("?end=1790200000&zoom=1790100000-1790150001");
  });

  test("REQ-SEC-04: ':', '/', '&', '=', '#' are percent-encoded in keys and values", () => {
    const qs = encodeTimelineUrl(
      { ...LIVE, sel: { kind: "host", id: "a:b/c&d=e#f" } },
      { "we&ird=key#": "v/a:l&u=e#" },
    );
    expect(qs).toBe("?we%26ird%3Dkey%23=v%2Fa%3Al%26u%3De%23&sel=host%3Aa%3Ab%2Fc%26d%3De%23f");
    const body = qs.slice(1);
    for (const ch of [":", "/", "#"]) expect(body.includes(ch)).toBe(false);
    expect(body.split("&")).toHaveLength(2);
    expect(body.split("=")).toHaveLength(3);
  });

  test("REQ-SEC-04: a sel id containing '&x=1' yields no 'x' parameter after URLSearchParams parsing", () => {
    const s: TimelineUrlState = { ...LIVE, sel: { kind: "service", id: "svc:web01/nginx&x=1" } };
    const params = new URLSearchParams(encodeTimelineUrl(s, {}));
    expect(params.has("x")).toBe(false);
    expect(params.get("sel")).toBe("service:svc:web01/nginx&x=1");
    expect(decodeTimelineUrl(parse(encodeTimelineUrl(s, {})), NOW).state).toEqual(s);
  });
});

// ---------------------------------------------------------------------------

describe("validateSel (REQ-URL-02)", () => {
  const tree = buildLaneTree(
    makeHierarchySnapshot({ hosts: 2, servicesPerHost: 2 }),
    makeTimelineIndex(makeHierarchySnapshot({ hosts: 2, servicesPerHost: 2 })),
  );
  const host = tree.hosts[0] as LaneNode;
  const svc = host.children[0] as LaneNode;

  test("REQ-URL-02: known host and service selections are left untouched (same state object)", () => {
    for (const node of [host, svc]) {
      const s = withSel(LIVE, node);
      const r = validateSel(s, tree);
      expect(r.notice).toBeNull();
      expect(r.state).toBe(s);
    }
  });

  test("REQ-URL-02: no selection → unchanged, no notice", () => {
    expect(validateSel(LIVE, tree)).toEqual({ state: LIVE, notice: null });
  });

  test("REQ-URL-02: unknown sel is cleared with the 'Unknown target' notice; other fields kept", () => {
    const s: TimelineUrlState = { range: "6h", end: 1790200000, zoom: null, sel: { kind: "host", id: "host:ghost" } };
    expect(validateSel(s, tree)).toEqual({
      state: { ...s, sel: null },
      notice: { key: "sel", message: "Unknown target 'host:host:ghost' — showing no selection" },
    });
  });

  test("REQ-URL-02: a service id given with the host kind is unknown; long ids truncate via displayRaw", () => {
    const wrongKind: TimelineUrlState = { ...LIVE, sel: { kind: "host", id: svc.target.id } };
    expect(validateSel(wrongKind, tree).state.sel).toBeNull();
    const long: TimelineUrlState = { ...LIVE, sel: { kind: "service", id: "z".repeat(100) } };
    const key = `service:${"z".repeat(100)}`;
    expect(validateSel(long, tree).notice?.message).toBe(`Unknown target '${key.slice(0, 40)}…' — showing no selection`);
  });
});

describe("paused window out of history (05 §4.3.1)", () => {
  test("pausedWindowOutsideHistory is true only when end < now − R, false when live", () => {
    const R = RANGE_SECONDS["24h"];
    expect(pausedWindowOutsideHistory(LIVE, NOW)).toBe(false);
    expect(pausedWindowOutsideHistory({ ...LIVE, end: NOW - R - 1 }, NOW)).toBe(true);
    expect(pausedWindowOutsideHistory({ ...LIVE, end: NOW - R }, NOW)).toBe(false);
    expect(pausedWindowOutsideHistory({ ...LIVE, end: NOW - 10 }, NOW)).toBe(false);
    expect(pausedWindowOutsideHistory({ ...LIVE, end: NOW - R - 1 }, NOW + 0.9)).toBe(true);
  });

  test("pausedWindowOutOfHistoryText substitutes the range id", () => {
    expect(PAUSED_WINDOW_OUT_OF_HISTORY_TEXT).toBe("History is only available for the latest {range}; the paused window is older");
    expect(pausedWindowOutOfHistoryText("24h")).toBe("History is only available for the latest 24h; the paused window is older");
    expect(pausedWindowOutOfHistoryText("7d")).toBe("History is only available for the latest 7d; the paused window is older");
  });
});

// ---------------------------------------------------------------------------

describe("state transitions (05 §4.6)", () => {
  const paused: TimelineUrlState = {
    range: "6h",
    end: 1790200000,
    zoom: { start: 1790190000, end: 1790195000 },
    sel: { kind: "host", id: "host:web01" },
  };

  test("REQ-URL-01: URL_CHANGE_MODE pushes range/select/pause/resume and replaces zoom/reset-zoom/cursor-pin", () => {
    expect(URL_CHANGE_MODE).toEqual({
      range: "push",
      select: "push",
      pause: "push",
      resume: "push",
      zoom: "replace",
      "reset-zoom": "replace",
      "cursor-pin": "replace",
    });
  });

  test("REQ-URL-01: withRange sets the range and clears zoom, keeping end and sel", () => {
    expect(withRange(paused, "1h")).toEqual({ ...paused, range: "1h", zoom: null });
  });

  test("REQ-FOLLOW-02: withPause pins end = floor(domainEnd) when live and is idempotent when paused", () => {
    expect(withPause(LIVE, NOW + 0.4)).toEqual({ ...LIVE, end: NOW });
    expect(withPause(paused, NOW)).toBe(paused);
    expect(withPause(LIVE, Number.NaN)).toBe(LIVE);
  });

  test("REQ-FOLLOW-02: withResume clears end and zoom, keeping range and sel", () => {
    expect(withResume(paused)).toEqual({ range: "6h", end: null, zoom: null, sel: paused.sel });
  });

  test("REQ-FOLLOW-02: withZoom while live pauses at domainEnd and stores the window", () => {
    const next = withZoom(LIVE, { start: NOW - 5000, end: NOW - 1000 }, NOW);
    expect(next).toEqual({ ...LIVE, end: NOW, zoom: { start: NOW - 5000, end: NOW - 1000 } });
  });

  test("REQ-URL-01: withZoom rounds outward to whole seconds and clamps into [E − R, E] of the paused end", () => {
    const E = paused.end as number;
    const R = RANGE_SECONDS["6h"];
    expect(withZoom(paused, { start: E - 1000.6, end: E - 500.2 }, NOW).zoom).toEqual({ start: E - 1001, end: E - 500 });
    const clamped = withZoom(paused, { start: E - R - 999, end: E + 999 }, NOW);
    expect(clamped.end).toBe(E); // paused anchor kept, not domainEnd
    expect(clamped.zoom).toEqual({ start: E - R, end: E });
  });

  test("REQ-URL-01: withZoom narrower than MIN_ZOOM_STEPS × step returns the state unchanged", () => {
    expect(withZoom(LIVE, { start: NOW - 100, end: NOW }, NOW)).toBe(LIVE); // 24h min 290 s
    expect(withZoom(paused, { start: 1790199990, end: 1790200000 }, NOW)).toBe(paused);
    expect(withZoom(LIVE, { start: Number.NaN, end: NOW }, NOW)).toBe(LIVE);
  });

  test("REQ-URL-01: withZoom output round-trips through encode/decode with no notices", () => {
    const next = withZoom(LIVE, { start: NOW - 7200.5, end: NOW - 3600.5 }, NOW);
    expect(decodeTimelineUrl(parse(encodeTimelineUrl(next, {})), NOW)).toEqual({ state: next, notices: [] });
  });

  test("withResetZoom clears zoom and keeps the page paused", () => {
    expect(withResetZoom(paused)).toEqual({ ...paused, zoom: null });
    expect(withResetZoom(LIVE)).toBe(LIVE);
  });

  test("withSel selects a host or service lane, clears with null, and ignores endpoint nodes", () => {
    const node = (kind: "host" | "service" | "endpoint", id: string): LaneNode => ({
      target: { kind, id },
      label: id,
      hostName: null,
      name: id,
      endpoints: [],
      queryIds: [],
      grafanaUrl: null,
      children: [],
    });
    expect(withSel(LIVE, node("host", "host:web01")).sel).toEqual({ kind: "host", id: "host:web01" });
    expect(withSel(LIVE, node("service", "svc:web01/nginx")).sel).toEqual({ kind: "service", id: "svc:web01/nginx" });
    expect(withSel(paused, null)).toEqual({ ...paused, sel: null });
    expect(withSel(LIVE, node("endpoint", "web01/nginx"))).toBe(LIVE);
  });
});

describe("isCanonicalTimelineQuery (05 §4.7, REQ-URL-02)", () => {
  test("REQ-URL-02: false for invalid values (decoded state drops them)", () => {
    for (const q of [{ range: "90d" }, { end: "junk" }, { zoom: "garbage" }, { sel: "nope" }, { range: "24h" }, { range: "" }]) {
      const d = decodeTimelineUrl(q, NOW);
      expect(isCanonicalTimelineQuery(q, d.state)).toBe(false);
    }
  });

  test("REQ-URL-02: false for zoom without end", () => {
    const q = { range: "1h", zoom: "1790206000-1790207000" };
    expect(isCanonicalTimelineQuery(q, decodeTimelineUrl(q, NOW).state)).toBe(false);
  });

  test("REQ-URL-02: true after encodeTimelineUrl, and the follow-up decode is idempotent with no notices", () => {
    for (const q of [{ range: "90d", tab: "x" }, { range: "1h", zoom: "1790206000-1790207000", kiosk: "0" }, {}]) {
      const d = decodeTimelineUrl(q, NOW);
      const rewritten = parse(encodeTimelineUrl(d.state, q));
      expect(isCanonicalTimelineQuery(rewritten, d.state)).toBe(true);
      expect(decodeTimelineUrl(rewritten, NOW)).toEqual({ state: d.state, notices: [] });
    }
  });

  test("REQ-URL-02: unrelated keys never affect canonicality", () => {
    expect(isCanonicalTimelineQuery({ kiosk: "1", rotate: "a,b", other: "z" }, LIVE)).toBe(true);
  });
});
