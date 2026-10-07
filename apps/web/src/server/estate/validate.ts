// src/server/estate/validate.ts — the pure, never-throwing trust boundary for already-read rendered
// bundle bytes (rendered-model-v2, 05-bundle-loader-and-validation.md). `parseEstateBundle` parses
// model → coverage → findings in fixed order, exhaustively validates every downstream-consumed field,
// enforces cross-artifact identity/coverage coherence, and returns the FIRST deterministic
// `EstateBundleError` as data (never coerces, repairs, echoes an unsafe value, or throws).
//
// The per-artifact validators are module-private; tests exercise them only through `parseEstateBundle`
// so the public trust boundary is the object under test (05 §2.2). Types come from `load.ts` (bundle
// contracts) and `@pulse/renderer`/`@pulse/core` (artifact + finding contracts); they are never
// duplicated here.

import { FINDING_CODES } from "@pulse/core";
import type {
  WebCoverageArtifact,
  WebEstateModelV2,
  WebFindingsArtifact,
} from "@pulse/renderer";

import { EstateBundleError } from "../../shared/errors.js";
import type { EstateBundleArtifact } from "../../shared/errors.js";
import type {
  BundleFileBytes,
  EstateBundleLoadResult,
  EstateBundlePaths,
} from "./load.js";

// ── Internal machinery ──────────────────────────────────────────────────────────────────────────

type JsonObject = Record<string, unknown>;

/** A structural validation failure: a JSON field path plus non-sensitive detail. Always `structure`. */
interface FieldFail {
  field: string;
  detail: string;
}

/** Set of finding codes accepted in the findings artifact (closed public vocabulary). */
const FINDING_CODE_VALUES = new Set<string>(Object.values(FINDING_CODES));

/** The five model collection classes (host discriminant / coverage class). */
const COLLECTION_CLASSES = new Set([
  "managed-linux",
  "hypervisor-api",
  "nas-api",
  "probe-only",
  "excluded",
]);

const CHANNEL_KINDS = new Set(["chat", "email", "push", "telegram", "webhook"]);
const SUPPRESSION_CLASSES = new Set(["excluded", "expected-churn", "known-expected"]);

const ENV_DISPLAY_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const OP_DISPLAY_RE = /^op:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+$/;
const BUNDLE_ID_RE = /^sha256:[0-9a-f]{64}$/;

// ── Reusable predicates (05 §5.1) ─────────────────────────────────────────────────────────────────

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isBundleId(value: unknown): value is string {
  return typeof value === "string" && BUNDLE_ID_RE.test(value);
}

/** Safe rendered-root/estate-relative POSIX path (05 §5.6): non-empty, no NUL, no backslash, not
 *  absolute, not drive-qualified, and no empty/`.`/`..` segment. */
function isSafeRelativePosixPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return false;
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Raw code-point sorted own keys, so the first error is independent of insertion order (05 §5.1). */
function sortedKeys(object: JsonObject): string[] {
  return Object.keys(object).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Encode an arbitrary record key for a field path (05 §5.1). */
function keyPath(base: string, key: string): string {
  return `${base}[${JSON.stringify(key)}]`;
}

function fail(field: string, detail: string): FieldFail {
  return { field, detail };
}

// ── Nested common contracts (05 §5.3) ─────────────────────────────────────────────────────────────

/** credential: object; `kind` then `display`; display matches its kind. */
function validateCredential(value: unknown, base: string): FieldFail | null {
  if (!isJsonObject(value)) return fail(base, "expected a JSON object");
  const kind = value["kind"];
  if (kind !== "env" && kind !== "op") {
    return fail(`${base}.kind`, "expected 'env' or 'op'");
  }
  const display = value["display"];
  if (typeof display !== "string") return fail(`${base}.display`, "expected a string");
  const re = kind === "env" ? ENV_DISPLAY_RE : OP_DISPLAY_RE;
  if (!re.test(display)) return fail(`${base}.display`, "credential display does not match its kind");
  return null;
}

/** credential or null (never omitted where this is used as a declared field). */
function validateCredentialOrNull(value: unknown, base: string): FieldFail | null {
  if (value === null) return null;
  return validateCredential(value, base);
}

/** suppression info: null or object; `class` enum; `rationale` string. */
function validateSuppressionInfo(value: unknown, base: string): FieldFail | null {
  if (value === null) return null;
  if (!isJsonObject(value)) return fail(base, "expected a JSON object or null");
  if (!SUPPRESSION_CLASSES.has(value["class"] as string)) {
    return fail(`${base}.class`, "expected a suppression class");
  }
  if (!isNonEmptyString(value["rationale"])) return fail(`${base}.rationale`, "expected a string");
  return null;
}

/** provenance: object; `file` safe path; `path` any string; `line`/`col` positive integers. */
function validateProvenance(value: unknown, base: string): FieldFail | null {
  if (!isJsonObject(value)) return fail(base, "expected a JSON object");
  if (!isSafeRelativePosixPath(value["file"])) {
    return fail(`${base}.file`, "expected a safe estate-relative POSIX path");
  }
  if (typeof value["path"] !== "string") return fail(`${base}.path`, "expected a string");
  if (!isPositiveInteger(value["line"])) return fail(`${base}.line`, "expected a positive integer");
  if (!isPositiveInteger(value["col"])) return fail(`${base}.col`, "expected a positive integer");
  return null;
}

/** scrape target: object; `job` string; `instance` string. */
function validateScrapeTarget(value: unknown, base: string): FieldFail | null {
  if (!isJsonObject(value)) return fail(base, "expected a JSON object");
  if (!isNonEmptyString(value["job"])) return fail(`${base}.job`, "expected a string");
  if (!isNonEmptyString(value["instance"])) return fail(`${base}.instance`, "expected a string");
  return null;
}

/** artifact array: every element a safe path, with no duplicate (later duplicate fails, 05 §6.3). */
function validateArtifacts(value: unknown, base: string): FieldFail | null {
  if (!Array.isArray(value)) return fail(base, "expected an array");
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!isSafeRelativePosixPath(item)) {
      return fail(`${base}[${i}]`, "expected a safe rendered-root-relative path");
    }
    if (seen.has(item)) return fail(`${base}[${i}]`, "duplicate artifact path");
    seen.add(item);
  }
  return null;
}

