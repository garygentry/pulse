// packages/web-data/src/sources/types.ts — common source result/error contracts
// (01-core-definitions.md §3). Concrete source payload types and client signatures
// live in sources/index.ts (§10) and are implemented by items 010–018. Every normal
// client method resolves a SourceResult and never rejects.
//
// ScrapeTargetState (§10) lands here early because the engine wire payload
// (wire/engine.ts, item 007) embeds it in ScrapeJobState.targets. It is the single
// authoritative scrape-target shape shared by CycleSourceRecords (§5), ScrapeJobState
// (§9), and the VictoriaMetrics client's targets() result (§10); item 011 imports it
// rather than redeclaring a competing shape.

/** Stable source-failure categories used by every source client. */
export type SourceErrorKind =
  | "timeout" | "transport" | "upstream-status" | "malformed-json"
  | "invalid-shape" | "incompatible" | "overflow" | "disabled";

export interface SourceError {
  /** Stable failure category. */ readonly kind: SourceErrorKind;
  /** Safe actionable diagnostic, capped at 256 UTF-8 bytes. */ readonly message: string;
  /** Upstream HTTP status when applicable. */ readonly status: number | null;
}

export type SourceResult<T> =
  | {
      /** Success discriminator. */ readonly ok: true;
      /** Complete validated value. */ readonly data: T;
    }
  | {
      /** Failure discriminator. */ readonly ok: false;
      /** Bounded expected failure. */ readonly error: SourceError;
    };

export interface SourceAttempt<T> {
  /** Attempt start in UTC. */ readonly attemptedAt: string;
  /** Complete validated success or failure. */ readonly result: SourceResult<T>;
}

export interface SourceRecord<T> {
  /** Latest attempt, including failure. */ readonly latest: SourceAttempt<T>;
  /** Most recent complete success retained as stale context. */
  readonly lastGood: {
    /** Successful acquisition time in UTC. */ readonly at: string;
    /** Complete previously validated value. */ readonly data: T;
  } | null;
}

/** Injectable network boundary matching the global `fetch` shape. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SourceClientOptions {
  /** Injectable network boundary. */ readonly fetchImpl?: FetchLike;
  /** Per-call timeout; production uses SOURCE_TIMEOUT_MS. */ readonly timeoutMs?: number;
  /** Injectable UTC clock. */ readonly now?: () => Date;
}

/** One VictoriaMetrics scrape-target discovery record (§10); shared by the engine wire. */
export interface ScrapeTargetState {
  /** Bounded job name. */ readonly job: string;
  /** Exact bounded instance label. */ readonly instance: string;
  /** Safe scrape URL without credentials, or null. */ readonly scrapeUrl: string | null;
  /** Current scrape health. */ readonly health: "up" | "down" | "unknown";
  /** Latest scrape time in UTC, or null. */ readonly lastScrapeAt: string | null;
  /** Bounded safe latest error, or null. */ readonly lastError: string | null;
}
