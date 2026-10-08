/** Semantic-invariant detectors (04-validation-and-normalization.md §3). Each is a pure
 *  detector: it reads `merged` defensively, appends agent-actionable findings to the shared
 *  one-pass collector, runs to completion, and never short-circuits or throws on config
 *  content (REQ-VAL-02, REQ-VAL-06). No code path reads env/1Password/FS (REQ-SECR-03). */

import type { Severity, FindingCode } from "../findings/index.js";
import { FINDING_CODES } from "../findings/codes.js";
import type { FindingCollector } from "../findings/collect.js";
import type { ProvenanceIndex } from "../loader/index.js";
import { ENV_REF_RE, OP_REF_RE } from "../schema/secret-ref.js";
import { COLLECTION_CLASSES } from "../schema/collection-class.js";
import type { MergedInventory } from "./index.js";

/**
 * Build and add one finding, citing the snake_case path and the file resolved from
 * provenance (findings carry no line/col — those live on Provenance, 00 §3.8).
 */
function pushFinding(
  collector: FindingCollector,
  prov: ProvenanceIndex,
  path: string,
  severity: Severity,
  code: FindingCode,
  message: string,
  fix: string,
): void {
  const p = prov.lookup(path);
  collector.add({ severity, code, file: p.file, path: p.path, message, fix });
}

// ── §3.5 Required, IANA-parseable timezone (REQ-META-02, CON-06) ─────────────

/** Deterministic IANA-validity check: construction throws RangeError for an unknown zone.
 *  Fixed locale + no output read ⇒ locale-insensitive and stable (REQ-DET-01). */
function isValidIanaTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false; // RangeError: invalid time zone
  }
}

/** REQ-META-02: timezone is required and must be IANA-parseable. */
export function checkTimezone(
  merged: MergedInventory,
  prov: ProvenanceIndex,
  collector: FindingCollector,
): void {
  const tz = merged.estate?.timezone;
  if (tz === undefined || tz === null || tz === "") {
    pushFinding(
      collector,
      prov,
      `estate.timezone`,
      "error",
      FINDING_CODES.MISSING_TIMEZONE,
      `Estate metadata has no timezone.`,
      `Add "timezone:" with an IANA zone, e.g. "America/Chicago". It is the source of truth for quiet-hours and digests (REQ-META-02, CON-06).`,
    );
    return;
  }
  if (typeof tz !== "string" || !isValidIanaTimeZone(tz)) {
    pushFinding(
      collector,
      prov,
      `estate.timezone`,
      "error",
      FINDING_CODES.INVALID_TIMEZONE,
      `Estate timezone "${String(tz)}" is not a valid IANA time zone.`,
      `Use a canonical IANA zone name such as "America/Chicago" or "UTC".`,
    );
  }
}

// ── §3.1 Mandatory suppression rationale (REQ-SUPP-02, CON-03) ───────────────

/** A rationale is present iff it is a non-empty, non-whitespace string. */
function hasRationale(r: unknown): r is string {
  return typeof r === "string" && r.trim().length > 0;
}

/** REQ-SUPP-02: every suppression carries a rationale. */
export function checkSuppressionRationales(
  merged: MergedInventory,
  prov: ProvenanceIndex,
  collector: FindingCollector,
): void {
  (merged.suppressions ?? []).forEach((s, i) => {
    if (!hasRationale(s?.rationale)) {
      pushFinding(
        collector,
        prov,
        `suppressions[${i}].rationale`,
        "error",
        FINDING_CODES.MISSING_RATIONALE,
        `Suppression of "${s?.target ?? "(unnamed target)"}" (class "${s?.class ?? "?"}") has no rationale.`,
        `Add a "rationale:" explaining why this is deliberately silenced — a silence without a reason is a validation error (charter §invariant 6).`,
      );
    }
  });

  (merged.hosts ?? []).forEach((h, i) => {
    // An `excluded` host carries its suppression mark under `suppressed` (02 §4.2 host union;
    // 00 §3.2 excluded arm = `{ collectionClass:"excluded"; suppressed: SuppressionMark }`).
    const mark = (h as { suppressed?: { rationale?: unknown } }).suppressed;
    if (h?.collection_class === "excluded" && !hasRationale(mark?.rationale)) {
      pushFinding(
        collector,
        prov,
        `hosts[${i}].suppressed.rationale`,
        "error",
        FINDING_CODES.MISSING_RATIONALE,
        `Excluded host "${h?.name ?? "(unnamed)"}" has no suppression rationale.`,
        `Add "suppressed.rationale:" on the excluded host explaining why it is intentionally unmonitored; excluded targets stay in the model as deliberate (REQ-SUPP-03).`,
      );
    }
  });

}