/** array of non-empty strings. */
function validateStringArray(value: unknown, base: string): FieldFail | null {
  if (!Array.isArray(value)) return fail(base, "expected an array");
  for (let i = 0; i < value.length; i++) {
    if (!isNonEmptyString(value[i])) return fail(`${base}[${i}]`, "expected a string");
  }
  return null;
}

// ── Host detail validators (05 §5.3) ──────────────────────────────────────────────────────────────

function validateCommandSignal(value: unknown, base: string): FieldFail | null {
  if (!isJsonObject(value)) return fail(base, "expected a JSON object");
  if (!isNonEmptyString(value["name"])) return fail(`${base}.name`, "expected a string");
  const output = value["output"];
  if (output !== "scalar" && output !== "exposition") {
    return fail(`${base}.output`, "expected 'scalar' or 'exposition'");
  }
  if (!isNonEmptyString(value["interval"])) return fail(`${base}.interval`, "expected a string");
  if (!isNonEmptyString(value["command"])) return fail(`${base}.command`, "expected a string");
  const credFail = validateCredentialOrNull(value["credential"], `${base}.credential`);
  if (credFail) return credFail;

  if (output === "scalar") {
    if (!isNonEmptyString(value["metric"])) return fail(`${base}.metric`, "expected a string");
    if (!isNonEmptyString(value["upMetric"])) return fail(`${base}.upMetric`, "expected a string");
    if (hasOwn(value, "labels")) {
      const labels = value["labels"];
      if (!isJsonObject(labels)) return fail(`${base}.labels`, "expected a JSON object");
      for (const key of sortedKeys(labels)) {
        if (key.length === 0) return fail(keyPath(`${base}.labels`, key), "expected a non-empty key");
        if (typeof labels[key] !== "string") {
          return fail(keyPath(`${base}.labels`, key), "expected a string");
        }
      }
    }
    return null;
  }

  // exposition forbids scalar-only members.
  if (hasOwn(value, "metric")) return fail(`${base}.metric`, "forbidden for exposition output");
  if (hasOwn(value, "upMetric")) return fail(`${base}.upMetric`, "forbidden for exposition output");
  if (hasOwn(value, "labels")) return fail(`${base}.labels`, "forbidden for exposition output");
  return null;
}

function validateHostDetail(
  collectionClass: string,
  detail: unknown,
  base: string,
): FieldFail | null {
  if (!isJsonObject(detail)) return fail(base, "expected a JSON object");

  switch (collectionClass) {
    case "managed-linux": {
      const ports = detail["exporterPorts"];
      if (!Array.isArray(ports)) return fail(`${base}.exporterPorts`, "expected an array");
      for (let i = 0; i < ports.length; i++) {
        if (!isPositiveInteger(ports[i])) {
          return fail(`${base}.exporterPorts[${i}]`, "expected a positive integer");
        }
      }
      if (typeof detail["cadvisor"] !== "boolean") return fail(`${base}.cadvisor`, "expected a boolean");
      if (typeof detail["heartbeat"] !== "boolean") {
        return fail(`${base}.heartbeat`, "expected a boolean");
      }
      const form = detail["deliveryForm"];
      if (form !== "compose" && form !== "systemd") {
        return fail(`${base}.deliveryForm`, "expected 'compose' or 'systemd'");
      }
      const signals = detail["commandSignals"];
      if (!Array.isArray(signals)) return fail(`${base}.commandSignals`, "expected an array");
      for (let i = 0; i < signals.length; i++) {
        const sf = validateCommandSignal(signals[i], `${base}.commandSignals[${i}]`);
        if (sf) return sf;
      }
      return null;
    }
    case "hypervisor-api": {
      if (!isNonEmptyString(detail["apiEndpoint"])) {
        return fail(`${base}.apiEndpoint`, "expected a string");
      }
      return validateCredential(detail["credential"], `${base}.credential`);
    }
    case "nas-api": {
      const endpoint = detail["apiEndpoint"];
      const credential = detail["credential"];
      if (isNonEmptyString(endpoint)) {
        return validateCredential(credential, `${base}.credential`);
      }
      if (endpoint === null) {
        if (credential !== null) {
          return fail(`${base}.apiEndpoint`, "expected null when credential is null");
        }
        return null;
      }
      return fail(`${base}.apiEndpoint`, "expected a string or null");
    }
    case "probe-only": {
      const probe = detail["probe"];
      if (!isJsonObject(probe)) return fail(`${base}.probe`, "expected a JSON object");
      if (!isNonEmptyString(probe["kind"])) return fail(`${base}.probe.kind`, "expected a string");
      if (!isNonEmptyString(probe["target"])) return fail(`${base}.probe.target`, "expected a string");
      const expect = probe["expect"];
      if (expect !== null && !isNonEmptyString(expect)) {
        return fail(`${base}.probe.expect`, "expected a string or null");
      }
      return null;
    }
    case "excluded": {
      const keys = sortedKeys(detail);
      if (keys.length > 0) return fail(keyPath(base, keys[0] as string), "expected no members");
      return null;
    }
    default:
      // Unreachable: collectionClass was already validated against the enum.
      return fail(`${base}`, "unknown collection class");
  }
}

