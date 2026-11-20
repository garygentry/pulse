// The generated sections of contract/CONTRACT.md: the marker grammar, the rewrite that replaces only the text
// between markers, and the renderers that turn typed data into markdown tables.

import { CONTRACT_LIMITS, ENUM_FALLBACKS } from "@pulse/web-data/contract";
import type { ContractLimits, EnumFallbackEntry } from "@pulse/web-data/contract";

import { ContractToolError } from "./errors.js";
import { OPERATIONS, compareOperationErrors } from "./operations.js";
import type {
  ContractAuth,
  ContractCaching,
  ContractOperation,
  ContractOperationError,
  ContractParam,
} from "./operations.js";
import { SHAPE_ROOTS } from "./shape-types.js";
import type { ShapeKind, ShapeNode, ShapeSnapshot } from "./shape-types.js";
import type { FixtureIndex, FixtureIndexEntry } from "./types.js";

/** One contract root type name. */
type ShapeRootName = (typeof SHAPE_ROOTS)[number];

/** Every generated section in CONTRACT.md. There is one `fields:` section per SHAPE_ROOTS member. */
export type GeneratedSectionName =
  | "operations"
  | `fields:${ShapeRootName}`
  | "limits"
  | "enum-fallbacks"
  | "fixtures";

/** All section names in document order. */
export const GENERATED_SECTION_NAMES: readonly GeneratedSectionName[] = Object.freeze([
  "operations",
  ...SHAPE_ROOTS.map((r) => `fields:${r}` as const),
  "limits",
  "enum-fallbacks",
  "fixtures",
]);

/** Repo-relative path of the document, used as the error subject. */
export const CONTRACT_DOC_PATH = "contract/CONTRACT.md";

const MARKER_LINE = /^<!-- (\/?)generated:([A-Za-z0-9:-]+) -->$/;

/** The open marker line of a section. */
export function openMarker(name: string): string {
  return `<!-- generated:${name} -->`;
}

/** The close marker line of a section. */
export function closeMarker(name: string): string {
  return `<!-- /generated:${name} -->`;
}

function markerError(message: string): ContractToolError {
  return new ContractToolError("MARKER_MISSING", CONTRACT_DOC_PATH, message);
}

/**
 * Replace the body of every generated section in CONTRACT.md, leaving all prose byte-identical.
 *
 * For each pair, the output is the open line, the section text with trailing newlines trimmed, and the close
 * line. A section that renders empty yields the open line directly followed by the close line. Everything
 * outside the pairs is copied unchanged. The function is pure and idempotent.
 *
 * @param current - Current CONTRACT.md text with `\n` line endings
 * @param sections - Rendered markdown for every generated section
 * @returns The rewritten document text
 * @throws {ContractToolError} code MARKER_MISSING when a pair is missing, duplicated, out of order, nested or
 *   has an unknown name, or when the text contains `\r`. Nothing is rewritten on failure.
 */
