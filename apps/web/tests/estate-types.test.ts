// apps/web/tests/estate-types.test.ts — estate view-local types + query helpers (estate-explorer
// item 001; spec 00 §5, §7).

import { describe, expect, test } from "bun:test";

import { createAppStore, type AppStore } from "../src/client/store/index.js";
import {
  DEFAULT_TAB,
  ESTATE_ROUTES,
  estateQueryString,
  readEstate,
  readEstateQuery,
  type EstateDeliveryState,
  type EstateQuery,
} from "../src/client/views/estate/types.js";

function storeWithQuery(query: Record<string, string>): AppStore {
  const store = createAppStore({ storage: null, initialQuery: {} });
  store.route.value = { path: "/estate", view: "estate", params: {}, query };
  return store;
}

const EMPTY: EstateQuery = { tab: DEFAULT_TAB, q: "", sev: "", code: "" };

describe("ESTATE_ROUTES / DEFAULT_TAB", () => {
  test("route patterns are the two entity deep routes", () => {
    expect([...ESTATE_ROUTES]).toEqual(["/estate/host/:name", "/estate/service/:host/:name"]);
  });

  test("DEFAULT_TAB is inventory", () => {
    expect(DEFAULT_TAB).toBe("inventory");
  });

  test("EstateDeliveryState admits exactly the five kinds", () => {
    const kinds: Record<EstateDeliveryState["kind"], true> = {
      loading: true,
      ready: true,
      "not-ready": true,
      "model-absent": true,
      error: true,
    };
    expect(Object.keys(kinds).sort()).toEqual(
      ["error", "loading", "model-absent", "not-ready", "ready"],
    );
  });
});

describe("estateQueryString", () => {
  test("the all-default query serializes to the empty string", () => {
    expect(estateQueryString(EMPTY)).toBe("");
  });

  test("omits tab when it equals DEFAULT_TAB", () => {
    const qs = estateQueryString({ ...EMPTY, q: "nas" });
    expect(new URLSearchParams(qs).has("tab")).toBe(false);
    expect(qs).toBe("q=nas");
  });

  test("keeps a non-default tab", () => {
    expect(estateQueryString({ ...EMPTY, tab: "coverage" })).toBe("tab=coverage");
  });

  test("omits empty q/sev/code individually", () => {
    const params = new URLSearchParams(estateQueryString({ ...EMPTY, tab: "findings", sev: "error" }));
    expect(params.get("sev")).toBe("error");
    expect(params.has("q")).toBe(false);
    expect(params.has("code")).toBe(false);
  });

  test("round-trips a full query through readEstateQuery", () => {
    const full: EstateQuery = { tab: "findings", q: "web 01/&x", sev: "warning", code: "E_DUP" };
    const params = new URLSearchParams(estateQueryString(full));
    const store = storeWithQuery(Object.fromEntries(params));
    expect(readEstateQuery(store)).toEqual(full);
  });
});

describe("readEstateQuery", () => {
  test("applies DEFAULT_TAB and '' defaults when the query is empty", () => {
    expect(readEstateQuery(storeWithQuery({}))).toEqual(EMPTY);
  });

  test("falls back to DEFAULT_TAB for an unrecognized ?tab=", () => {
    expect(readEstateQuery(storeWithQuery({ tab: "bogus" })).tab).toBe(DEFAULT_TAB);
  });

  test("reads tab/q/sev/code from the route query", () => {
    expect(
      readEstateQuery(storeWithQuery({ tab: "coverage", q: "pve", sev: "info", code: "W_X" })),
    ).toEqual({ tab: "coverage", q: "pve", sev: "info", code: "W_X" });
  });
});

describe("readEstate", () => {
  test("returns null when the store slot is empty", () => {
    expect(readEstate(createAppStore({ storage: null, initialQuery: {} }))).toBeNull();
  });
});