// ── Host validator (05 §5.3) ──────────────────────────────────────────────────────────────────────

function validateHost(value: unknown, base: string): FieldFail | null {
  if (!isJsonObject(value)) return fail(base, "expected a JSON object");
  if (!isNonEmptyString(value["name"])) return fail(`${base}.name`, "expected a string");
  const collectionClass = value["collectionClass"];
  if (!COLLECTION_CLASSES.has(collectionClass as string)) {
    return fail(`${base}.collectionClass`, "expected a collection class");
  }
  const addrFail = validateStringArray(value["addresses"], `${base}.addresses`);
  if (addrFail) return addrFail;
  const supFail = validateSuppressionInfo(value["suppressed"], `${base}.suppressed`);
  if (supFail) return supFail;
  if (!isNonEmptyString(value["drilldownId"])) return fail(`${base}.drilldownId`, "expected a string");
  if (typeof value["expectedChurn"] !== "boolean") {
    return fail(`${base}.expectedChurn`, "expected a boolean");
  }
  const sic = value["scrapeIntervalClass"];
  if (sic !== null && !isNonEmptyString(sic)) {
    return fail(`${base}.scrapeIntervalClass`, "expected a string or null");
  }
  const provFail = validateProvenance(value["provenance"], `${base}.provenance`);
  if (provFail) return provFail;
  const scrape = value["scrapeTargets"];
  if (!Array.isArray(scrape)) return fail(`${base}.scrapeTargets`, "expected an array");
  for (let i = 0; i < scrape.length; i++) {
    const st = validateScrapeTarget(scrape[i], `${base}.scrapeTargets[${i}]`);
    if (st) return st;
  }
  const artFail = validateArtifacts(value["artifacts"], `${base}.artifacts`);
  if (artFail) return artFail;
  return validateHostDetail(collectionClass as string, value["detail"], `${base}.detail`);
}

// ── Service validator (05 §5.3) ───────────────────────────────────────────────────────────────────

function validateDeepHealthDetail(value: unknown, base: string): FieldFail | null {
  if (!isJsonObject(value)) return fail(base, "expected a JSON object");
  if (!isNonEmptyString(value["endpoint"])) return fail(`${base}.endpoint`, "expected a string");
  const metrics = value["metrics"];
  const metricsFail = validateStringArray(metrics, `${base}.metrics`);
  if (metricsFail) return metricsFail;
  const mapping = value["responseMapping"];
  if (!isJsonObject(mapping)) return fail(`${base}.responseMapping`, "expected a JSON object");
  for (const key of sortedKeys(mapping)) {
    if (key.length === 0) return fail(keyPath(`${base}.responseMapping`, key), "expected a non-empty key");
    if (typeof mapping[key] !== "string") {
      return fail(keyPath(`${base}.responseMapping`, key), "expected a string");
    }
  }
  if (!isNonEmptyString(value["alertExpression"])) {
    return fail(`${base}.alertExpression`, "expected a string");
  }
  if (typeof value["hostLocal"] !== "boolean") return fail(`${base}.hostLocal`, "expected a boolean");
  const credFail = validateCredentialOrNull(value["credential"], `${base}.credential`);
  if (credFail) return credFail;

  // metrics must contain each responseMapping key exactly once and no other value (05 §5.3).
  const keys = Object.keys(mapping);
  const metricList = metrics as string[];
  const metricSet = new Set(metricList);
  if (
    metricSet.size !== metricList.length ||
    metricList.length !== keys.length ||
    !keys.every((k) => metricSet.has(k))
  ) {
    return fail(`${base}.metrics`, "expected exactly the responseMapping keys");
  }
  return null;
}

