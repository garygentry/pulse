# API Reference

Everything below is exported from the package root:

```typescript
import { loadAndValidate, formatFindings, ConfigIoError, FINDING_CODES } from "@pulse/core";
import type { EstateModel, LoadResult, Finding } from "@pulse/core";
```

There are no subpath exports.

## Loading

### `loadAndValidate(dir, opts?): LoadResult`

Load a directory of estate YAML and validate it. Directory of YAML in → typed `EstateModel`
**or** agent-actionable `Finding`s out.

**Parameters:**
- `dir` (`string`) — The estate config directory to load.
- `opts` (`LoadOptions`, optional) — When `opts.files` is set, those explicit files are read
  (each resolved relative to `dir`) instead of scanning `dir` for `*.yaml` / `*.yml`.

**Returns:** `LoadResult` — `{ ok: true, model, findings }` if and only if zero
`error`-severity findings were produced, otherwise `{ ok: false, findings }` with no model. A
successful load may still carry `warning` / `info` findings.

**Throws:** `ConfigIoError` — For usage failures only (missing directory, unreadable path,
invalid argument). Config content problems, including malformed YAML, are findings, never
throws.

**Example:**
```typescript
import { loadAndValidate, formatFindings } from "@pulse/core";

const result = loadAndValidate("./estate");

if (result.ok) {
  for (const host of result.model.hosts) {
    console.log(`${host.name} [${host.collectionClass}]`);
  }
} else {
  console.error(formatFindings(result.findings));
}
```

Loading an explicit set of files instead of scanning:

```typescript
import { loadAndValidate } from "@pulse/core";

const result = loadAndValidate("./estate", {
  files: ["00-estate.yaml", "10-services.yaml"],
});
```

### `LoadResult`

```typescript
type LoadResult =
  | { ok: true; model: EstateModel; findings: Finding[] }
  | { ok: false; findings: Finding[] };
```

`ok` is `true` iff no `error`-severity finding was produced. On `ok: false` there is no
`model` property — narrow on `ok` before reading `model`.

### `LoadOptions`

```typescript
interface LoadOptions {
  files?: string[];
}
```

- `files` (`string[]`, optional) — Load these explicit files instead of scanning `dir`. Paths
  resolve relative to `dir`; the same sort and content-merge rules apply.

## The estate model

### `EstateModel`

The typed, thin-normalized estate — the single downstream vocabulary. Produced only on a
successful load.

```typescript
interface EstateModel {
  schemaMajor: number;            // the validated schema major (always 1 in v1)
  estate: Estate;                 // exactly one per model
  hosts: Host[];                  // insertion-ordered by first appearance
  services: Service[];            // insertion-ordered
  channels: Channel[];            // insertion-ordered
  routingOverrides: RoutingOverride[];
  suppressions: Suppression[];    // standalone suppressions
}
```

### `Estate`

Estate-level metadata; exactly one block per load.

```typescript
interface Estate {
  name: string;                   // a label; carries no monitoring semantics
  domains: string[];              // one or more
  dnsResolver?: string;           // DNS server for generated domain checks; defaults to 1.1.1.1
  timezone: string;               // IANA zone, required and validated
  deadmanHook: SecretRef | string; // a SecretRef when it carries a credential, else plain
  retention?: string;             // retention-target window, stored opaquely
  provenance: Provenance;
}
```

### `Host` and `CollectionClass`

A host is discriminated on `collectionClass`; each class carries exactly its own fields.

```typescript
type CollectionClass =
  | "managed-linux"
  | "hypervisor-api"
  | "nas-api"
  | "probe-only"
  | "excluded";

type Host =
  | (HostBase & { collectionClass: "managed-linux"; exporterPorts: number[] })
  | (HostBase & { collectionClass: "hypervisor-api"; apiEndpoint: string; credential: SecretRef })
  // nas-api: direct node_exporter scrape; apiEndpoint/credential optional (opt-in API override), issue #4
  | (HostBase & { collectionClass: "nas-api"; apiEndpoint?: string; credential?: SecretRef })
  | (HostBase & { collectionClass: "probe-only"; probe: ProbeSpec })
  | (HostBase & { collectionClass: "excluded"; suppressed: SuppressionMark });
```

`HostBase` fields, common to every class:

