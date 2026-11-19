import type { ContractVersion } from "@pulse/web-data/contract";

/**
 * Structural kind of one field.
 *
 * `scalar-union` is a union of different primitive kinds (for example `string | number | boolean`).
 * Its `members` list the primitive kind names, sorted. Adding or removing a member is breaking.
 */
export type ShapeKind =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "object"
  | "array"
  | "record"
  | "literal-union"
  | "literal"
  | "tuple"
  | "template"
  | "scalar-union";

/** One node in the field-shape snapshot. */
export interface ShapeNode {
  /**
   * Dotted path from the root type name: `[]` for array elements, `{}` for record values, `[n]` for
   * tuple slots, and `(field=value)` for a discriminated-union variant.
   */
  readonly path: string;
  /** Structural kind. */
  readonly kind: ShapeKind;
  /** The member may be absent (`?:`). */
  readonly optional: boolean;
  /** The type includes null. */
  readonly nullable: boolean;
  /**
   * Sorted members for `literal` / `literal-union` (string literals as-is, numbers as decimal
   * strings) and for `scalar-union` (primitive kind names).
   */
  readonly members?: readonly string[];
}

/** Content of `contract/shape/<major>.<minor>.json`. */
export interface ShapeSnapshot {
  /** Version this snapshot freezes. */
  readonly version: ContractVersion;
  /** Root type name → nodes sorted by path. */
  readonly roots: Readonly<Record<string, readonly ShapeNode[]>>;
}

/** Result of classifying the change between two snapshots. */
export type ShapeDiffClass = "none" | "additive" | "breaking";

/** One classified change. */
export interface ShapeChange {
  /** Affected path (the root name for root changes). */
  readonly path: string;
  /** What changed. */
  readonly change:
    | "root-added"
    | "root-removed"
    | "field-added"
    | "field-removed"
    | "kind-changed"
    | "optional-changed"
    | "nullable-changed"
    | "member-added"
    | "member-removed";
  /** Class of this change. */
  readonly class: "additive" | "breaking";
}

/** Full diff result. */
export interface ShapeDiff {
  /** Worst class over all changes (`none` when `changes` is empty). */
  readonly class: ShapeDiffClass;
  /** Changes sorted by path, then change. */
  readonly changes: readonly ShapeChange[];
}

/** The contract root types the extractor walks. All are exported from `@pulse/web-data/wire`. */
export const SHAPE_ROOTS = [
  "SessionPayload",
  "OverviewSnapshotV2",
  "AlertsPayload",
  "EstatePayload",
  "TimelinePayload",
  "HistoryPayload",
  "IntervalHistoryPayload",
  "EndpointHistoryPayload",
  "LiveTick",
  "ErrorEnvelope",
  "BundleErrorBody",
] as const;