function validateBackupFreshness(value: unknown, base: string): FieldFail | null {
  if (value === null) return null;
  if (!isJsonObject(value)) return fail(base, "expected a JSON object or null");
  if (!isNonEmptyString(value["signal"])) return fail(`${base}.signal`, "expected a string");
  if (!isNonEmptyString(value["threshold"])) return fail(`${base}.threshold`, "expected a string");
  if (!isNonEmptyString(value["interval"])) return fail(`${base}.interval`, "expected a string");
  if (typeof value["hasCommand"] !== "boolean") return fail(`${base}.hasCommand`, "expected a boolean");
  return null;
}

function validateEndpointAlert(value: unknown, base: string): FieldFail | null {
  if (!isJsonObject(value)) return fail(base, "expected a JSON object");
  if (!isNonEmptyString(value["type"])) return fail(`${base}.type`, "expected a string");
  if (hasOwn(value, "enabled") && typeof value["enabled"] !== "boolean") {
    return fail(`${base}.enabled`, "expected a boolean");
  }
  if (hasOwn(value, "failureThreshold") && !isPositiveInteger(value["failureThreshold"])) {
    return fail(`${base}.failureThreshold`, "expected a positive integer");
  }
  if (hasOwn(value, "successThreshold") && !isPositiveInteger(value["successThreshold"])) {
    return fail(`${base}.successThreshold`, "expected a positive integer");
  }
  if (hasOwn(value, "description") && !isNonEmptyString(value["description"])) {
    return fail(`${base}.description`, "expected a string");
  }
  if (hasOwn(value, "sendOnResolved") && typeof value["sendOnResolved"] !== "boolean") {
    return fail(`${base}.sendOnResolved`, "expected a boolean");
  }
  return null;
}

function validateService(value: unknown, base: string): FieldFail | null {
  if (!isJsonObject(value)) return fail(base, "expected a JSON object");
  if (!isNonEmptyString(value["name"])) return fail(`${base}.name`, "expected a string");
  if (!isNonEmptyString(value["host"])) return fail(`${base}.host`, "expected a string");
  if (typeof value["managed"] !== "boolean") return fail(`${base}.managed`, "expected a boolean");
  const deepHealth = value["deepHealth"];
  if (typeof deepHealth !== "boolean") return fail(`${base}.deepHealth`, "expected a boolean");
  if (hasOwn(value, "ingressUrl") && !isNonEmptyString(value["ingressUrl"])) {
    return fail(`${base}.ingressUrl`, "expected a string");
  }
  const supFail = validateSuppressionInfo(value["suppressed"], `${base}.suppressed`);
  if (supFail) return supFail;
  if (!isNonEmptyString(value["drilldownId"])) return fail(`${base}.drilldownId`, "expected a string");
  if (!isNonEmptyString(value["kind"])) return fail(`${base}.kind`, "expected a string");
  const provFail = validateProvenance(value["provenance"], `${base}.provenance`);
  if (provFail) return provFail;
  const gatusFail = validateStringArray(value["gatusEndpoints"], `${base}.gatusEndpoints`);
  if (gatusFail) return gatusFail;
  const artFail = validateArtifacts(value["artifacts"], `${base}.artifacts`);
  if (artFail) return artFail;

  const detail = value["deepHealthDetail"];
  if (deepHealth) {
    const dhFail = validateDeepHealthDetail(detail, `${base}.deepHealthDetail`);
    if (dhFail) return dhFail;
  } else if (detail !== null) {
    return fail(`${base}.deepHealthDetail`, "expected null when deepHealth is false");
  }

  const backupFail = validateBackupFreshness(value["backupFreshness"], `${base}.backupFreshness`);
  if (backupFail) return backupFail;

  const alerts = value["alerts"];
  if (!Array.isArray(alerts)) return fail(`${base}.alerts`, "expected an array");
  for (let i = 0; i < alerts.length; i++) {
    const af = validateEndpointAlert(alerts[i], `${base}.alerts[${i}]`);
    if (af) return af;
  }
  return null;
}

// ── Channel / routing / suppression validators (05 §5.3) ──────────────────────────────────────────

function validateChannel(value: unknown, base: string): FieldFail | null {
  if (!isJsonObject(value)) return fail(base, "expected a JSON object");
  if (!isNonEmptyString(value["name"])) return fail(`${base}.name`, "expected a string");
  if (!CHANNEL_KINDS.has(value["kind"] as string)) return fail(`${base}.kind`, "expected a channel kind");
  const credFail = validateCredential(value["credential"], `${base}.credential`);
  if (credFail) return credFail;
  const options = value["options"];
  if (options !== null) {
    if (!isJsonObject(options)) return fail(`${base}.options`, "expected a JSON object or null");
    for (const key of sortedKeys(options)) {
      if (key.length === 0) return fail(keyPath(`${base}.options`, key), "expected a non-empty key");
      const v = options[key];
      const okType =
        typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
      if (!okType) return fail(keyPath(`${base}.options`, key), "expected a string, number, or boolean");
    }
  }
  return validateProvenance(value["provenance"], `${base}.provenance`);
}