```typescript
{
  name: string;                   // unique across the estate
  addresses: string[];            // one or more (hostname/IP)
  expectedChurn?: boolean;        // per-host churn flag
  scrapeIntervalClass?: string;   // opaque per-target label
  provenance: Provenance;
}
```

Narrow on the discriminant to reach class-specific fields:

```typescript
for (const host of model.hosts) {
  if (host.collectionClass === "managed-linux") {
    console.log(host.name, host.exporterPorts);      // exporterPorts is in scope here
  } else if (host.collectionClass === "probe-only") {
    console.log(host.name, host.probe.kind, host.probe.target);
  }
}
```

### `ProbeSpec`

A host-level synthetic reachability probe for a `probe-only` host.

```typescript
interface ProbeSpec {
  kind: string;                   // e.g. "icmp" | "tcp" | "http" (opaque here)
  target: string;                 // address/port/URL as the kind requires
  expect?: string;                // optional expected-response assertion
}
```

### `Service`, `DeepHealthProbe`, `BackupFreshness`

```typescript
interface Service {
  name: string;                   // unique across the estate
  host: string;                   // resolved host name (integrity checked at load)
  kind: string;                   // opaque service-kind label
  managed: boolean;               // whether Pulse manages this service's lifecycle
  ingressUrl?: string;            // ingress URL for end-to-end checks
  deepHealth?: DeepHealthProbe;   // present iff a deep-health probe is declared
  backupFreshness?: BackupFreshness;
  suppressed?: SuppressionMark;   // present iff this service is a suppressed target
  provenance: Provenance;
}

interface DeepHealthProbe {
  endpoint: string;                       // returns a JSON health document
  responseMapping: Record<string, string>; // JSON path → metric name
  alertExpression: string;                // e.g. "camera_count < 6" (opaque string)
}

interface BackupFreshness {
  signal: string;                 // the freshness signal source
  threshold: string;              // downstream: > threshold → warning, > 2× → critical
}
```

### `Channel`, `ChannelKind`, `RoutingOverride`

```typescript
type ChannelKind = "chat" | "email" | "push" | "webhook";

interface Channel {
  name: string;                   // unique across the estate
  kind: ChannelKind;
  credential: SecretRef;          // a reference, never a literal
  provenance: Provenance;
}

interface RoutingOverride {
  severity: string;               // severity label to redirect (taxonomy owned by `alerting`)
  channels: string[];             // target channel names, each resolved against channels[]
  provenance: Provenance;
}
```

### `Suppression`, `SuppressionMark`, `SuppressionClass`

```typescript
type SuppressionClass = "excluded" | "expected-churn" | "known-expected";

interface SuppressionMark {
  class: SuppressionClass;
  rationale: string;              // mandatory; absence is a missing_rationale finding
}

interface Suppression extends SuppressionMark {
  target: string;                 // what is suppressed (a host/service/condition identity)
  provenance: Provenance;
}
```

An in-place `SuppressionMark` lives on the host or service it silences; a standalone
`Suppression` is a standing silenced condition in `model.suppressions`.

### `SecretRef`

A parsed secret *reference* — the reference only, never a resolved value. Discriminated on
`kind`.

```typescript
type SecretRef =
  | { kind: "env"; raw: string; varName: string }          // "${SLACK_TOKEN}"
  | { kind: "op"; raw: string; vault: string; item: string; field: string }; // "op://vault/item/field"
```

`raw` is the original reference text. `@pulse/core` never dereferences a `SecretRef`;
resolving it to a value is a downstream concern.

### `Provenance`

Where a model element was declared. All fields are deterministic — relative paths only, no
absolute paths, timestamps, or PIDs.

```typescript
interface Provenance {
  file: string;                   // source file, relative to the loaded directory
  path: string;                   // snake_case dotted YAML path, e.g. "hosts[2].exporter_ports"
  line: number;                   // 1-based
  col: number;                    // 1-based
}
```

## Findings

### `Finding` and `Severity`

The agent-actionable output of validation.

```typescript
type Severity = "error" | "warning" | "info";

interface Finding {
  severity: Severity;             // any "error" forces LoadResult.ok === false
  code: FindingCode;              // stable machine code; one of FINDING_CODES
  file: string;                   // relative to the loaded directory
  path: string;                   // snake_case field path; "" for a file/estate-level finding
  message: string;                // human-readable problem statement
  fix: string;                    // what to change — the fix path
}
```

