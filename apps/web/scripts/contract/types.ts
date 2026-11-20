import type {
  ClientRequirement,
  CompatibilityOutcome,
  ConnectLinkRejection,
  ContractVersion,
} from "@pulse/web-data/contract";
import type { ApiErrorCode } from "@pulse/web-data/wire";

/** Fixture group: the first directory under `contract/fixtures/`. */
export type FixtureGroup =
  | "session"
  | "overview"
  | "alerts"
  | "estate"
  | "timeline"
  | "history-estate"
  | "history-target"
  | "history-alerts"
  | "history-checks"
  | "events"
  | "errors"
  | "handshake"
  | "connect-link"
  // push (contract 1.1)
  | "push-pairing"
  | "push-device"
  | "push-payload";

/**
 * What a fixture file holds. `request` is a client-originated request body (it may be `expect: "reject"` with a
 * `rejection` naming the error code the server answers). `payload` is a push notification body (always accept).
 */
export type FixtureKind =
  | "response"
  | "error"
  | "event"
  | "stream"
  | "handshake"
  | "connect-link"
  | "request"
  | "payload";

/** Which bundled web validator must accept a fixture, or null when none applies. */
export type WebValidatorId = "overview" | "tick" | null;

/** One fixture in `contract/index.json`. */
export interface FixtureIndexEntry {
  /** Path relative to `contract/`, for example `fixtures/overview/typical.json`. Always forward slashes. */
  readonly path: string;
  /** Group directory. */
  readonly group: FixtureGroup;
  /** Operation, for example `GET /api/overview`, `SSE /api/events` or `connect-link`. */
  readonly operation: string;
  /** Scenario slug, kebab-case, unique within the group. */
  readonly scenario: string;
  /** Content kind. */
  readonly kind: FixtureKind;
  /** HTTP status for response/error kinds; null otherwise. */
  readonly status: number | null;
  /** Whether a conforming client must decode ("accept") or must reject ("reject") this fixture. */
  readonly expect: "accept" | "reject";
  /** Web validator that must accept it, or null (forward-compat, unvalidated operations, non-JSON). */
  readonly webValidator: WebValidatorId;
  /** Handshake fixtures only: the client requirement under test. */
  readonly client?: ClientRequirement;
  /** Handshake fixtures only: the expected compatibility decision. */
  readonly expectedOutcome?: CompatibilityOutcome;
  /**
   * Rejecting fixtures only. For `connect-link`: the `ConnectLinkRejection`. For `request`: the `ApiErrorCode` the
   * server answers (always `INVALID_REQUEST` in 1.1).
   */
  readonly rejection?: ConnectLinkRejection | ApiErrorCode;
}

/** Content of `contract/index.json`. */
export interface FixtureIndex {
  /** Index format version; bumped only if this structure changes incompatibly. */
  readonly formatVersion: 1;
  /** The contract version at generation. */
  readonly contract: ContractVersion;
  /** Entries sorted by `path` (code-unit order). */
  readonly fixtures: readonly FixtureIndexEntry[];
}

/** Body of a connect-link fixture file. */
export interface ConnectLinkFixture {
  /** The link under test. */
  readonly link: string;
  /** Expected verdict. */
  readonly expect: "accept" | "reject";
  /** Expected normalised base when accepted. */
  readonly baseUrl?: string;
  /** Expected rejection when rejected. */
  readonly rejection?: ConnectLinkRejection;
}

/** Body of a handshake fixture file. */
export interface HandshakeFixture {
  /** The client requirement. */
  readonly client: ClientRequirement;
  /** The full session response the server sends, or a pre-contract one with no `contract` member. */
  readonly session: unknown;
  /** Expected outcome. */
  readonly expectedOutcome: CompatibilityOutcome;
}

/** One file the generator emits. */
export interface GeneratedFile {
  /** Repo-relative path, forward slashes, under `contract/`. */
  readonly path: string;
  /** Exact bytes to write. */
  readonly bytes: Uint8Array;
}

/**
 * A scenario builder's output for one fixture, discriminated on `entry.kind`. The path is derived
 * from the group, the scenario and the extension.
 */
export type ScenarioFixture =
  | {
      /** Index metadata for a JSON fixture. */
      readonly entry: Omit<FixtureIndexEntry, "path"> & { readonly kind: Exclude<FixtureKind, "stream"> };
      /** JSON value, serialised canonically. */
      readonly body: unknown;
    }
  | {
      /** Index metadata for an SSE transcript. */
      readonly entry: Omit<FixtureIndexEntry, "path"> & { readonly kind: "stream" };
      /** Transcript text, written as-is. */
      readonly body: { readonly sse: string };
    };