function validateRoutingOverride(value: unknown, base: string): FieldFail | null {
  if (!isJsonObject(value)) return fail(base, "expected a JSON object");
  if (!isNonEmptyString(value["severity"])) return fail(`${base}.severity`, "expected a string");
  const chFail = validateStringArray(value["channels"], `${base}.channels`);
  if (chFail) return chFail;
  return validateProvenance(value["provenance"], `${base}.provenance`);
}

function validateStandaloneSuppression(value: unknown, base: string): FieldFail | null {
  if (!isJsonObject(value)) return fail(base, "expected a JSON object");
  if (!isNonEmptyString(value["target"])) return fail(`${base}.target`, "expected a string");
  if (!SUPPRESSION_CLASSES.has(value["class"] as string)) {
    return fail(`${base}.class`, "expected a suppression class");
  }
  if (!isNonEmptyString(value["rationale"])) return fail(`${base}.rationale`, "expected a string");
  const provFail = validateProvenance(value["provenance"], `${base}.provenance`);
  if (provFail) return provFail;
  return validateStringArray(value["resolves"], `${base}.resolves`);
}

// ── Model body validator (05 §5.3) ────────────────────────────────────────────────────────────────

function validateModelBody(root: JsonObject): FieldFail | null {
  const estate = root["estate"];
  if (!isJsonObject(estate)) return fail("estate", "expected a JSON object");
  if (!isNonEmptyString(estate["name"])) return fail("estate.name", "expected a string");
  const domainsFail = validateStringArray(estate["domains"], "estate.domains");
  if (domainsFail) return domainsFail;
  if (!isNonEmptyString(estate["timezone"])) return fail("estate.timezone", "expected a string");
  const dns = estate["dnsResolver"];
  if (dns !== null && !isNonEmptyString(dns)) return fail("estate.dnsResolver", "expected a string or null");
  const retention = estate["retention"];
  if (retention !== null && !isNonEmptyString(retention)) {
    return fail("estate.retention", "expected a string or null");
  }
  if (!isPositiveInteger(estate["schemaMajor"])) {
    return fail("estate.schemaMajor", "expected a positive integer");
  }
  const deadman = estate["deadman"];
  if (!isJsonObject(deadman)) return fail("estate.deadman", "expected a JSON object");
  if (typeof deadman["configured"] !== "boolean") {
    return fail("estate.deadman.configured", "expected a boolean");
  }
  const dmKind = deadman["kind"];
  if (dmKind !== "secret-ref" && dmKind !== "plain") {
    return fail("estate.deadman.kind", "expected 'secret-ref' or 'plain'");
  }

  const hosts = root["hosts"];
  if (!Array.isArray(hosts)) return fail("hosts", "expected an array");
  for (let i = 0; i < hosts.length; i++) {
    const hf = validateHost(hosts[i], `hosts[${i}]`);
    if (hf) return hf;
  }

  const services = root["services"];
  if (!Array.isArray(services)) return fail("services", "expected an array");
  for (let i = 0; i < services.length; i++) {
    const sf = validateService(services[i], `services[${i}]`);
    if (sf) return sf;
  }

  const channels = root["channels"];
  if (!Array.isArray(channels)) return fail("channels", "expected an array");
  for (let i = 0; i < channels.length; i++) {
    const cf = validateChannel(channels[i], `channels[${i}]`);
    if (cf) return cf;
  }

  const routing = root["routingOverrides"];
  if (!Array.isArray(routing)) return fail("routingOverrides", "expected an array");
  for (let i = 0; i < routing.length; i++) {
    const rf = validateRoutingOverride(routing[i], `routingOverrides[${i}]`);
    if (rf) return rf;
  }

  const suppressions = root["suppressions"];
  if (!Array.isArray(suppressions)) return fail("suppressions", "expected an array");
  for (let i = 0; i < suppressions.length; i++) {
    const sf = validateStandaloneSuppression(suppressions[i], `suppressions[${i}]`);
    if (sf) return sf;
  }
  return null;
}

// ── Coverage body validator (05 §5.4) ─────────────────────────────────────────────────────────────

type CoverageBucket = "covered" | "gaps" | "suppressed";

function validateCoverageEntry(value: unknown, bucket: CoverageBucket, base: string): FieldFail | null {
  if (!isJsonObject(value)) return fail(base, "expected a JSON object");
  const kind = value["kind"];
  if (kind !== "host" && kind !== "service") return fail(`${base}.kind`, "expected 'host' or 'service'");
  if (!isNonEmptyString(value["name"])) return fail(`${base}.name`, "expected a string");
  if (!COLLECTION_CLASSES.has(value["collectionClass"] as string)) {
    return fail(`${base}.collectionClass`, "expected a collection class");
  }
  const artFail = validateArtifacts(value["artifacts"], `${base}.artifacts`);
  if (artFail) return artFail;
  const supFail = validateSuppressionInfo(value["suppressed"], `${base}.suppressed`);
  if (supFail) return supFail;

  const artifacts = value["artifacts"] as string[];
  const suppressed = value["suppressed"];
  // Local bucket semantics (05 §5.4).
  if (bucket === "covered") {
    if (suppressed !== null) return fail(`${base}.suppressed`, "expected null for a covered entry");
    if (artifacts.length === 0) return fail(`${base}.artifacts`, "expected at least one artifact");
  } else if (bucket === "gaps") {
    if (suppressed !== null) return fail(`${base}.suppressed`, "expected null for a gap entry");
    if (artifacts.length > 0) return fail(`${base}.artifacts`, "expected no artifacts for a gap entry");
  } else {
    if (suppressed === null) return fail(`${base}.suppressed`, "expected suppression for a suppressed entry");
  }
  return null;
}