### `FINDING_CODES` and `FindingCode`

The stable, machine-consumable codes. Callers may key on `code`; codes are part of the public
contract. `FindingCode` is the union of the values.

```typescript
import { FINDING_CODES } from "@pulse/core";

const shapeErrors = result.findings.filter(
  (f) => f.code === FINDING_CODES.UNKNOWN_FIELD || f.code === FINDING_CODES.MISSING_FIELD,
);
```

| Producing layer | Codes |
|-----------------|-------|
| Shape (Zod)     | `unknown_field`, `missing_field`, `wrong_type`, `invalid_enum` |
| Semantic        | `missing_rationale`, `secret_literal`, `incomplete_nas_api`, `unresolved_host`, `unresolved_channel`, `duplicate_identity`, `duplicate_estate`, `missing_timezone`, `invalid_timezone` |
| Loader          | `malformed_yaml` |
| Version         | `unsupported_version`, `missing_version` |

The property names on `FINDING_CODES` are the upper-cased forms (e.g. `FINDING_CODES.UNKNOWN_FIELD`
→ `"unknown_field"`).

### `formatFindings(findings): string`

Render findings as stable, human-readable text. A pure function of its input: renders in the
order given, performs no sorting, and never throws.

**Parameters:**
- `findings` (`readonly Finding[]`) — Typically `result.findings`, already sorted by the loader.

**Returns:** `string` — One two-line block per finding (a header line with severity, location,
code, and message; an indented `fix:` line), joined by newlines. Returns `""` for an empty
array.

**Example:**
```typescript
import { formatFindings } from "@pulse/core";

console.error(formatFindings(result.findings));
// error  estate.yaml:estate.timezone [missing_timezone] Estate metadata has no timezone.
//        fix: Add "timezone:" with an IANA zone, e.g. "America/Chicago". ...
```

## Errors

### `ConfigIoError`

Thrown for usage failures only — never for config content. The only exception type the
contract raises.

```typescript
class ConfigIoError extends Error {
  readonly code: ConfigIoErrorCode;
  readonly path?: string;         // the offending path, when the failure concerns one
}

type ConfigIoErrorCode =
  | "DIR_NOT_FOUND"     // the estate directory does not exist
  | "NOT_A_DIRECTORY"   // the path exists but is not a directory
  | "UNREADABLE"        // a path could not be read (permissions, I/O)
  | "INVALID_ARG";      // non-string / invalid argument to loadAndValidate
```

**Example:**
```typescript
import { loadAndValidate, ConfigIoError } from "@pulse/core";

try {
  const result = loadAndValidate("./does-not-exist");
  // ...
} catch (err) {
  if (err instanceof ConfigIoError && err.code === "DIR_NOT_FOUND") {
    console.error(`No estate directory at ${err.path}`);
  } else {
    throw err;
  }
}
```

## Versioning

### `CURRENT_SCHEMA_MAJOR` and `SUPPORTED_SCHEMA_MAJORS`

```typescript
import { CURRENT_SCHEMA_MAJOR, SUPPORTED_SCHEMA_MAJORS } from "@pulse/core";

CURRENT_SCHEMA_MAJOR;      // 1 — the schema major this build authors and normalizes against
SUPPORTED_SCHEMA_MAJORS;   // readonly [1] — the majors this build accepts
```

Every estate config declares an integer `schema_version` inside its `estate` block. A missing
or non-integer value yields a `missing_version` finding; a well-formed integer outside
`SUPPORTED_SCHEMA_MAJORS` yields an `unsupported_version` finding. Either short-circuits the
load before body validation. On a successful load, `model.schemaMajor` records the recognized
major.

## Schema (tooling and tests only)

### `inventorySchema`

The strict Zod schema for a single estate document, exported for tooling and tests. Production
consumers should use `loadAndValidate`, which runs the full pipeline (merge, version gate,
shape, semantics, normalization) rather than shape validation alone.

```typescript
import { inventorySchema } from "@pulse/core";

const shape = inventorySchema.safeParse(rawParsedYaml);
if (!shape.success) {
  // shape.error.issues — raw Zod issues, before the pipeline's Finding mapping
}
```
