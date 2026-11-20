// The contract document tooling: marker grammar and rewrite, the table renderers, the typed
// operations source checked against the real routes, and the committed CONTRACT.md outline.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { CONTRACT_LIMITS, ENUM_FALLBACKS } from "@pulse/web-data/contract";
import type { EnumFallbackEntry } from "@pulse/web-data/contract";
import type { HistoryFailure, HistoryService } from "@pulse/web-data/history";
import { ERROR_MESSAGES } from "@pulse/web-data/wire";

import {
  GENERATED_SECTION_NAMES,
  LIMIT_LABELS,
  OVER_CAP,
  buildGeneratedSections,
  cell,
  closeMarker,
  openMarker,
  renderContractDoc,
  renderEnumFallbacksTable,
  renderFieldTables,
  renderFixturesTable,
  renderLimitsTable,
  renderOperationsTable,
} from "../../scripts/contract/contract-doc.js";
import type { GeneratedSectionName } from "../../scripts/contract/contract-doc.js";
import { ContractToolError } from "../../scripts/contract/errors.js";
import { MAX_PARAM_BYTES, MAX_QUERY_BYTES, OPERATIONS } from "../../scripts/contract/operations.js";
import type { ContractOperation } from "../../scripts/contract/operations.js";
import { SHAPE_ROOTS } from "../../scripts/contract/shape-types.js";
import type { ShapeNode, ShapeSnapshot } from "../../scripts/contract/shape-types.js";
import type { FixtureIndex } from "../../scripts/contract/types.js";
import { currentShape, GENERATION_TIMEOUT } from "./generated.js";
import type { ServerConfig } from "../../src/server/config.js";
import { alertsRoute, estateRoute, timelineRoute } from "../../src/server/routes/current.js";
import {
  CHECKS_DEFAULT_RANGE,
  HISTORY_STATUS,
  historyAlertsRoute,
  historyChecksRoute,
  historyEstateRoute,
  historyTargetRoute,
} from "../../src/server/routes/history.js";
import { ROUTES } from "../../src/server/routes/registry.js";
import type { RouteDefinition, RouteRequest, ServerContext } from "../../src/shared/registry.js";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const CONTRACT_MD = readFileSync(join(REPO_ROOT, "contract", "CONTRACT.md"), "utf8");

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

function sectionsWith(text: (name: GeneratedSectionName) => string): Record<GeneratedSectionName, string> {
  const sections = {} as Record<GeneratedSectionName, string>;
  for (const name of GENERATED_SECTION_NAMES) sections[name] = text(name);
  return sections;
}

/** A minimal valid document: prose around every marker pair, in order. */
function skeleton(body = ""): string {
  const parts = ["# Title", "", "Intro prose.", ""];
  for (const name of GENERATED_SECTION_NAMES) {
    parts.push(`Before ${name}.`, openMarker(name));
    if (body !== "") parts.push(body);
    parts.push(closeMarker(name), `After ${name}.`, "");
  }
  return parts.join("\n");
}

function markerFailure(doc: string): ContractToolError {
  try {
    renderContractDoc(doc, sectionsWith(() => "x"));
  } catch (error) {
    if (error instanceof ContractToolError) return error;
    throw error;
  }
  throw new Error("renderContractDoc did not throw");
}

/** Count the `|` characters of a line that are not escaped by a backslash. */
function unescapedPipes(line: string): number {
  let count = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === "\\") i += 1;
    else if (line[i] === "|") count += 1;
  }
  return count;
}

/** Assert every table line of a rendered section has as many columns as its header. */
function expectRectangular(markdown: string, columns: number): void {
  const lines = markdown.split("\n").filter((line) => line.startsWith("|"));
  expect(lines.length).toBeGreaterThanOrEqual(2);
  for (const line of lines) expect(unescapedPipes(line)).toBe(columns + 1);
}

function node(path: string, kind: ShapeNode["kind"], extra: Partial<Omit<ShapeNode, "path" | "kind">> = {}): ShapeNode {
  return { path, kind, optional: false, nullable: false, ...extra };
}

const SNAPSHOT: ShapeSnapshot = {
  version: { major: 1, minor: 0 },
  roots: {
    ...Object.fromEntries(SHAPE_ROOTS.map((root) => [root, [node(root, "object")]])),
    AlertsPayload: [
      node("AlertsPayload", "object"),
      node("AlertsPayload.alerts", "array"),
      node("AlertsPayload.alerts[]", "object"),
      node("AlertsPayload.alerts[].endsAt", "string", { nullable: true }),
      node("AlertsPayload.alerts[].labels", "record"),
      node("AlertsPayload.alerts[].labels{}", "scalar-union", { members: ["number", "string"] }),
      node("AlertsPayload.alerts[].note", "string", { optional: true }),
      node("AlertsPayload.alerts[].state", "literal-union", { members: ["firing", "silenced"] }),
      node("AlertsPayload.formatVersion", "literal", { members: ["2"] }),
      node("AlertsPayload.generatedAt", "template"),
      node("AlertsPayload.window", "tuple"),
    ],
    TimelinePayload: [
      node("TimelinePayload", "object"),
      node("TimelinePayload.targets[].state", "literal-union", { members: ["pending", "firing"] }),
    ],
  },
};