function validateCoverageBody(root: JsonObject): FieldFail | null {
  for (const bucket of ["covered", "gaps", "suppressed"] as const) {
    const arr = root[bucket];
    if (!Array.isArray(arr)) return fail(bucket, "expected an array");
    for (let i = 0; i < arr.length; i++) {
      const ef = validateCoverageEntry(arr[i], bucket, `${bucket}[${i}]`);
      if (ef) return ef;
    }
  }
  return null;
}

// ── Findings body validator (05 §5.5) ─────────────────────────────────────────────────────────────

function validateFindingsBody(root: JsonObject): FieldFail | null {
  const findings = root["findings"];
  if (!Array.isArray(findings)) return fail("findings", "expected an array");
  for (let i = 0; i < findings.length; i++) {
    const base = `findings[${i}]`;
    const f = findings[i];
    if (!isJsonObject(f)) return fail(base, "expected a JSON object");
    const severity = f["severity"];
    if (severity !== "error" && severity !== "warning" && severity !== "info") {
      return fail(`${base}.severity`, "expected 'error', 'warning', or 'info'");
    }
    if (typeof f["code"] !== "string" || !FINDING_CODE_VALUES.has(f["code"])) {
      return fail(`${base}.code`, "expected a known finding code");
    }
    if (!isSafeRelativePosixPath(f["file"])) {
      return fail(`${base}.file`, "expected a safe estate-relative POSIX path");
    }
    if (typeof f["path"] !== "string") return fail(`${base}.path`, "expected a string");
    if (!isNonEmptyString(f["message"])) return fail(`${base}.message`, "expected a string");
    if (!isNonEmptyString(f["fix"])) return fail(`${base}.fix`, "expected a string");
  }
  return null;
}

// ── Cross-artifact model identity validation (05 §6.2) ────────────────────────────────────────────

function validateModelIdentities(model: WebEstateModelV2): FieldFail | null {
  const hostNames = new Set<string>();
  const drilldownIds = new Set<string>();
  for (let i = 0; i < model.hosts.length; i++) {
    const host = model.hosts[i]!;
    if (hostNames.has(host.name)) return fail(`hosts[${i}].name`, "duplicate host name");
    if (host.drilldownId !== `host:${host.name}`) {
      return fail(`hosts[${i}].drilldownId`, "expected 'host:' + name");
    }
    hostNames.add(host.name);
    drilldownIds.add(host.drilldownId);
  }

  const composites = new Set<string>();
  for (let i = 0; i < model.services.length; i++) {
    const service = model.services[i]!;
    const composite = `${service.host}/${service.name}`;
    if (composites.has(composite)) return fail(`services[${i}].name`, "duplicate service identity");
    if (!hostNames.has(service.host)) return fail(`services[${i}].host`, "unknown owner host");
    if (service.drilldownId !== `svc:${composite}`) {
      return fail(`services[${i}].drilldownId`, "expected 'svc:' + host + '/' + name");
    }
    composites.add(composite);
    drilldownIds.add(service.drilldownId);
  }

  for (let i = 0; i < model.suppressions.length; i++) {
    const suppression = model.suppressions[i]!;
    const seen = new Set<string>();
    for (let j = 0; j < suppression.resolves.length; j++) {
      const id = suppression.resolves[j]!;
      if (!drilldownIds.has(id)) {
        return fail(`suppressions[${i}].resolves[${j}]`, "unresolved drilldown id");
      }
      if (seen.has(id)) return fail(`suppressions[${i}].resolves[${j}]`, "duplicate drilldown id");
      seen.add(id);
    }
  }
  return null;
}

// ── Cross-artifact coverage partition validation (05 §6.3) ────────────────────────────────────────

interface CoverageEntryLike {
  kind: "host" | "service";
  name: string;
  collectionClass: string;
  artifacts: string[];
  suppressed: { class: string; rationale: string } | null;
}