// ── §3.2 Secret literal in a credential slot (REQ-SECR-01, REQ-SEC-02) ───────

/** True iff the value is one of the two accepted reference forms (00 §2). */
function isReference(v: unknown): boolean {
  return typeof v === "string" && (ENV_REF_RE.test(v) || OP_REF_RE.test(v));
}

const SECRET_FIX =
  `Replace the literal with a reference: "${"${ENV_VAR}"}" (env substitution) or ` +
  `"op://vault/item/field" (1Password). core-contract never resolves the value; it only ` +
  `validates the reference syntax (REQ-SECR-03).`;

/** REQ-SECR-01 / REQ-SEC-02: no bare literal in a reference-only slot. */
export function checkSecretLiterals(
  merged: MergedInventory,
  prov: ProvenanceIndex,
  collector: FindingCollector,
): void {
  (merged.channels ?? []).forEach((c, i) => {
    if (!isReference(c?.credential)) {
      pushFinding(
        collector,
        prov,
        `channels[${i}].credential`,
        "error",
        FINDING_CODES.SECRET_LITERAL,
        `Channel "${c?.name ?? "(unnamed)"}" credential is not a secret reference.`,
        SECRET_FIX,
      );
    }
  });

  (merged.hosts ?? []).forEach((h, i) => {
    const cc = h?.collection_class;
    const credential = (h as { credential?: unknown }).credential;
    // hypervisor-api always carries a credential (required by its arm). nas-api's credential
    // is optional (issue #4) — only a *present* one must be a reference; an absent one is the
    // node_exporter-direct default, not a violation.
    const requiresRef = cc === "hypervisor-api" || (cc === "nas-api" && credential !== undefined);
    if (requiresRef && !isReference(credential)) {
      pushFinding(
        collector,
        prov,
        `hosts[${i}].credential`,
        "error",
        FINDING_CODES.SECRET_LITERAL,
        `Host "${h?.name ?? "(unnamed)"}" (${cc}) API credential is not a secret reference.`,
        SECRET_FIX,
      );
    }
  });

  (merged.services ?? []).forEach((s, i) => {
    const credential = s?.deep_health?.credential;
    if (credential !== undefined && !isReference(credential)) {
      pushFinding(
        collector,
        prov,
        `services[${i}].deep_health.credential`,
        "error",
        FINDING_CODES.SECRET_LITERAL,
        `Service "${s?.name ?? "(unnamed)"}" deep-health credential is not a secret reference.`,
        SECRET_FIX,
      );
    }
  });

  // Command-signal credentials (issue #3) — only a *present* credential must be a reference.
  (merged.hosts ?? []).forEach((h, i) => {
    const signals = (h as { command_signals?: unknown }).command_signals;
    if (!Array.isArray(signals)) return;
    signals.forEach((cs, j) => {
      const credential = (cs as { credential?: unknown })?.credential;
      if (credential !== undefined && !isReference(credential)) {
        pushFinding(
          collector,
          prov,
          `hosts[${i}].command_signals[${j}].credential`,
          "error",
          FINDING_CODES.SECRET_LITERAL,
          `Command signal "${(cs as { name?: unknown })?.name ?? "(unnamed)"}" on host "${h?.name ?? "(unnamed)"}" has a credential that is not a secret reference.`,
          SECRET_FIX,
        );
      }
    });
  });
}

