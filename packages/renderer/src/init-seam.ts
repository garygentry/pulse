// packages/renderer/src/init-seam.ts   (barrel-exported per 01 §3; consumed by apps/cli init)

/**
 * A declarative guidance pack (REQ-INIT-02). `agent-kit` builds one at release time; it is
 * bundled into the compiled binary and applied by `init` AFTER the base scaffold. With no
 * pack present, `init` still emits the base scaffold and succeeds.
 */
export interface GuidancePack {
  /** Stable pack id, e.g. `"agent-kit"`. */
  id: string;
  /** Files to lay down; every entry is create-only (non-destructive, REQ-INIT-03). */
  files: GuidancePackFile[];
}

/** One file a `GuidancePack` lays into the consumer repo. */
export interface GuidancePackFile {
  /** Path inside the pack's bundled template dir (the source of the content). */
  source: string;
  /** Destination path in the consumer repo, relative to its root. */
  target: string;
  /**
   * Non-destructive policy. `"create-only"` — never overwrite an existing target; a
   * collision is reported via `InitData.wouldClobber` (exit 1) unless `--force`. This is
   * the only policy in v1, so guidance can never stomp a consumer's edits.
   */
  merge: "create-only";
}