export function renderContractDoc(
  current: string,
  sections: Readonly<Record<GeneratedSectionName, string>>,
): string {
  const lines = current.split("\n");
  const known = new Set<string>(GENERATED_SECTION_NAMES);
  const opens = new Map<string, number>();
  const closes = new Map<string, number>();
  let openName: string | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const lineNo = i + 1;
    if (line.includes("\r")) throw markerError(`CR line ending at line ${lineNo}; the document must use LF only`);
    const match = MARKER_LINE.exec(line);
    if (match === null) continue;
    const isClose = match[1] === "/";
    const name = match[2] as string;
    const marker = isClose ? closeMarker(name) : openMarker(name);
    if (!known.has(name)) throw markerError(`unknown name: marker ${marker} at line ${lineNo}`);
    if (isClose) {
      if (closes.has(name)) throw markerError(`duplicate marker ${marker} at line ${lineNo}`);
      if (!opens.has(name)) throw markerError(`out of order: marker ${marker} at line ${lineNo} comes before its open marker`);
      if (openName !== name) throw markerError(`nested markers: ${marker} at line ${lineNo} closes inside another section`);
      closes.set(name, i);
      openName = null;
    } else {
      if (opens.has(name)) throw markerError(`duplicate marker ${marker} at line ${lineNo}`);
      if (openName !== null) {
        throw markerError(`nested markers: ${marker} at line ${lineNo} opens inside section ${openName}`);
      }
      opens.set(name, i);
      openName = name;
    }
  }

  for (const name of GENERATED_SECTION_NAMES) {
    const open = opens.get(name);
    if (open === undefined) throw markerError(`missing marker ${openMarker(name)}`);
    if (!closes.has(name)) throw markerError(`missing marker ${closeMarker(name)} for the section opened at line ${open + 1}`);
  }

  const byOpenLine = new Map<number, GeneratedSectionName>();
  for (const name of GENERATED_SECTION_NAMES) byOpenLine.set(opens.get(name) as number, name);

  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const name = byOpenLine.get(i);
    if (name === undefined) {
      out.push(lines[i] as string);
      continue;
    }
    out.push(lines[i] as string);
    const body = sections[name].replace(/\n+$/, "");
    if (body !== "") out.push(body);
    i = closes.get(name) as number;
    out.push(lines[i] as string);
  }
  return out.join("\n");
}

// ── Shared cell helpers ──────────────────────────────────────────────────────────────────────────