// ── §3.4 Exactly-one-collection-class backstop (REQ-HOST-02, CON-07) ─────────

export function checkExactlyOneClass(
  merged: MergedInventory,
  prov: ProvenanceIndex,
  collector: FindingCollector,
): void {
  const valid = new Set<string>(COLLECTION_CLASSES);
  (merged.hosts ?? []).forEach((h, i) => {
    const cc = (h as { collection_class?: unknown }).collection_class;
    if (typeof cc !== "string" || !valid.has(cc)) {
      pushFinding(
        collector,
        prov,
        `hosts[${i}].collection_class`,
        "error",
        FINDING_CODES.INVALID_ENUM,
        `Host "${h?.name ?? "(unnamed)"}" must declare exactly one collection_class from: ${COLLECTION_CLASSES.join(", ")}.`,
        `Set hosts[${i}].collection_class to one of the five v1 classes; a host with zero or an unknown class is invalid (REQ-HOST-02, CON-07).`,
      );
    }
  });
}

// ── nas-api API-override completeness — both-or-neither (issue #4, REQ-HOST-03) ─

/**
 * A `nas-api` host renders as a direct node_exporter scrape by default. Its `api_endpoint`
 * and `credential` are optional, reserved fields that together opt the host into the
 * documented TrueNAS-API-exporter override recipe. Declaring exactly one is ambiguous — the
 * override needs both — so it is an error. Neither (the default) and both (the override) are
 * valid. Enforced here as a semantic invariant because a discriminatedUnion arm cannot carry
 * a cross-field `.refine` (02 §4.2).
 */
export function checkNasApiCompleteness(
  merged: MergedInventory,
  prov: ProvenanceIndex,
  collector: FindingCollector,
): void {
  (merged.hosts ?? []).forEach((h, i) => {
    if (h?.collection_class !== "nas-api") return;
    const hasEndpoint = (h as { api_endpoint?: unknown }).api_endpoint !== undefined;
    const hasCredential = (h as { credential?: unknown }).credential !== undefined;
    if (hasEndpoint === hasCredential) return; // neither (default) or both (override) → valid
    const present = hasEndpoint ? "api_endpoint" : "credential";
    const missing = hasEndpoint ? "credential" : "api_endpoint";
    pushFinding(
      collector,
      prov,
      `hosts[${i}].${missing}`,
      "error",
      FINDING_CODES.INCOMPLETE_NAS_API,
      `nas-api host "${h?.name ?? "(unnamed)"}" declares "${present}" without "${missing}".`,
      `A nas-api host is a direct node_exporter scrape by default. To use the opt-in TrueNAS-API-exporter override, declare BOTH "api_endpoint" and "credential"; to use the default, declare NEITHER (issue #4).`,
    );
  });
}

// ── §3.4 Telegram channel requires options.chat_id (issue #2, REQ-CHAN-01) ───

/** A chat_id is present iff it is a non-empty string or a finite number (Telegram int64 or `@name`). */
function hasChatId(v: unknown): boolean {
  return (typeof v === "string" && v.trim().length > 0) || (typeof v === "number" && Number.isFinite(v));
}

/**
 * A `telegram` channel delivers via Alertmanager's `telegram_configs`, which needs a non-secret
 * `chat_id` alongside the bot-token credential (issue #2). The token is a SecretRef in `credential`;
 * `chat_id` is a plain scalar carried in the generic `options` map (02 §4.4). A telegram channel that
 * omits `options.chat_id` cannot address a destination, so it is an error. Enforced as a semantic
 * invariant because `options` is a generic map with no kind-specific shape.
 */