const FALLBACKS: readonly EnumFallbackEntry[] = [
  { group: "zeta-rule", paths: ["TimelinePayload.targets[].state"], fallback: { kind: "display-rule", rule: "Hide it | entirely." } },
  {
    group: "alert-state",
    paths: ["AlertsPayload.alerts[].state", "TimelinePayload.targets[].state"],
    fallback: { kind: "as-member", member: "firing" },
  },
];

const INDEX: FixtureIndex = {
  formatVersion: 1,
  contract: { major: 1, minor: 0 },
  fixtures: [
    {
      path: "fixtures/connect-link/http-url.json", group: "connect-link", operation: "connect-link",
      scenario: "http-url", kind: "connect-link", status: null, expect: "reject", webValidator: null,
      rejection: "not-https",
    },
    {
      path: "fixtures/handshake/server-too-old-minor.json", group: "handshake", operation: "handshake",
      scenario: "server-too-old-minor", kind: "handshake", status: null, expect: "accept", webValidator: null,
      client: { major: 1, minMinor: 1 }, expectedOutcome: "server-too-old",
    },
    {
      path: "fixtures/overview/typical.json", group: "overview", operation: "GET /api/overview",
      scenario: "typical", kind: "response", status: 200, expect: "accept", webValidator: "overview",
    },
  ],
};

// ── Marker grammar and rewrite ───────────────────────────────────────────────────────────────────

describe("generated section names", () => {
  test("are operations, one fields section per root, limits, enum-fallbacks, fixtures", () => {
    expect(GENERATED_SECTION_NAMES).toHaveLength(4 + SHAPE_ROOTS.length);
    expect([...GENERATED_SECTION_NAMES]).toEqual([
      "operations",
      ...SHAPE_ROOTS.map((root) => `fields:${root}` as const),
      "limits",
      "enum-fallbacks",
      "fixtures",
    ]);
    expect(Object.isFrozen(GENERATED_SECTION_NAMES)).toBe(true);
  });
});

describe("renderContractDoc", () => {
  test("replaces only the text between markers", () => {
    const before = skeleton("stale line 1\nstale line 2");
    const after = renderContractDoc(before, sectionsWith((name) => `body of ${name}\n\n`));
    expect(after).not.toContain("stale");
    for (const name of GENERATED_SECTION_NAMES) {
      expect(after).toContain(`Before ${name}.\n${openMarker(name)}\nbody of ${name}\n${closeMarker(name)}\nAfter ${name}.`);
    }
    // Prose outside the pairs is byte-identical: stripping the section bodies gives the empty skeleton.
    let stripped = after;
    for (const name of GENERATED_SECTION_NAMES) stripped = stripped.replace(`body of ${name}\n`, "");
    expect(stripped).toBe(skeleton());
    expect(after.endsWith("\n")).toBe(true);
  });

  test("an empty section yields the open line directly followed by the close line", () => {
    const after = renderContractDoc(skeleton("old"), sectionsWith(() => "\n"));
    expect(after).toBe(skeleton());
  });

  test("is idempotent and pure", () => {
    const sections = sectionsWith((name) => `| ${name} |\n|---|\n`);
    const once = renderContractDoc(skeleton(), sections);
    expect(renderContractDoc(once, sections)).toBe(once);
    expect(renderContractDoc(skeleton(), sections)).toBe(once);
  });

  test("a line that only resembles a marker is prose", () => {
    const doc = skeleton().replace("Intro prose.", "Intro `<!-- generated:limits -->` prose.\n <!-- generated:limits -->");
    const after = renderContractDoc(doc, sectionsWith(() => "x"));
    expect(after).toContain("Intro `<!-- generated:limits -->` prose.\n <!-- generated:limits -->\n");
  });

  test("a missing open and close pair throws MARKER_MISSING", () => {
    const doc = skeleton().replace(`${openMarker("limits")}\n${closeMarker("limits")}\n`, "");
    const error = markerFailure(doc);
    expect(error.code).toBe("MARKER_MISSING");
    expect(error.subject).toBe("contract/CONTRACT.md");
    expect(error.message).toContain("missing");
    expect(error.message).toContain(openMarker("limits"));
  });

  test("a missing close marker names the open marker's line", () => {
    const doc = skeleton().replace(`${closeMarker("fixtures")}\n`, "");
    const line = doc.split("\n").indexOf(openMarker("fixtures")) + 1;
    const error = markerFailure(doc);
    expect(error.code).toBe("MARKER_MISSING");
    expect(error.message).toContain("missing");
    expect(error.message).toContain(closeMarker("fixtures"));
    expect(error.message).toContain(`line ${line}`);
  });

  test("a duplicate marker throws with its line number", () => {
    const doc = `${skeleton()}${openMarker("operations")}\n${closeMarker("operations")}\n`;
    const line = doc.split("\n").lastIndexOf(openMarker("operations")) + 1;
    const error = markerFailure(doc);
    expect(error.code).toBe("MARKER_MISSING");
    expect(error.message).toContain("duplicate");
    expect(error.message).toContain(`line ${line}`);
  });

  test("a close before its open throws with its line number", () => {
    const doc = skeleton().replace(
      `${openMarker("limits")}\n${closeMarker("limits")}`,
      `${closeMarker("limits")}\n${openMarker("limits")}`,
    );
    const line = doc.split("\n").indexOf(closeMarker("limits")) + 1;
    const error = markerFailure(doc);
    expect(error.code).toBe("MARKER_MISSING");
    expect(error.message).toContain("out of order");
    expect(error.message).toContain(`line ${line}`);
  });

  test("nested or overlapping pairs throw with a line number", () => {
    const nested = skeleton().replace(
      `${openMarker("limits")}\n${closeMarker("limits")}`,
      `${openMarker("limits")}\n${openMarker("enum-fallbacks")}\n${closeMarker("enum-fallbacks")}\n${closeMarker("limits")}`,
    ).replace(`Before enum-fallbacks.\n${openMarker("enum-fallbacks")}\n${closeMarker("enum-fallbacks")}\n`, "");
    const error = markerFailure(nested);
    expect(error.code).toBe("MARKER_MISSING");
    expect(error.message).toContain("nested");
    expect(error.message).toContain(`line ${nested.split("\n").indexOf(openMarker("enum-fallbacks")) + 1}`);

    const overlapping = skeleton().replace(
      `${openMarker("limits")}\n${closeMarker("limits")}`,
      `${openMarker("limits")}\n${closeMarker("operations")}\n${closeMarker("limits")}`,
    ).replace(`${openMarker("operations")}\n${closeMarker("operations")}`, openMarker("operations"));
    expect(markerFailure(overlapping).code).toBe("MARKER_MISSING");
  });

  test("an unknown marker name throws with its line number", () => {
    const doc = `${skeleton()}<!-- generated:fields:Nope -->\n`;
    const error = markerFailure(doc);
    expect(error.code).toBe("MARKER_MISSING");
    expect(error.message).toContain("unknown name");
    expect(error.message).toContain(`line ${doc.split("\n").indexOf("<!-- generated:fields:Nope -->") + 1}`);
  });

  test("a CR anywhere throws with its line number", () => {
    const error = markerFailure(skeleton().replace("Intro prose.", "Intro prose.\r"));
    expect(error.code).toBe("MARKER_MISSING");
    expect(error.message).toContain("CR line ending");
    expect(error.message).toContain("line 3");
  });
});