/** Escape one table cell: backslash and pipe are escaped, a newline becomes a space. */
export function cell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Wrap a code-like value in backticks. A backtick inside the value becomes an apostrophe. */
function code(value: string | number): string {
  return `\`${String(value).replace(/`/g, "'")}\``;
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.map(cell).join(" | ")} |\n`;
  return line(header) + `|${header.map(() => "---").join("|")}|\n` + rows.map(line).join("");
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ── Operations ───────────────────────────────────────────────────────────────────────────────────

function renderParam(param: ContractParam): string {
  const values =
    param.values.kind === "enum" ? param.values.values.map(code).join(", ") : param.values.description;
  let text = `${code(param.name)} (${param.in}, ${param.required ? "required" : "optional"}): ${values}`;
  if (param.default !== undefined) text += `; default: ${param.default}`;
  if (param.note !== undefined) text += `; ${param.note}`;
  return text;
}

function renderErrors(errors: readonly ContractOperationError[]): string {
  // The six bundle codes collapse to one entry that sorts by the collapsed code.
  type Entry = { readonly status: number; readonly code: string; readonly text: string };
  const entries: Entry[] = [];
  let bundleSeen = false;
  for (const error of [...errors].sort(compareOperationErrors)) {
    if (error.body === "BundleErrorBody") {
      if (bundleSeen) continue;
      bundleSeen = true;
      entries.push({
        status: error.status,
        code: "ESTATE_BUNDLE_*",
        text: `${code(error.status)} ${code("ESTATE_BUNDLE_*")} (BundleErrorBody): ${error.when}`,
      });
      continue;
    }
    const headers = error.headers !== undefined && error.headers.length > 0 ? ` [${error.headers.join(", ")}]` : "";
    entries.push({
      status: error.status,
      code: error.code,
      text: `${code(error.status)} ${code(error.code)}: ${error.when}${headers}`,
    });
  }
  entries.sort((a, b) => (a.status !== b.status ? a.status - b.status : byCodeUnit(a.code, b.code)));
  return entries.length === 0 ? "none" : entries.map((e) => e.text).join("<br>");
}

function renderCaching(caching: ContractCaching): string {
  switch (caching.kind) {
    case "conditional":
      return `ETag + If-None-Match → 304; ${code(caching.cacheControl)}; Vary: ${caching.vary}`;
    case "always-full":
      return `always 200, no ETag; ${code(caching.cacheControl)}`;
    case "no-store":
      return code(caching.cacheControl);
    case "stream":
      return `${code(caching.cacheControl)} (event stream)`;
  }
}

/** Auth cell text. */
const AUTH_CELL: Readonly<Record<ContractAuth, string>> = {
  none: "none",
  "pairing-token": "pairing token (body `token`)",
  "device-credential": "`Authorization: Bearer <credential>`",
};

/** A backticked root name linking to its field table. */
const rootLink = (root: ShapeRootName): string => `[${code(root)}](#fields-${root.toLowerCase()})`;

/**
 * Render the operations table.
 * Columns: Operation | Method | Path | Auth | Parameters | Request body | Success | Errors | Caching | Response.
 * Rows follow the input order. Each operation's notes follow the table as `- **<name>:** note` lines.
 *
 * @throws {ContractToolError} code SCENARIO_INVALID (subject = label) when two operations share a label, an
 *   operation has no fixture groups, an operation without a response body does not succeed with exactly 204, or
 *   an operation needing no authorisation is not a GET
 */
export function renderOperationsTable(operations: readonly ContractOperation[]): string {
  const labels = new Set<string>();
  for (const op of operations) {
    if (labels.has(op.label)) {
      throw new ContractToolError("SCENARIO_INVALID", op.label, `duplicate operation label ${op.label}`);
    }
    labels.add(op.label);
    if (op.fixtureGroups.length === 0) {
      throw new ContractToolError("SCENARIO_INVALID", op.label, `operation ${op.label} has no fixture groups`);
    }
    if (op.responseRoot === null && !(op.success.length === 1 && op.success[0] === 204)) {
      throw new ContractToolError(
        "SCENARIO_INVALID",
        op.label,
        `operation ${op.label} has no response body but its success statuses are not exactly [204]`,
      );
    }
    if (op.auth === "none" && op.method !== "GET") {
      throw new ContractToolError(
        "SCENARIO_INVALID",
        op.label,
        `operation ${op.label} needs no authorisation but is a ${op.method}, not a GET`,
      );
    }
  }
  const rows = operations.map((op) => [
    op.name,
    code(op.method),
    op.label.startsWith("SSE ") ? `${code(op.path)} (SSE)` : code(op.path),
    AUTH_CELL[op.auth],
    op.params.length === 0 ? "none" : op.params.map(renderParam).join("<br>"),
    op.requestRoot === null ? "none" : rootLink(op.requestRoot),
    op.success.join(", "),
    renderErrors(op.errors),
    renderCaching(op.caching),
    op.responseRoot === null ? "none (204)" : rootLink(op.responseRoot),
  ]);
  const header = [
    "Operation",
    "Method",
    "Path",
    "Auth",
    "Parameters",
    "Request body",
    "Success",
    "Errors",
    "Caching",
    "Response",
  ];
  let out = table(header, rows);
  const notes = operations.flatMap((op) => (op.notes ?? []).map((note) => `- **${op.name}:** ${note}\n`));
  if (notes.length > 0) out += `\n${notes.join("")}`;
  return out;
}

// ── Fields ───────────────────────────────────────────────────────────────────────────────────────

const KIND_LABEL: Readonly<Record<Exclude<ShapeKind, "scalar-union">, string>> = {
  string: "string",
  number: "number",
  boolean: "boolean",
  null: "null",
  object: "object",
  array: "array",
  record: "map",
  tuple: "tuple",
  template: "string (pattern)",
  literal: "constant",
  "literal-union": "enum",
};

function fieldType(node: ShapeNode): string {
  if (node.kind === "scalar-union") return (node.members ?? []).join(" | ");
  return KIND_LABEL[node.kind];
}

/**
 * Render one response type's field table.
 * Columns: Field | Type | Optional | Nullable | Values. The root node itself is skipped and rows follow the
 * snapshot's node order.
 *
 * @throws {ContractToolError} code SHAPE_UNSUPPORTED_TYPE (subject = root) when `root` is not in the snapshot
 */
export function renderFieldTables(
  snapshot: ShapeSnapshot,
  root: ShapeRootName,
  fallbacks: readonly EnumFallbackEntry[] = ENUM_FALLBACKS,
): string {
  const nodes = Object.hasOwn(snapshot.roots, root) ? snapshot.roots[root] : undefined;
  if (nodes === undefined) {
    throw new ContractToolError("SHAPE_UNSUPPORTED_TYPE", root, `root ${root} is not in the shape snapshot`);
  }
  const groupByPath = new Map<string, string>();
  for (const entry of fallbacks) for (const path of entry.paths) groupByPath.set(path, entry.group);

  const rows: string[][] = [];
  for (const node of nodes) {
    if (node.path === root) continue;
    let field = node.path.startsWith(root) ? node.path.slice(root.length) : node.path;
    if (field.startsWith(".")) field = field.slice(1);
    let values = "";
    if (node.kind === "literal" || node.kind === "literal-union") {
      values = (node.members ?? []).map(code).join(", ");
      const group = groupByPath.get(node.path);
      if (group !== undefined) values += ` (unknown: see ${code(group)})`;
    }
    rows.push([code(field), fieldType(node), node.optional ? "yes" : "no", node.nullable ? "yes" : "no", values]);
  }
  return table(["Field", "Type", "Optional", "Nullable", "Values"], rows);
}

// ── Limits ───────────────────────────────────────────────────────────────────────────────────────

type LimitText = { readonly [G in keyof ContractLimits]: { readonly [K in keyof ContractLimits[G]]: string } };

const TRIMMED = "trimmed by the server to the first N in its existing order";
const TRUNCATED = "truncated by the server at the last whole UTF-8 code point; no marker";
const REJECTED = "the request fails with `502 HISTORY_LIMIT_EXCEEDED`; never trimmed";
const NOT_PUBLISHED =
  "the cycle is not published; the server keeps serving the previous cycle, or `503 NOT_READY` before the first";

/** Human label for every limit. A key added to CONTRACT_LIMITS without a label fails typecheck. */
export const LIMIT_LABELS = {
  overview: {
    hosts: "hosts",
    servicesTotal: "services, summed over hosts",
    alerts: "alerts, top-level and per host or service",
    signals: "live signals",
    recentChecks: "recent checks",
    targetChecks: "checks per target",
    hostAddresses: "addresses per host",
    engineProblems: "engine summary problems",
    textBytes: "short text",
    messageBytes: "long text (summary, rationale, URL)",
  },
  alerts: { alerts: "active alerts", rules: "rule states", silences: "active silences" },
  estate: {
    liveTargets: "live targets",
    findings: "findings",
    declaredVersusScraped: "declared-versus-scraped rows",
  },
  timeline: { targets: "targets", domains: "domains", checkEndpoints: "check-history endpoints" },
  history: {
    series: "series per query",
    pointsPerSeries: "points per series",
    labels: "labels per series",
    labelKeyBytes: "label key",
    labelValueBytes: "label value",
    lanes: "lanes per alert-interval result",
    intervalsPerLane: "intervals per lane",
    endpointResults: "endpoint results",
    incidents: "endpoint incidents",
    bodyBytes: "whole body",
  },
  body: { plainBytes: "canonical plain JSON", gzipBytes: "gzip" },
  request: { bodyBytes: "request body, every client-originated operation" },
  push: {
    payloadBytes: "push payload (whole notification body)",
    titleBytes: "notification title",
    bodyBytes: "notification body",
    displayNameBytes: "device display name",
    apnsTokenMaxChars: "APNs device token",
  },
} as const satisfies LimitText;

/** What happens above each maximum. A key added to CONTRACT_LIMITS without a rule fails typecheck. */
export const OVER_CAP = {
  overview: {
    hosts: TRIMMED,
    servicesTotal: TRIMMED,
    alerts: TRIMMED,
    signals: TRIMMED,
    recentChecks: "trimmed fair-share per endpoint",
    targetChecks: TRIMMED,
    hostAddresses: TRIMMED,
    engineProblems: TRIMMED,
    textBytes: TRUNCATED,
    messageBytes: TRUNCATED,
  },
  alerts: { alerts: TRIMMED, rules: TRIMMED, silences: TRIMMED },
  estate: { liveTargets: TRIMMED, findings: TRIMMED, declaredVersusScraped: TRIMMED },
  timeline: { targets: TRIMMED, domains: TRIMMED, checkEndpoints: TRIMMED },
  history: {
    series: REJECTED,
    pointsPerSeries: REJECTED,
    labels: REJECTED,
    labelKeyBytes: REJECTED,
    labelValueBytes: REJECTED,
    lanes: REJECTED,
    intervalsPerLane: REJECTED,
    endpointResults: REJECTED,
    incidents: REJECTED,
    bodyBytes: REJECTED,
  },
  body: { plainBytes: NOT_PUBLISHED, gzipBytes: NOT_PUBLISHED },
  request: { bodyBytes: "the request fails with `413 PAYLOAD_TOO_LARGE`" },
  push: {
    payloadBytes: "never sent over the limit: title and body are truncated until it fits",
    titleBytes: TRUNCATED,
    bodyBytes: TRUNCATED,
    displayNameBytes: "the request fails with `400 INVALID_REQUEST`",
    apnsTokenMaxChars: "the request fails with `400 INVALID_REQUEST`",
  },
} as const satisfies LimitText;

const MIB = 1024 * 1024;

/** Display name of a limits group in the first table column; groups not listed render their raw key. */
const GROUP_CELL: Readonly<Record<string, string>> = Object.freeze({
  body: "current views (whole body)",
  request: "requests",
  push: "push payload and registration",
});

function unitCell(key: string): string {
  if (key.endsWith("Bytes")) return "bytes";
  if (key.endsWith("Chars")) return "characters";
  return "items";
}

function maximumCell(value: number, isBytes: boolean): string {
  if (isBytes && value >= MIB && value % MIB === 0) return `${value} (${value / MIB} MiB)`;
  if (isBytes && value >= 1024 && value % 1024 === 0) return `${value} (${value / 1024} KiB)`;
  return String(value);
}

/**
 * Render the limits table.
 * Columns: Response | Limit | Maximum | Unit | Over the maximum. One row per leaf key, in object key order.
 */
export function renderLimitsTable(limits: ContractLimits = CONTRACT_LIMITS): string {
  const rows: string[][] = [];
  const labels: Readonly<Record<string, Readonly<Record<string, string>>>> = LIMIT_LABELS;
  const rules: Readonly<Record<string, Readonly<Record<string, string>>>> = OVER_CAP;
  for (const [group, caps] of Object.entries(limits) as [string, Readonly<Record<string, number>>][]) {
    for (const [key, value] of Object.entries(caps)) {
      const isBytes = key.endsWith("Bytes");
      rows.push([
        GROUP_CELL[group] ?? group,
        `${labels[group]?.[key] ?? key} (${code(key)})`,
        maximumCell(value, isBytes),
        unitCell(key),
        rules[group]?.[key] ?? "",
      ]);
    }
  }
  return table(["Response", "Limit", "Maximum", "Unit", "Over the maximum"], rows);
}

// ── Enum fallbacks ───────────────────────────────────────────────────────────────────────────────

/**
 * Render the enum-fallback table.
 * Columns: Group | Fields | Known values | Unknown value. Rows are sorted by group.
 *
 * @throws {ContractToolError} code SHAPE_UNSUPPORTED_TYPE (subject = path) when an entry path is absent from
 *   the snapshot
 */
export function renderEnumFallbacksTable(
  fallbacks: readonly EnumFallbackEntry[],
  snapshot: ShapeSnapshot,
): string {
  const nodes = new Map<string, ShapeNode>();
  for (const list of Object.values(snapshot.roots)) for (const node of list) nodes.set(node.path, node);

  const rows = [...fallbacks]
    .sort((a, b) => byCodeUnit(a.group, b.group))
    .map((entry) => {
      const members = new Set<string>();
      for (const path of entry.paths) {
        const node = nodes.get(path);
        if (node === undefined) {
          throw new ContractToolError(
            "SHAPE_UNSUPPORTED_TYPE",
            path,
            `enum fallback group ${entry.group} names ${path}, which is not in the shape snapshot`,
          );
        }
        for (const member of node.members ?? []) members.add(member);
      }
      return [
        code(entry.group),
        entry.paths.map(code).join("<br>"),
        [...members].sort(byCodeUnit).map(code).join(", "),
        entry.fallback.kind === "as-member" ? `treat as ${code(entry.fallback.member)}` : entry.fallback.rule,
      ];
    });
  return table(["Group", "Fields", "Known values", "Unknown value"], rows);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

function expectedResult(entry: FixtureIndexEntry): string {
  if (entry.expectedOutcome !== undefined && entry.client !== undefined) {
    return `outcome ${code(entry.expectedOutcome)} for client ${code(`${entry.client.major}.${entry.client.minMinor}`)}`;
  }
  if (entry.rejection !== undefined) return `rejection ${code(entry.rejection)}`;
  return "—";
}

/**
 * Render the fixture table from the fixture index.
 * Columns: Fixture | Operation | Scenario | Kind | Status | Expect | Expected result. Rows follow index order,
 * after one summary line.
 */
export function renderFixturesTable(index: FixtureIndex): string {
  const rows = index.fixtures.map((entry) => [
    `[${code(entry.path)}](${entry.path})`,
    code(entry.operation),
    code(entry.scenario),
    entry.kind,
    entry.status === null ? "—" : String(entry.status),
    entry.expect,
    expectedResult(entry),
  ]);
  const summary = `Index format ${index.formatVersion}, contract ${index.contract.major}.${index.contract.minor}, ${index.fixtures.length} fixtures.\n`;
  return `${summary}\n${table(["Fixture", "Operation", "Scenario", "Kind", "Status", "Expect", "Expected result"], rows)}`;
}

// ── All sections ─────────────────────────────────────────────────────────────────────────────────

/** Inputs for rendering all sections. Every field except the first two defaults to the live constant. */
export interface GeneratedSectionInputs {
  /** The current extracted shape. */
  readonly snapshot: ShapeSnapshot;
  /** The fixture index the generator is about to write. */
  readonly index: FixtureIndex;
  /** Defaults to OPERATIONS. */
  readonly operations?: readonly ContractOperation[];
  /** Defaults to CONTRACT_LIMITS. */
  readonly limits?: ContractLimits;
  /** Defaults to ENUM_FALLBACKS. */
  readonly fallbacks?: readonly EnumFallbackEntry[];
}

/**
 * Render every generated section.
 *
 * @throws {ContractToolError} propagated from the renderers
 */
export function buildGeneratedSections(inputs: GeneratedSectionInputs): Record<GeneratedSectionName, string> {
  const fallbacks = inputs.fallbacks ?? ENUM_FALLBACKS;
  const sections = {} as Record<GeneratedSectionName, string>;
  sections.operations = renderOperationsTable(inputs.operations ?? OPERATIONS);
  for (const root of SHAPE_ROOTS) sections[`fields:${root}`] = renderFieldTables(inputs.snapshot, root, fallbacks);
  sections.limits = renderLimitsTable(inputs.limits ?? CONTRACT_LIMITS);
  sections["enum-fallbacks"] = renderEnumFallbacksTable(fallbacks, inputs.snapshot);
  sections.fixtures = renderFixturesTable(inputs.index);
  return sections;
}
