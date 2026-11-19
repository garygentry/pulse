// tests/bundle-error-body.test.ts — the bundle-error 503 body is owned by the wire package.
//
// `BundleErrorKind` (wire) must stay equal to the server's `EstateBundleError["kind"]`: the
// `kindsMatch` assignment below stops typechecking the moment either union gains or loses a member.
// The runtime cases pin the emitted body: same four members, same order, same values.

import { describe, expect, test } from "bun:test";
import type { BundleErrorBody, BundleErrorKind } from "@pulse/web-data/wire";
import { EstateBundleError } from "../src/shared/errors.js";
import { overviewErrorBody, type OverviewErrorBody } from "../src/server/routes/overview.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// Compile-time: `tsc -b` fails here if the two kind unions diverge.
const kindsMatch: Equal<BundleErrorKind, EstateBundleError["kind"]> = true;
// Compile-time: the route's body type is the wire type, not a local copy.
const bodyIsWireType: Equal<OverviewErrorBody, BundleErrorBody> = true;

const KINDS: readonly BundleErrorKind[] = ["missing", "unreadable", "unparseable", "version", "structure", "incoherent"];

describe("bundle-error body", () => {
  test("BundleErrorKind mirrors EstateBundleError kind", () => {
    expect(kindsMatch).toBe(true);
    expect(bodyIsWireType).toBe(true);
  });

  test("the emitted body keeps its exact members, order and bytes", () => {
    const err = new EstateBundleError("version", "model", "/rendered/web-estate-model.json", "unsupported formatVersion 1", {
      foundVersion: 1,
    });
    const body: BundleErrorBody = overviewErrorBody(err);
    expect(Object.keys(body)).toEqual(["code", "kind", "path", "message"]);
    expect(JSON.stringify(body)).toBe(
      JSON.stringify({
        code: "ESTATE_BUNDLE_VERSION",
        kind: "version",
        path: "/rendered/web-estate-model.json",
        message: err.message,
      }),
    );
  });

  test("every kind projects to a four-member body carrying that kind", () => {
    for (const kind of KINDS) {
      const err = new EstateBundleError(kind, "model", "/rendered/web-estate-model.json", "problem");
      const body = overviewErrorBody(err);
      expect(Object.keys(body)).toEqual(["code", "kind", "path", "message"]);
      expect(body.kind).toBe(kind);
      expect(body.code).toBe(err.code);
      expect(body.code.startsWith("ESTATE_BUNDLE_")).toBe(true);
    }
  });
});