// ── Renderers ────────────────────────────────────────────────────────────────────────────────────

describe("cell", () => {
  test("escapes backslash and pipe, and flattens newlines", () => {
    expect(cell("a|b")).toBe("a\\|b");
    expect(cell("a\\b")).toBe("a\\\\b");
    expect(cell("a\nb")).toBe("a b");
  });
});

describe("renderOperationsTable", () => {
  const rendered = renderOperationsTable(OPERATIONS);
  const lines = rendered.split("\n");

  test("has the documented header and one row per operation", () => {
    expect(lines[0]).toBe(
      "| Operation | Method | Path | Auth | Parameters | Request body | Success | Errors | Caching | Response |",
    );
    expect(lines[1]).toBe("|---|---|---|---|---|---|---|---|---|---|");
    expect(lines.filter((line) => line.startsWith("| ")).length).toBe(1 + OPERATIONS.length);
    expectRectangular(rendered, 10);
  });

  test("the overview row matches the documented layout", () => {
    expect(lines).toContain(
      "| Overview | `GET` | `/api/overview` | none | none | none | 200, 304 | `400` `INVALID_REQUEST`: query string over 2048 bytes, a repeated query key, or a malformed/over-512-byte path parameter<br>`500` `INTERNAL_ERROR`: unexpected server fault<br>`503` `ESTATE_BUNDLE_*` (BundleErrorBody): the estate bundle failed to load<br>`503` `NOT_READY`: before the first cycle is published | ETag + If-None-Match → 304; `private, no-cache`; Vary: Accept-Encoding | [`OverviewSnapshotV2`](#fields-overviewsnapshotv2) |",
    );
    expect(lines).toContain(
      "- **Overview:** Before the first cycle, the server may answer 200 with the same body type and no `ETag`, `X-Pulse-*` or `Vary` headers.",
    );
  });

  test("notes follow the table after one blank line", () => {
    const lastRow = lines.map((line) => line.startsWith("| ")).lastIndexOf(true);
    expect(lines[lastRow + 1]).toBe("");
    expect(lines[lastRow + 2]?.startsWith("- **Session:** ")).toBe(true);
    expect(rendered.endsWith("\n")).toBe(true);
  });

  test("renders parameters, the SSE request, the other caching kinds and Retry-After", () => {
    const row = (name: string): string => lines.find((line) => line.startsWith(`| ${name} | `)) as string;
    expect(row("Session")).toContain("`X-Pulse-Client` (header, optional): ");
    expect(row("Session")).toContain("| `private, no-store` |");
    expect(row("Live events")).toContain("| `GET` | `/api/events` (SSE) | none |");
    expect(row("Live events")).toContain("| `no-cache` (event stream) |");
    expect(row("Check history")).toContain(
      "`endpoint` (path, required): exact Gatus endpoint name; may contain an encoded slash (`%2F`)<br>`range` (query, optional): `1h`, `6h`, `24h`, `7d`; default: `24h`; no other query key is accepted",
    );
    expect(row("Check history")).toContain("| always 200, no ETag; `private, no-cache` |");
    expect(row("Check history")).toContain("`503` `HISTORY_OVERLOADED`: too many history requests are in progress [Retry-After]");
    expect(row("Estate history")).toContain("`queryId` (path, required): `");
  });

  test("errors are ordered by status, then code, with the bundle codes collapsed", () => {
    const row = lines.find((line) => line.startsWith("| Alert history | ")) as string;
    const codes = [...(row.split(" | ")[7] as string).matchAll(/`(\d{3})` `([A-Z_*]+)`/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(codes).toEqual([
      "400 INVALID_REQUEST", "400 INVALID_REQUEST", "404 QUERY_NOT_FOUND", "404 TARGET_NOT_FOUND",
      "422 QUERY_NOT_APPLICABLE", "422 RANGE_UNSUPPORTED", "500 INTERNAL_ERROR", "502 HISTORY_LIMIT_EXCEEDED",
      "502 SOURCE_UNAVAILABLE", "503 ESTATE_BUNDLE_*", "503 HISTORY_CANCELLED", "503 HISTORY_OVERLOADED",
      "503 MODEL_CHANGED", "504 SOURCE_TIMEOUT",
    ]);
  });

  test("a duplicate label or an operation without fixture groups is SCENARIO_INVALID", () => {
    const first = OPERATIONS[0] as ContractOperation;
    for (const bad of [[first, first], [{ ...first, fixtureGroups: [] }]]) {
      let caught: unknown;
      try {
        renderOperationsTable(bad);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ContractToolError);
      expect((caught as ContractToolError).code).toBe("SCENARIO_INVALID");
      expect((caught as ContractToolError).subject).toBe(first.label);
    }
  });

  test("no response body without exactly [204], and auth none on a non-GET, are SCENARIO_INVALID", () => {
    const first = OPERATIONS[0] as ContractOperation;
    const bad: ContractOperation[] = [
      { ...first, responseRoot: null },
      { ...first, responseRoot: null, success: [200, 204] },
      { ...first, method: "POST" },
      { ...first, method: "DELETE", success: [204], responseRoot: null },
    ];
    for (const op of bad) {
      let caught: unknown;
      try {
        renderOperationsTable([op]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ContractToolError);
      expect((caught as ContractToolError).code).toBe("SCENARIO_INVALID");
      expect((caught as ContractToolError).subject).toBe(first.label);
    }
  });

  test("an authorised non-GET renders its auth, request body and a 204 response", () => {
    const first = OPERATIONS[0] as ContractOperation;
    const op: ContractOperation = {
      ...first,
      label: "DELETE /api/example",
      name: "Example",
      method: "DELETE",
      path: "/api/example",
      auth: "device-credential",
      params: [],
      requestRoot: "SessionPayload",
      success: [204],
      responseRoot: null,
      notes: [],
    };
    const row = renderOperationsTable([op]).split("\n")[2] as string;
    expect(row.startsWith("| Example | `DELETE` | `/api/example` | `Authorization: Bearer <credential>` | none | [`SessionPayload`](#fields-sessionpayload) | 204 |")).toBe(true);
    expect(row.endsWith("| none (204) |")).toBe(true);
  });
});

describe("renderLimitsTable", () => {
  const rendered = renderLimitsTable(CONTRACT_LIMITS);
  const lines = rendered.split("\n");

  test("matches the documented column layout", () => {
    expect(lines.slice(0, 3)).toEqual([
      "| Response | Limit | Maximum | Unit | Over the maximum |",
      "|---|---|---|---|---|",
      "| overview | hosts (`hosts`) | 100 | items | trimmed by the server to the first N in its existing order |",
    ]);
    for (const expected of [
      "| overview | services, summed over hosts (`servicesTotal`) | 300 | items | trimmed by the server to the first N in its existing order |",
      "| overview | recent checks (`recentChecks`) | 2048 | items | trimmed fair-share per endpoint |",
      "| overview | short text (`textBytes`) | 512 | bytes | truncated by the server at the last whole UTF-8 code point; no marker |",
      "| history | series per query (`series`) | 1024 | items | the request fails with `502 HISTORY_LIMIT_EXCEEDED`; never trimmed |",
      "| history | whole body (`bodyBytes`) | 33554432 (32 MiB) | bytes | the request fails with `502 HISTORY_LIMIT_EXCEEDED`; never trimmed |",
      "| current views (whole body) | canonical plain JSON (`plainBytes`) | 5242880 (5 MiB) | bytes | the cycle is not published; the server keeps serving the previous cycle, or `503 NOT_READY` before the first |",
    ]) {
      expect(lines).toContain(expected);
    }
    expect(rendered).toContain("(`messageBytes`) | 1024 (1 KiB) | bytes |");
    expectRectangular(rendered, 5);
  });

  test("has one row per leaf key, in key order, each with a label and a rule", () => {
    const leaves = Object.entries(CONTRACT_LIMITS).flatMap(([group, caps]) => Object.keys(caps).map((key) => [group, key]));
    const rows = lines.filter((line) => line.startsWith("| ")).slice(1);
    expect(rows).toHaveLength(leaves.length);
    rows.forEach((row, i) => {
      const [group, key] = leaves[i] as [string, string];
      expect(row).toContain(`(\`${key}\`) | `);
      const groupCell: Readonly<Record<string, string>> = {
        body: "current views (whole body)",
        request: "requests",
        push: "push payload and registration",
      };
      expect(row.startsWith(`| ${groupCell[group] ?? group} | `)).toBe(true);
      expect(row.endsWith(" |  |")).toBe(false);
    });
    expect(Object.keys(LIMIT_LABELS)).toEqual(Object.keys(CONTRACT_LIMITS));
    expect(Object.keys(OVER_CAP)).toEqual(Object.keys(CONTRACT_LIMITS));
  });

  test("renders the request and push rows with their group cells and units", () => {
    for (const expected of [
      "| requests | request body, every client-originated operation (`bodyBytes`) | 4096 (4 KiB) | bytes | the request fails with `413 PAYLOAD_TOO_LARGE` |",
      "| push payload and registration | push payload (whole notification body) (`payloadBytes`) | 4096 (4 KiB) | bytes | never sent over the limit: title and body are truncated until it fits |",
      "| push payload and registration | notification title (`titleBytes`) | 128 | bytes | truncated by the server at the last whole UTF-8 code point; no marker |",
      "| push payload and registration | notification body (`bodyBytes`) | 512 | bytes | truncated by the server at the last whole UTF-8 code point; no marker |",
      "| push payload and registration | device display name (`displayNameBytes`) | 64 | bytes | the request fails with `400 INVALID_REQUEST` |",
      "| push payload and registration | APNs device token (`apnsTokenMaxChars`) | 200 | characters | the request fails with `400 INVALID_REQUEST` |",
    ]) {
      expect(lines).toContain(expected);
    }
  });
});

describe("renderFieldTables", () => {
  test("renders one row per non-root node with mapped types and fallback groups", () => {
    expect(renderFieldTables(SNAPSHOT, "AlertsPayload", FALLBACKS)).toBe(
      [
        "| Field | Type | Optional | Nullable | Values |",
        "|---|---|---|---|---|",
        "| `alerts` | array | no | no |  |",
        "| `alerts[]` | object | no | no |  |",
        "| `alerts[].endsAt` | string | no | yes |  |",
        "| `alerts[].labels` | map | no | no |  |",
        "| `alerts[].labels{}` | number \\| string | no | no |  |",
        "| `alerts[].note` | string | yes | no |  |",
        "| `alerts[].state` | enum | no | no | `firing`, `silenced` (unknown: see `alert-state`) |",
        "| `formatVersion` | constant | no | no | `2` |",
        "| `generatedAt` | string (pattern) | no | no |  |",
        "| `window` | tuple | no | no |  |",
        "",
      ].join("\n"),
    );
  });

  test("a root absent from the snapshot is SHAPE_UNSUPPORTED_TYPE", () => {
    const empty: ShapeSnapshot = { version: SNAPSHOT.version, roots: {} };
    expect(() => renderFieldTables(empty, "LiveTick")).toThrow(ContractToolError);
    try {
      renderFieldTables(empty, "LiveTick");
    } catch (error) {
      expect((error as ContractToolError).code).toBe("SHAPE_UNSUPPORTED_TYPE");
      expect((error as ContractToolError).subject).toBe("LiveTick");
    }
  });
});

describe("renderEnumFallbacksTable", () => {
  test("sorts by group, unions the members and renders both fallback kinds", () => {
    expect(renderEnumFallbacksTable(FALLBACKS, SNAPSHOT)).toBe(
      [
        "| Group | Fields | Known values | Unknown value |",
        "|---|---|---|---|",
        "| `alert-state` | `AlertsPayload.alerts[].state`<br>`TimelinePayload.targets[].state` | `firing`, `pending`, `silenced` | treat as `firing` |",
        "| `zeta-rule` | `TimelinePayload.targets[].state` | `firing`, `pending` | Hide it \\| entirely. |",
        "",
      ].join("\n"),
    );
  });

  test("a fallback path absent from the snapshot is SHAPE_UNSUPPORTED_TYPE", () => {
    const stale: EnumFallbackEntry = { group: "g", paths: ["AlertsPayload.gone"], fallback: { kind: "as-member", member: "x" } };
    try {
      renderEnumFallbacksTable([stale], SNAPSHOT);
      throw new Error("did not throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ContractToolError);
      expect((error as ContractToolError).code).toBe("SHAPE_UNSUPPORTED_TYPE");
      expect((error as ContractToolError).subject).toBe("AlertsPayload.gone");
    }
  });
});

describe("renderFixturesTable", () => {
  test("renders the summary line, links and expected results", () => {
    expect(renderFixturesTable(INDEX)).toBe(
      [
        "Index format 1, contract 1.0, 3 fixtures.",
        "",
        "| Fixture | Operation | Scenario | Kind | Status | Expect | Expected result |",
        "|---|---|---|---|---|---|---|",
        "| [`fixtures/connect-link/http-url.json`](fixtures/connect-link/http-url.json) | `connect-link` | `http-url` | connect-link | — | reject | rejection `not-https` |",
        "| [`fixtures/handshake/server-too-old-minor.json`](fixtures/handshake/server-too-old-minor.json) | `handshake` | `server-too-old-minor` | handshake | — | accept | outcome `server-too-old` for client `1.1` |",
        "| [`fixtures/overview/typical.json`](fixtures/overview/typical.json) | `GET /api/overview` | `typical` | response | 200 | accept | — |",
        "",
      ].join("\n"),
    );
  });
});

describe("buildGeneratedSections", () => {
  const inputs = { snapshot: SNAPSHOT, index: INDEX, fallbacks: FALLBACKS };

  test("renders every section, deterministically, and feeds renderContractDoc", () => {
    const first = buildGeneratedSections(inputs);
    expect(Object.keys(first).sort()).toEqual([...GENERATED_SECTION_NAMES].sort());
    expect(buildGeneratedSections(inputs)).toEqual(first);
    expect(first.operations).toBe(renderOperationsTable(OPERATIONS));
    expect(first.limits).toBe(renderLimitsTable(CONTRACT_LIMITS));
    expect(first["fields:AlertsPayload"]).toBe(renderFieldTables(SNAPSHOT, "AlertsPayload", FALLBACKS));
    for (const text of Object.values(first)) expect(text.endsWith("\n")).toBe(true);

    const filled = renderContractDoc(CONTRACT_MD, first);
    expect(renderContractDoc(filled, first)).toBe(filled);
    expect(filled).toContain(`${openMarker("limits")}\n| Response | Limit |`);
  });

  test("the live fallback table needs the real snapshot paths", () => {
    expect(() => buildGeneratedSections({ snapshot: SNAPSHOT, index: INDEX })).toThrow(ContractToolError);
    expect(ENUM_FALLBACKS.length).toBeGreaterThan(0);
  });
});

describe("generated sections over the real wire types", () => {
  test("every section renders, is rectangular, and is byte-identical across two runs", async () => {
    const snapshot = await currentShape();
    const empty: FixtureIndex = { formatVersion: 1, contract: snapshot.version, fixtures: [] };
    const first = buildGeneratedSections({ snapshot, index: empty });
    expect(buildGeneratedSections({ snapshot, index: empty })).toEqual(first);
    for (const name of GENERATED_SECTION_NAMES) {
      const header = first[name].split("\n").find((line) => line.startsWith("|")) as string;
      expectRectangular(first[name], unescapedPipes(header) - 1);
    }
    // Every live fallback group has a row, and every enum field names its group.
    for (const entry of ENUM_FALLBACKS) expect(first["enum-fallbacks"]).toContain(`| \`${entry.group}\` | `);
    expect(first["fields:SessionPayload"]).toContain("| `authMode` | enum | no | no | `none`, `proxy-header` (unknown: see `auth-mode`) |");
    expect(first["fields:SessionPayload"]).toContain("| `contract.capabilities[]` | string | no | no |  |");
    expect(first.fixtures.startsWith("Index format 1, contract 1.0, 0 fixtures.\n\n| Fixture |")).toBe(true);
    const filled = renderContractDoc(CONTRACT_MD, first);
    expect(renderContractDoc(filled, first)).toBe(filled);
  }, GENERATION_TIMEOUT);
});

// ── OPERATIONS against the real routes ───────────────────────────────────────────────────────────

function routeReq(path: string, params: Readonly<Record<string, string>>, search = ""): RouteRequest {
  const request = new Request(`http://web:8080${path}${search}`, { method: "GET" });
  return { request, params, routePattern: path, peerIp: null, disableTimeout() {} };
}

type Failure = { readonly ok: false; readonly error: HistoryFailure };

function failingHistory(result: Failure, ranges: string[] = []): HistoryService {
  return {
    query: async (request) => (ranges.push(request.range), result),
    alertIntervals: async (request) => (ranges.push(request.range), result),
    endpointHistory: async (request) => (ranges.push(request.range), result),
    stats: () => ({ active: 0, queued: 0, inFlightKeys: 0, cachedKeys: 0, cachedBytes: 0, waiters: 0 }),
    invalidateModel: () => {},
    close: () => {},
  };
}

function ctxWith(history: HistoryService): ServerContext {
  return {
    estate: null,
    cycle: null,
    history,
    events: {} as ServerContext["events"],
    sources: {} as ServerContext["sources"],
    config: {} as ServerConfig,
    identity: null,
    snapshot: null,
  };
}

const operation = (label: string): ContractOperation => {
  const found = OPERATIONS.find((op) => op.label === label);
  if (found === undefined) throw new Error(`no operation ${label}`);
  return found;
};

const HISTORY_CALLS: readonly { readonly route: RouteDefinition; readonly params: Readonly<Record<string, string>> }[] = [
  { route: historyEstateRoute, params: { queryId: "engine.disk-usage" } },
  { route: historyTargetRoute, params: { drilldownId: "host:web-01", queryId: "estate.liveness" } },
  { route: historyAlertsRoute, params: {} },
  { route: historyChecksRoute, params: { endpoint: "group/name" } },
];

describe("OPERATIONS", () => {
  test("is exactly the contract operation set, frozen", () => {
    expect(OPERATIONS.map((op) => op.label)).toEqual([
      "GET /api/session",
      "GET /api/overview",
      "GET /api/alerts",
      "GET /api/estate",
      "GET /api/timeline",
      "GET /api/history/estate/:queryId",
      "GET /api/history/target/:drilldownId/:queryId",
      "GET /api/history/alerts",
      "GET /api/history/checks/:endpoint",
      "SSE /api/events",
    ]);
    expect(Object.isFrozen(OPERATIONS)).toBe(true);
    expect(Object.isFrozen(OPERATIONS[0])).toBe(true);
    expect(Object.isFrozen(OPERATIONS[0]?.errors)).toBe(true);
    expect(new Set(OPERATIONS.map((op) => op.name)).size).toBe(OPERATIONS.length);
  });

  test("every path is a registered GET route, and non-contract routes are absent", () => {
    const registered = new Map(ROUTES.map((route) => [route.path, route.method]));
    for (const op of OPERATIONS) {
      expect(registered.get(op.path)).toBe("GET");
      expect(op.method).toBe("GET");
      expect(op.label.endsWith(` ${op.path}`)).toBe(true);
      expect(op.fixtureGroups.length).toBeGreaterThan(0);
      expect(op.auth).toBe("none");
      expect(op.requestRoot).toBeNull();
      expect(op.responseRoot).not.toBeNull();
      expect((SHAPE_ROOTS as readonly string[]).includes(op.responseRoot ?? "")).toBe(true);
    }
    const paths = OPERATIONS.map((op) => op.path);
    for (const excluded of ["/api/engine", "/api/proposals", "/api/connect-link", "/healthz", "/metrics"]) {
      expect(registered.has(excluded)).toBe(true);
      expect(paths).not.toContain(excluded);
    }
  });

  test("errors are sorted by status then code, and success statuses ascend", () => {
    for (const op of OPERATIONS) {
      const keys = op.errors.map((e) => `${e.status} ${e.code}`);
      expect(keys).toEqual([...keys].sort());
      expect([...op.success]).toEqual([...op.success].sort((a, b) => a - b));
    }
  });

  test("history error statuses equal what the real routes return for every failure code", async () => {
    const codes = Object.keys(HISTORY_STATUS) as HistoryFailure["code"][];
    expect(codes).toHaveLength(11);
    for (const { route, params } of HISTORY_CALLS) {
      const op = operation(`GET ${route.path}`);
      const historyRows = op.errors.filter((e) => e.body === "ErrorEnvelope" && e.code in HISTORY_STATUS);
      // INVALID_REQUEST appears twice: the router guard and the history query parser.
      expect(historyRows.map((e): string => e.code).sort()).toEqual([...codes, "INVALID_REQUEST"].sort());
      for (const code of codes) {
        const retryAfterSeconds = code === "HISTORY_OVERLOADED" ? 1 : null;
        const result: Failure = { ok: false, error: { code, message: ERROR_MESSAGES[code], retryAfterSeconds } };
        const response = await route.handler(routeReq(route.path, params), ctxWith(failingHistory(result)));
        const rows = op.errors.filter((e) => e.code === code);
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) expect(row.status).toBe(response.status);
        expect(((await response.json()) as { code: string }).code).toBe(code);
        expect(response.headers.has("retry-after")).toBe(rows.some((row) => row.headers?.includes("Retry-After") === true));
      }
    }
  });

  test("the history parser's own rejections match the rows", async () => {
    const neverCalled = failingHistory({ ok: false, error: { code: "SOURCE_TIMEOUT", message: "", retryAfterSeconds: null } });
    const invalid = await (historyAlertsRoute as RouteDefinition).handler(routeReq("/api/history/alerts", {}, "?start=1"), ctxWith(neverCalled));
    expect(invalid.status).toBe(400);
    expect(operation("GET /api/history/alerts").errors.some((e) => e.code === "INVALID_REQUEST" && e.status === 400)).toBe(true);

    const unknown = await (historyEstateRoute as RouteDefinition).handler(
      routeReq("/api/history/estate/:queryId", { queryId: "nope" }),
      ctxWith(neverCalled),
    );
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { code: string }).code).toBe("QUERY_NOT_FOUND");
  });

  test("the checks route with no range asks for the documented default", async () => {
    const ranges: string[] = [];
    const result: Failure = { ok: false, error: { code: "SOURCE_UNAVAILABLE", message: "", retryAfterSeconds: null } };
    await (historyChecksRoute as RouteDefinition).handler(
      routeReq("/api/history/checks/:endpoint", { endpoint: "group/name" }),
      ctxWith(failingHistory(result, ranges)),
    );
    expect(ranges).toEqual(["24h"]);
    expect(CHECKS_DEFAULT_RANGE).toBe("24h");
    const range = operation("GET /api/history/checks/:endpoint").params.find((p) => p.name === "range");
    expect(range?.default).toBe("`24h`");
  });

  test("current views return the documented NOT_READY status before the first cycle", async () => {
    const history = failingHistory({ ok: false, error: { code: "SOURCE_TIMEOUT", message: "", retryAfterSeconds: null } });
    for (const route of [alertsRoute, estateRoute, timelineRoute] as readonly RouteDefinition[]) {
      const response = await route.handler(routeReq(route.path, {}), ctxWith(history));
      const row = operation(`GET ${route.path}`).errors.find((e) => e.code === "NOT_READY");
      expect(row?.status).toBe(response.status);
      expect(((await response.json()) as { code: string }).code).toBe("NOT_READY");
    }
    for (const label of ["GET /api/session", "SSE /api/events", "GET /api/history/alerts"]) {
      expect(operation(label).errors.some((e) => e.code === "NOT_READY")).toBe(false);
    }
  });

  test("the request guard text carries the real request limits", () => {
    expect(MAX_QUERY_BYTES).toBe(2048);
    expect(MAX_PARAM_BYTES).toBe(512);
    for (const op of OPERATIONS) {
      const guard = op.errors.find((e) => e.code === "INVALID_REQUEST" && e.when.startsWith("query string over"));
      expect(guard?.when).toContain(`over ${MAX_QUERY_BYTES} bytes`);
      expect(guard?.when).toContain(`over-${MAX_PARAM_BYTES}-byte`);
    }
  });
});

// ── The committed document ───────────────────────────────────────────────────────────────────────

describe("contract/CONTRACT.md", () => {
  const lines = CONTRACT_MD.split("\n");
  const flat = CONTRACT_MD.replace(/\s+/g, " ");

  test("uses LF line endings and ends with a newline", () => {
    expect(CONTRACT_MD.includes("\r")).toBe(false);
    expect(CONTRACT_MD.endsWith("\n")).toBe(true);
  });

  test("contains every marker pair exactly once, in document order", () => {
    const markers = lines.filter((line) => /^<!-- \/?generated:/.test(line));
    expect(markers).toEqual(GENERATED_SECTION_NAMES.flatMap((name) => [openMarker(name), closeMarker(name)]));
    expect(() => renderContractDoc(CONTRACT_MD, sectionsWith(() => ""))).not.toThrow();
  });

  test("has every section, in order, each with its stable anchor", () => {
    const expected: readonly (readonly [string, string])[] = [
      ["about", "About this contract"],
      ["versioning", "Versioning"],
      ["handshake", "Handshake"],
      ["announcing", "Announcing the client"],
      ["tolerance", "Tolerance rules"],
      ["operations", "Operations"],
      ["fields", "Response fields"],
      ["limits", "Limits"],
      ["enum-fallbacks", "Enum fallbacks"],
      ["caching", "Caching"],
      ["events", "Live events"],
      ["request-limits", "Request limits"],
      ["auth", "Authentication"],
      ["not-in-contract", "Not in the contract"],
      ["connect-link", "Connect link"],
      ["fixtures", "Fixtures"],
      ["extending", "Extending the contract"],
    ];
    expect(lines.filter((line) => line.startsWith("## ")).map((line) => line.slice(3))).toEqual(expected.map(([, title]) => title));
    for (const [anchor, title] of expected) {
      expect(CONTRACT_MD).toContain(`<a id="${anchor}"></a>\n\n## ${title}\n`);
    }
  });

  test("has one anchored H3 and marker pair per response root", () => {
    expect(lines.filter((line) => line.startsWith("### ")).map((line) => line.slice(4))).toEqual([...SHAPE_ROOTS]);
    for (const root of SHAPE_ROOTS) {
      expect(CONTRACT_MD).toContain(
        `<a id="fields-${root.toLowerCase()}"></a>\n\n### ${root}\n\n${openMarker(`fields:${root}`)}\n`,
      );
    }
  });

  test("every in-document link resolves to an anchor", () => {
    const anchors = new Set([...CONTRACT_MD.matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1]));
    const links = [...CONTRACT_MD.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(10);
    for (const link of links) expect(anchors.has(link)).toBe(true);
    for (const op of OPERATIONS) {
      for (const root of [op.requestRoot, op.responseRoot]) {
        if (root !== null) expect(anchors.has(`fields-${root.toLowerCase()}`)).toBe(true);
      }
    }
  });

  test("contains each normative sentence", () => {
    for (const sentence of [
      "This contract is a promise to first-party Pulse clients maintained in this repository. It makes no stability promise to any third-party client.",
      "On `client-too-old` or `server-too-old` a client must stop: show the incompatible state, say which side must be updated, and show no monitoring data.",
      "The web client bundled with the server is always the same build as the server and is exempt from these rules. Its validators stay strict. The rules bind every separately installed client.",
      "An unknown `OverviewAlertSummary.severity` is displayed as the lowest severity and labelled unknown.",
      "`identities.engine` and everything in `observation` except `generation` and `seq` are not part of the contract. A client must ignore them.",
      "A decoder is correct when it gives the result the index records for every fixture.",
      "Error bodies are `ErrorEnvelope` `{code, message, details?}` unless marked `BundleErrorBody`. A client must branch on `code`, never on `message`.",
    ]) {
      expect(flat).toContain(sentence);
    }
  });

  test("contains the five-row decision table", () => {
    for (const row of [
      "| 1 | the session response has no `contract` member | `server-too-old` | server |",
      "| 2 | `server.major > client.major` | `client-too-old` | client |",
      "| 3 | `server.major < client.major` | `server-too-old` | server |",
      "| 4 | `server.minor < client.minMinor` | `server-too-old` | server |",
      "| 5 | otherwise | `compatible` | — |",
    ]) {
      expect(lines).toContain(row);
    }
  });

  test("states the live constants and the connect-link rejections", () => {
    for (const fact of [
      `at most ${MAX_QUERY_BYTES} UTF-8 bytes`,
      `at most ${MAX_PARAM_BYTES} UTF-8 bytes`,
      "pulse://connect?v=1&url=https%3A%2F%2Fpulse.example.com",
      "`wrong-scheme`", "`unsupported-version`", "`missing-url`", "`malformed-url`", "`not-https`",
      "`retry: 10000`", "every 5000 ms", "at most 64 simultaneous streams",
      `\`textBytes\` (${CONTRACT_LIMITS.overview.textBytes})`,
      `\`messageBytes\` (${CONTRACT_LIMITS.overview.messageBytes})`,
    ]) {
      expect(flat).toContain(fact);
    }
  });

  test("references no planning documents and only placeholder hosts", () => {
    expect(CONTRACT_MD).not.toContain("specs/");
    const hosts = [...CONTRACT_MD.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]);
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) expect(host).toBe("pulse.example.com");
  });
});