export function checkTelegramOptions(
  merged: MergedInventory,
  prov: ProvenanceIndex,
  collector: FindingCollector,
): void {
  (merged.channels ?? []).forEach((c, i) => {
    if (c?.kind !== "telegram") return;
    const chatId = (c as { options?: Record<string, unknown> }).options?.chat_id;
    if (hasChatId(chatId)) return;
    pushFinding(
      collector,
      prov,
      `channels[${i}].options.chat_id`,
      "error",
      FINDING_CODES.MISSING_CHAT_ID,
      `Telegram channel "${c?.name ?? "(unnamed)"}" has no options.chat_id.`,
      `Add "options: { chat_id: <id> }" to the telegram channel — the numeric chat id (int64) or an "@channelname". The bot token stays in "credential" as a secret reference (issue #2).`,
    );
  });
}

// ── Command-signal name uniqueness (issue #3, REQ-SVC-03) ────────────────────

/**
 * A host's `command_signals` names must be unique — the name is the `signal` label on the
 * liveness series and the exporter's per-signal state key, so a collision would silently merge two
 * signals' liveness. A second use of a name is an error on that entry. Structurally scoped to
 * managed-linux by the schema (the field lives only on that arm); read defensively regardless.
 */
export function checkCommandSignals(
  merged: MergedInventory,
  prov: ProvenanceIndex,
  collector: FindingCollector,
): void {
  (merged.hosts ?? []).forEach((h, i) => {
    const signals = (h as { command_signals?: unknown }).command_signals;
    if (!Array.isArray(signals)) return;
    const seen = new Set<string>();
    signals.forEach((cs, j) => {
      const name = (cs as { name?: unknown })?.name;
      if (typeof name !== "string") return; // shape layer already flagged a bad name
      if (seen.has(name)) {
        pushFinding(
          collector,
          prov,
          `hosts[${i}].command_signals[${j}].name`,
          "error",
          FINDING_CODES.DUPLICATE_COMMAND_SIGNAL,
          `Host "${h?.name ?? "(unnamed)"}" declares two command signals named "${name}".`,
          `Command-signal names are unique per host (the "signal" liveness label). Rename one of the "${name}" signals.`,
        );
      }
      seen.add(name);
    });
  });
}

// ── Backup-command host class — delivery requires managed-linux (issue #3) ────

/**
 * A `backup_freshness.command` is delivered by the command-exporter, which runs only in the
 * managed-linux agent bundle. So a backup service that declares a `command` must resolve to a
 * managed-linux host; on any other class (or an unresolved host) the command can never run. A
 * plain unresolved host is already an UNRESOLVED_HOST finding (checkCrossReferences); this adds the
 * class constraint for a resolved-but-wrong-class host.
 */
export function checkBackupCommandHost(
  merged: MergedInventory,
  prov: ProvenanceIndex,
  collector: FindingCollector,
): void {
  const classByName = new Map<string, unknown>();
  (merged.hosts ?? []).forEach((h) => {
    const name = h?.name;
    if (typeof name === "string") classByName.set(name, h?.collection_class);
  });
  (merged.services ?? []).forEach((s, i) => {
    const command = s?.backup_freshness?.command;
    if (command === undefined) return; // declaration-only backup — no delivery, no constraint
    const hostName = s?.host;
    if (typeof hostName !== "string" || !classByName.has(hostName)) return; // UNRESOLVED_HOST owns it
    if (classByName.get(hostName) === "managed-linux") return;
    pushFinding(
      collector,
      prov,
      `services[${i}].backup_freshness.command`,
      "error",
      FINDING_CODES.BACKUP_COMMAND_HOST,
      `Backup service "${s?.name ?? "(unnamed)"}" declares a backup_freshness.command, but its host "${hostName}" is "${String(classByName.get(hostName))}", not managed-linux.`,
      `The command-exporter that delivers backup_freshness.command runs only in the managed-linux agent bundle. Move the service to a managed-linux host, or drop the command and keep backup_freshness as a declaration-only alert threshold.`,
    );
  });
}