function sameArtifacts(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameSuppression(
  a: { class: string; rationale: string } | null,
  b: { class: string; rationale: string } | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.class === b.class && a.rationale === b.rationale;
}

function validateCoveragePartition(
  model: WebEstateModelV2,
  coverage: WebCoverageArtifact,
  coveragePath: string,
): EstateBundleError | null {
  const hostByName = new Map<string, WebEstateModelV2["hosts"][number]>();
  for (const host of model.hosts) hostByName.set(host.name, host);
  const serviceByComposite = new Map<string, WebEstateModelV2["services"][number]>();
  for (const service of model.services) serviceByComposite.set(`${service.host}/${service.name}`, service);

  const observed = new Set<string>();

  const buckets: readonly CoverageBucket[] = ["covered", "gaps", "suppressed"];
  for (const bucket of buckets) {
    const entries = coverage[bucket] as unknown as CoverageEntryLike[];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const base = `${bucket}[${i}]`;
      const key = `${entry.kind}:${entry.name}`;
      if (observed.has(key)) {
        return incoherentCoverage(coveragePath, `${base}.name`);
      }

      let modelArtifacts: string[];
      let modelClass: string;
      let modelSuppressed: { class: string; rationale: string } | null;
      if (entry.kind === "host") {
        const host = hostByName.get(entry.name);
        if (host === undefined) return incoherentCoverage(coveragePath, `${base}.name`);
        modelArtifacts = host.artifacts;
        modelClass = host.collectionClass;
        modelSuppressed = host.suppressed;
      } else {
        const service = serviceByComposite.get(entry.name);
        if (service === undefined) return incoherentCoverage(coveragePath, `${base}.name`);
        const owner = hostByName.get(service.host);
        if (owner === undefined) return incoherentCoverage(coveragePath, `${base}.name`);
        modelArtifacts = service.artifacts;
        modelClass = owner.collectionClass;
        modelSuppressed = service.suppressed;
      }

      if (entry.collectionClass !== modelClass) {
        return incoherentCoverage(coveragePath, `${base}.collectionClass`);
      }
      if (!sameArtifacts(entry.artifacts, modelArtifacts)) {
        return incoherentCoverage(coveragePath, `${base}.artifacts`);
      }
      if (!sameSuppression(entry.suppressed, modelSuppressed)) {
        return incoherentCoverage(coveragePath, `${base}.suppressed`);
      }
      observed.add(key);
    }
  }

  // Every declared host then service must be observed exactly once (05 §6.3 step 7).
  for (const host of model.hosts) {
    if (!observed.has(`host:${host.name}`)) {
      return incoherentCoverage(coveragePath, missingBucketField(host.suppressed, host.artifacts));
    }
  }
  for (const service of model.services) {
    if (!observed.has(`service:${service.host}/${service.name}`)) {
      return incoherentCoverage(coveragePath, missingBucketField(service.suppressed, service.artifacts));
    }
  }
  return null;
}

function missingBucketField(
  suppressed: { class: string; rationale: string } | null,
  artifacts: readonly string[],
): CoverageBucket {
  if (suppressed !== null) return "suppressed";
  return artifacts.length > 0 ? "covered" : "gaps";
}

// ── Error builders (05 §8) ────────────────────────────────────────────────────────────────────────

function structErr(
  artifact: EstateBundleArtifact,
  path: string,
  field: string,
  detail: string,
): EstateBundleError {
  return new EstateBundleError(
    "structure",
    artifact,
    path,
    `Estate bundle ${artifact} at ${path} has malformed field '${field}' (${detail}). ` +
      `Run 'pulse render'; do not hand-edit rendered artifacts.`,
    { field },
  );
}

function versionErr(
  artifact: EstateBundleArtifact,
  path: string,
  foundVersion: number | null,
): EstateBundleError {
  const message =
    `Estate bundle ${artifact} at ${path} has an unsupported formatVersion. ` +
    `Re-render with the same Pulse version as the web image.`;
  return new EstateBundleError(
    "version",
    artifact,
    path,
    message,
    foundVersion !== null ? { field: "formatVersion", foundVersion } : { field: "formatVersion" },
  );
}

function unparseableErr(artifact: EstateBundleArtifact, path: string): EstateBundleError {
  return new EstateBundleError(
    "unparseable",
    artifact,
    path,
    `Estate bundle ${artifact} at ${path} is not valid JSON. ` +
      `Run 'pulse render'; do not hand-edit or copy individual bundle files.`,
    { field: "$" },
  );
}

function incoherentId(artifact: EstateBundleArtifact, path: string): EstateBundleError {
  return new EstateBundleError(
    "incoherent",
    artifact,
    path,
    `Estate bundle ${artifact} at ${path} belongs to a different render generation. ` +
      `Run 'pulse render' and mount the rendered tree as one unit.`,
    { field: "bundleId" },
  );
}

function incoherentCoverage(path: string, field: string): EstateBundleError {
  return new EstateBundleError(
    "incoherent",
    "coverage",
    path,
    `Estate bundle coverage at ${path} disagrees with the model at field '${field}'. ` +
      `Run 'pulse render' and mount the rendered tree as one unit.`,
    { field },
  );
}

function clockErr(path: string): EstateBundleError {
  return new EstateBundleError(
    "unreadable",
    "model",
    path,
    `Estate bundle load time could not be recorded for ${path}. ` +
      `Verify the server clock and retry the load.`,
    { field: "loadedAt" },
  );
}