// ── Host-local deep-health probe host class — requires managed-linux (issue #8) ──

/**
 * A `deep_health.host_local` probe runs from a PER-HOST prober in the managed-linux agent bundle
 * (agent/<host>/prober/config.yaml, network_mode: host) — the only class that ships the bundle. So
 * a host-local deep-health probe must resolve to a managed-linux host; on any other class the
 * per-host prober is never installed and the probe can never run. A plain unresolved host is already
 * an UNRESOLVED_HOST finding (checkCrossReferences); this adds the class constraint for a
 * resolved-but-wrong-class host (mirrors checkBackupCommandHost, issue #3).
 */
export function checkHostLocalProbeHost(
  merged: MergedInventory,
  prov: ProvenanceIndex,
  collector: FindingCollector,
): void {
  const classByName = new Map<string, unknown>();
  (merged.hosts ?? []).forEach((h) => {
    const name = h?.name;
    if (typeof name === "string") classByName.set(name, h?.collection_class);
  });
  (merged.services ?? []).forEach((s, i) => {
    if (s?.deep_health?.host_local !== true) return; // central-probed (or no probe) — no constraint
    const hostName = s?.host;
    if (typeof hostName !== "string" || !classByName.has(hostName)) return; // UNRESOLVED_HOST owns it
    if (classByName.get(hostName) === "managed-linux") return;
    pushFinding(
      collector,
      prov,
      `services[${i}].deep_health.host_local`,
      "error",
      FINDING_CODES.HOST_LOCAL_PROBE_HOST,
      `Service "${s?.name ?? "(unnamed)"}" declares a host_local deep_health probe, but its host "${hostName}" is "${String(classByName.get(hostName))}", not managed-linux.`,
      `A host_local probe runs from a per-host prober in the managed-linux agent bundle. Move the service to a managed-linux host, or drop host_local so the central prober handles it.`,
    );
  });
}

// ── Per-endpoint alert binding requires a rendered Gatus endpoint (issue #15) ──

/**
 * A service `alerts:` binding (issue #15) only takes effect on a service that renders a Gatus
 * endpoint — i.e. one with an `ingress_url` and not `suppressed`. On any other service the binding
 * is silently inert (there is no check for stack/alerting's `GatusCheckFailed` rule to watch, so no
 * rule is rendered — issue #1), so warn (not error): the estate declared
 * paging intent that will never fire. Mirrors the advisory shape of the other cross-field checks.
 */
export function checkEndpointAlertBinding(
  merged: MergedInventory,
  prov: ProvenanceIndex,
  collector: FindingCollector,
): void {
  (merged.services ?? []).forEach((s, i) => {
    const alerts = s?.alerts;
    if (alerts === undefined) return; // no binding — nothing to check
    if (s?.ingress_url !== undefined && s?.suppressed === undefined) return; // renders an endpoint
    pushFinding(
      collector,
      prov,
      `services[${i}].alerts`,
      "warning",
      FINDING_CODES.INERT_ALERT_BINDING,
      `Service "${s?.name ?? "(unnamed)"}" declares an alerts: binding, but it renders no Gatus endpoint (${s?.suppressed !== undefined ? "the service is suppressed" : "it has no ingress_url"}), so the binding never fires.`,
      `Give the service an ingress_url (and remove any suppression) so a synthetic check is rendered, or drop the alerts: binding.`,
    );
  });
}

// ── Names rendered into Gatus must be quote/backslash/newline-free (issue #1) ──

/** Characters Gatus v5.13.1 cannot take in an endpoint name or group: it panics at startup on
 *  them, which takes down EVERY synthetic check, not just the offending one. */