// ── Header validation (05 §5.2) ───────────────────────────────────────────────────────────────────

/** Validate the common artifact header: object root, `formatVersion` exactly 2, valid `bundleId`. */
function checkHeader(
  root: unknown,
  artifact: EstateBundleArtifact,
  path: string,
): { obj: JsonObject } | { error: EstateBundleError } {
  if (!isJsonObject(root)) {
    return { error: structErr(artifact, path, "$", "expected a JSON object") };
  }
  const found = root["formatVersion"];
  // formatVersion must be exactly the numeric integer literal 2 (the v2 boundary). The renderer
  // pin `SUPPORTED_WEB_MODEL_VERSIONS` becomes `[2]` at the item-010 format transition; until then
  // the authoritative gate is the literal 2 that the entire v2 contract is built around (05 §5.2).
  if (found !== 2) {
    return { error: versionErr(artifact, path, typeof found === "number" ? found : null) };
  }
  if (!isBundleId(root["bundleId"])) {
    return { error: structErr(artifact, path, "bundleId", "expected a sha256 bundle id") };
  }
  return { obj: root };
}

/** Canonical UTC ISO-8601 instant: parses and round-trips exactly (05 §7). */
function isCanonicalIso(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

// ── Public trust boundary (05 §§2, 4.2, 7) ────────────────────────────────────────────────────────

/**
 * Parse and fully validate already-read bytes in fixed model → coverage → findings order. Pure and
 * never throws: every domain failure is returned as `{ ok: false, error }`. On success returns the
 * complete `EstateBundle` — no intermediate parsed member is exposed on failure (05 §7).
 */
export function parseEstateBundle(
  files: BundleFileBytes,
  paths: EstateBundlePaths,
  loadedAt: string,
): EstateBundleLoadResult {
  try {
    // 1. Model: parse → header (version, id) → structure.
    let modelRoot: unknown;
    try {
      modelRoot = JSON.parse(files.model);
    } catch {
      return { ok: false, error: unparseableErr("model", paths.model) };
    }
    const modelHeader = checkHeader(modelRoot, "model", paths.model);
    if ("error" in modelHeader) return { ok: false, error: modelHeader.error };
    const modelFail = validateModelBody(modelHeader.obj);
    if (modelFail) return { ok: false, error: structErr("model", paths.model, modelFail.field, modelFail.detail) };
    const model = modelHeader.obj as unknown as WebEstateModelV2;

    // 2. Coverage (optional).
    let coverage: WebCoverageArtifact | null = null;
    if (files.coverage !== null) {
      let root: unknown;
      try {
        root = JSON.parse(files.coverage);
      } catch {
        return { ok: false, error: unparseableErr("coverage", paths.coverage) };
      }
      const header = checkHeader(root, "coverage", paths.coverage);
      if ("error" in header) return { ok: false, error: header.error };
      const bodyFail = validateCoverageBody(header.obj);
      if (bodyFail) {
        return { ok: false, error: structErr("coverage", paths.coverage, bodyFail.field, bodyFail.detail) };
      }
      coverage = header.obj as unknown as WebCoverageArtifact;
    }

    // 3. Findings (optional).
    let findings: WebFindingsArtifact | null = null;
    if (files.findings !== null) {
      let root: unknown;
      try {
        root = JSON.parse(files.findings);
      } catch {
        return { ok: false, error: unparseableErr("findings", paths.findings) };
      }
      const header = checkHeader(root, "findings", paths.findings);
      if ("error" in header) return { ok: false, error: header.error };
      const bodyFail = validateFindingsBody(header.obj);
      if (bodyFail) {
        return { ok: false, error: structErr("findings", paths.findings, bodyFail.field, bodyFail.detail) };
      }
      findings = header.obj as unknown as WebFindingsArtifact;
    }

    // 4. Cross-artifact bundle identity (coverage before findings).
    if (coverage !== null && coverage.bundleId !== model.bundleId) {
      return { ok: false, error: incoherentId("coverage", paths.coverage) };
    }
    if (findings !== null && findings.bundleId !== model.bundleId) {
      return { ok: false, error: incoherentId("findings", paths.findings) };
    }

    // 5. Model internal identities.
    const idFail = validateModelIdentities(model);
    if (idFail) return { ok: false, error: structErr("model", paths.model, idFail.field, idFail.detail) };

    // 6. Coverage partition and model relationships.
    if (coverage !== null) {
      const covErr = validateCoveragePartition(model, coverage, paths.coverage);
      if (covErr) return { ok: false, error: covErr };
    }

    // 7. Finding source-file safety is enforced structurally in `validateFindingsBody`.

    // §7: canonical loadedAt, then assemble.
    if (!isCanonicalIso(loadedAt)) return { ok: false, error: clockErr(paths.model) };

    return { ok: true, bundle: { model, coverage, findings, loadedAt } };
  } catch {
    // Defensive: an unexpected internal fault never escapes and never leaks a value (05 §8).
    return {
      ok: false,
      error: structErr("model", paths.model, "$", "validation could not be completed"),
    };
  }
}