const GATUS_UNSAFE_CHARS = /["\\\r\n]/;

/**
 * Every host or service name and estate domain that the renderer writes into `gatus/config.yaml`
 * — the `name` (`<host>/<service>`, `host:<host>`, `dns:<domain>`) and `group` (`<host>`) of a
 * service ingress check (a service with `ingress_url`, not suppressed), a probe-only host check, or
 * a per-domain DNS check — must not contain `"`, `\` or a line break. Error: one such name would crash Gatus for the whole estate.
 */
export function checkGatusNames(
  merged: MergedInventory,
  prov: ProvenanceIndex,
  collector: FindingCollector,
): void {
  const LABEL = { host: "Host name", service: "Service name", domain: "Estate domain" } as const;
  const flag = (path: string, kind: keyof typeof LABEL, name: string, why: string): void =>
    pushFinding(
      collector,
      prov,
      path,
      "error",
      FINDING_CODES.GATUS_UNSAFE_NAME,
      `${LABEL[kind]} ${JSON.stringify(name)} contains a double quote, backslash or line break, but it is rendered into a Gatus check (${why}); Gatus fails to start on such a name, stopping every synthetic check.`,
      `${kind === "domain" ? "Fix the domain" : `Rename the ${kind}`} to drop the double quote, backslash and line breaks.`,
    );
  (merged.estate?.domains ?? []).forEach((domain, i) => {
    if (typeof domain === "string" && GATUS_UNSAFE_CHARS.test(domain)) {
      flag(`estate.domains[${i}]`, "domain", domain, `its dns:${domain} check`);
    }
  });
  (merged.services ?? []).forEach((s, i) => {
    if (s?.ingress_url === undefined || s?.suppressed !== undefined) return; // renders no check
    if (typeof s.name === "string" && GATUS_UNSAFE_CHARS.test(s.name)) {
      flag(`services[${i}].name`, "service", s.name, "its ingress check");
    }
    if (typeof s.host === "string" && GATUS_UNSAFE_CHARS.test(s.host)) {
      flag(`services[${i}].host`, "host", s.host, `the ingress check of service "${String(s.name)}"`);
    }
  });
  (merged.hosts ?? []).forEach((h, i) => {
    if (h?.collection_class !== "probe-only") return;
    if (typeof h.name === "string" && GATUS_UNSAFE_CHARS.test(h.name)) {
      flag(`hosts[${i}].name`, "host", h.name, "its probe-only check");
    }
  });
}

// ── §3.3 Cross-reference integrity (UNRESOLVED_HOST / UNRESOLVED_CHANNEL) ─────

/** service.host resolves against hosts[]; routing_overrides.channels against channels[]. */
export function checkCrossReferences(
  merged: MergedInventory,
  prov: ProvenanceIndex,
  collector: FindingCollector,
): void {
  const hostNames = new Set(
    (merged.hosts ?? [])
      .map((h) => h?.name)
      .filter((n): n is string => typeof n === "string"),
  );
  (merged.services ?? []).forEach((s, i) => {
    if (typeof s?.host === "string" && !hostNames.has(s.host)) {
      pushFinding(
        collector,
        prov,
        `services[${i}].host`,
        "error",
        FINDING_CODES.UNRESOLVED_HOST,
        `Service "${s?.name ?? "(unnamed)"}" references host "${s.host}", which is not declared.`,
        `Declare a host named "${s.host}", or correct services[${i}].host to an existing host name.`,
      );
    }
  });

  const channelNames = new Set(
    (merged.channels ?? [])
      .map((c) => c?.name)
      .filter((n): n is string => typeof n === "string"),
  );
  (merged.routing_overrides ?? []).forEach((r, i) => {
    (r?.channels ?? []).forEach((ch, j) => {
      if (typeof ch === "string" && !channelNames.has(ch)) {
        pushFinding(
          collector,
          prov,
          `routing_overrides[${i}].channels[${j}]`,
          "error",
          FINDING_CODES.UNRESOLVED_CHANNEL,
          `Routing override for severity "${r?.severity ?? "?"}" references channel "${ch}", which is not declared.`,
          `Declare a channel named "${ch}", or correct routing_overrides[${i}].channels[${j}] to an existing channel name.`,
        );
      }
    });
  });
}
