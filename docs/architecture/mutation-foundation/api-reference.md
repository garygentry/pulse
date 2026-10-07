# API Reference

This page documents the write path's HTTP contracts and the internal TypeScript seams: the server mutation seam, the handlers and stores, `@pulse/core/proposals`, the `pulse proposals` CLI and the client mutation modules. Only `@pulse/core/proposals` is a package export. Everything else is internal to its workspace and is listed here so you can extend it safely.

Paths are relative to the repository root.

## HTTP Contracts

### Request requirements (every mutation)

| Requirement | Value |
|---|---|
| Method | `POST` |
| Identity | `PULSE_WEB_AUTH_HEADER` set by a peer in `PULSE_WEB_TRUSTED_PROXIES` |
| Same origin | `Sec-Fetch-Site: same-origin`, or, when that header is absent, `Origin` matching `Host` |
| Content type | `application/json` (optionally `; charset=utf-8`) |
| Body | UTF-8 JSON, at most 16 KiB, strict schema (unknown keys refused) |
| `Idempotency-Key` | `^[A-Za-z0-9_-]{8,128}$` |

### Response headers

Every dispatched response carries:

- `x-request-id`: the request id, also written to both audit records.
- `cache-control: private, no-store`.
- `idempotency-replayed: true`: only on a replayed response. A replay carries the **original** request id.

### Success envelope

```typescript
import type { MutationSuccess } from "../apps/web/src/shared/mutations.js";

// { outcome: "succeeded", requestId: "6b1e…", result: { silenceId: "…", endsAt: "…" } }
type CreateSilenceResponse = MutationSuccess<{ silenceId: string; endsAt: string }>;
```

### Refusal and failure envelope

```typescript
interface MutationRefusal {
  readonly code: ApiErrorCode;     // INVALID_REQUEST | SOURCE_UNAVAILABLE | SOURCE_TIMEOUT | TARGET_NOT_FOUND | INTERNAL_ERROR
  readonly message: string;        // fixed catalog text, not for display
  readonly details: {
    readonly reason: MutationReason;
    readonly requestId?: string;   // always set by the dispatcher
    readonly fields?: string;      // comma-joined dot-paths ("$" = root), ≤ 512 bytes, never values
  };
}
```

### Reasons

| `reason` | Phase | Status | Audited / replayed |
|---|---|---|---|
| `untrusted-identity` | refusal | 403 | no |
| `cross-origin` | refusal | 403 | no |
| `capability-false` | refusal | 403 | no |
| `write-path-degraded` | refusal | 503 | no |
| `invalid-body` | refusal | 400 | no |
| `body-too-large` | refusal | 413 | no |
| `missing-idempotency-key` | refusal | 400 | no |
| `idempotency-conflict` | refusal | 409 | no |
| `audit-unavailable` | refusal | 503 | no (degrades `audit`) |
| `internal` | refusal or failed | 500 | only when failed |
| `alert-not-firing` | failed | 404 | yes |
| `silence-gone` | failed | 404 | yes |
| `entity-not-found` | failed | 404 | yes |
| `stale-proposal` | failed | 409 | yes |
| `write-failed` | failed | 500 | yes |
| `upstream-timeout` | failed | 504 | yes |
| `upstream-transport`, `upstream-upstream-status`, `upstream-malformed-json`, `upstream-invalid-shape`, `upstream-incompatible`, `upstream-overflow`, `upstream-disabled` | failed | 502 | yes |

`MUTATION_REASONS` in `apps/web/src/shared/mutations.ts` is the closed list.

### `POST /api/mutations/silences`

Creates an Alertmanager silence. Capability `silence`, action `silence.create`, audit target `alert:<fingerprint>`.

**Body:**

- `fingerprint` (`string`): 1–128 UTF-8 bytes, no control characters. Used as the audit target only.
- `matchers` (`{name, value}[]`): 1–24 entries.
  - `name` must match `^[A-Za-z_][A-Za-z0-9_]*$` (at most 128 bytes).
  - `value` must be 1–256 bytes.
  - Names must be unique, and an `alertname` matcher is required.
- `endsAt` (`string`): an ISO-8601 UTC timestamp, strictly after now and no more than 7 days out.
- `rationale` (`string`): trimmed first. 10–500 code points, no control characters except `\n`, and `"[pulse] " + rationale` must fit in 512 bytes.

Do not send `isRegex`, `isEqual`, `startsAt`, `createdBy` or `comment`: the server sets them, and sending them is refused as unknown keys.

**Returns:** `201 {silenceId, endsAt}`.
**Fails:** `upstream-timeout` (504), `upstream-*` (502).

```bash
curl -s -X POST https://pulse.example/api/mutations/silences \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(openssl rand -hex 16)" \
  -d '{"fingerprint":"3f2a9c01","matchers":[{"name":"alertname","value":"DiskFull"},{"name":"host","value":"nas01"}],
       "endsAt":"2026-10-01T12:00:00Z","rationale":"cleanup running on nas01"}'
```

### `POST /api/mutations/silences/expire`

Expires any active silence, whoever created it. Capability `silence`, action `silence.expire`, audit target `silence:<silenceId>`.

**Body:**

- `silenceId` (`string`): 1–128 bytes, no control characters.
- `rationale` (`string`, optional): 0–500 code points with the same rules as above. An empty value counts as absent.

**Returns:** `200 {silenceId}`.
**Fails:** `silence-gone` (404), `upstream-*`.

### `POST /api/mutations/acks`

Sets or replaces the ack on an alert. Capability `ack`, action `ack.set`.

**Body:**

- `fingerprint` (`string`): 1–128 bytes, no control characters. The alert must be in the latest cycle's alert list, in any state.
- `note` (`string`, optional): trimmed, at most 280 code points, no control characters except `\n`. An empty note is stored as `null`.

**Returns:** `200 {fingerprint, at}`.
**Fails:** `alert-not-firing` (404), `write-failed` (500).

### `POST /api/mutations/acks/remove`

Removes an ack. Idempotent, with no firing check. Capability `ack`, action `ack.remove`.

**Body:** `{fingerprint}`.
**Returns:** `200 {fingerprint, removed: boolean}`.
**Fails:** `write-failed` (500).

### `POST /api/mutations/proposals`

Records a signed estate-edit proposal. Capability `proposeEstateEdit`, action `proposal.create`, audit target `<kind>:<id>`.

**Body:**

- `target` (`{kind: "host" | "service", id}`): `id` is the drilldown id (`host:<name>` or `svc:<host>/<name>`), at most 247 bytes. The stored proposal also records the core `name`; `pulse proposals apply` resolves the entity by that name alone, which is safe because names are unique estate-wide.
- `changes` (`{field, seen, proposed}[]`): 1–5 entries, unique fields.
  - `seen` must equal the entity's current value.
  - `proposed` must be valid for the field and must differ from `seen`.
- `rationale` (`string`): 10–500 code points, no control characters except `\n`, and no bidi controls (LRM, RLM, U+202A–202E, U+2066–2069). The same rule covers a proposed suppression rationale and the CLI `--reason`, which is also single-line.

**Returns:** `201 {proposalId}`.

**Fails:**
- `invalid-body` (400) when a field does not apply to the entity (host class, kind);
- `entity-not-found` (404);
- `stale-proposal` (409); the audit record names the stale field as `staleField`;
- `write-failed` (500).

```json
{
  "target": { "kind": "host", "id": "host:nas01" },
  "changes": [{ "field": "expectedChurn", "seen": false, "proposed": true }],
  "rationale": "nas01 reboots nightly for backups"
}
```

### `GET /api/proposals?kind=host|service&id=<drilldownId>`

Lists the proposals for one entity. Registered in both auth modes.

- **Returns:** `200 ProposalListBody`: `{enabled, proposals: ProposalView[], invalidCount}`.
  - Newest first, at most 50.
  - `ProposalView` is `{id, createdAt, proposer, changes, rationale, state, reason, commit}`. `proposer` is the display name only.
- **Disabled:** when no store is installed or the caller lacks `proposeEstateEdit`, returns `{enabled:false, proposals:[], invalidCount:0}`.
- **Errors:** a missing, repeated or malformed `kind` or `id` returns `400 INVALID_REQUEST` with `details.param`.

### `GET /api/session` and `GET /healthz`

`/api/session` returns:

```json
{"identity": {...} | null, "authMode": "none|proxy-header",
 "capabilities": {"silence": bool, "ack": bool, "proposeEstateEdit": bool}}
```

`/healthz` gains `writePath: {silence, ack, proposeEstateEdit}`, each `{ok: boolean, reason: WritePathReason | null}`. `WritePathReason` is one of `not-configured`, `missing`, `unwritable`, `corrupt`, `secret-missing`, `secret-too-short`, `write-failed` or `auth-mode-none`.

## Server Mutation Seam

### Registry: `apps/web/src/server/mutations/registry.ts`

#### `interface MutationDefinition<B, R>`

```typescript
interface MutationDefinition<B, R> {
  readonly method: "POST";
  readonly path: `/api/mutations/${string}`;
  readonly capability: CapabilityName;                 // "silence" | "ack" | "proposeEstateEdit"
  readonly action: MutationAction;                     // "silence.create" | … | "proposal.create"
  readonly body: ZodType<B, ZodTypeDef, unknown>;      // strict schema
  validate?(body: B, ctx: ServerContext, now: Date):
    { readonly ok: true } | { readonly ok: false; readonly fields: readonly string[] };
  auditTarget(body: B): string;
  auditDetails(body: B): AuditDetails;                 // Record<string, string | number | boolean | null>
  handler(body: B, ctx: ServerContext, actor: Identity, meta: MutationHandlerMeta):
    Promise<MutationOutcome<R>>;
}
```

- **`validate`** is pure and runs before the idempotency lookup and the audit. Failure is an `invalid-body` refusal, which is not audited.
- **Target existence and staleness** belong in `handler`, as audited `failed` outcomes.
- **`MutationHandlerMeta`** is `{requestId, now}`. Use `meta.now` rather than your own clock.

#### `type MutationOutcome<R>`

```typescript
type MutationOutcome<R> =
  | { outcome: "succeeded"; status: 200 | 201; result: R; details?: AuditDetails }
  | { outcome: "failed"; status: 404 | 409 | 500 | 502 | 504; code: ApiErrorCode;
      reason: FailedReason; details?: AuditDetails };
```

`details` is merged into the finalize audit record. The dispatcher overrides a failed outcome's `status` and `code` from `FAILED_POLICY`.

#### `createMutationRegistry(authMode: AuthMode): MutationRegistry`

Returns `{register(def), match(pathname), list()}`.

**Throws:** `MutationRegistrationError` (code `MUTATION_REGISTRATION`). Its `rule` field says why:
- `auth-mode`: the mode is not `proxy-header`;
- `method`: the method is not `POST`;
- `path-prefix`: the path does not match `^/api/mutations/[a-z0-9]+(?:[-/][a-z0-9]+)*$`;
- `duplicate-path`: the path is already registered.

`match` is exact: a trailing slash does not match.

```typescript
import { createMutationRegistry } from "./registry.js";
import { createMutations } from "./definitions.js";

const registry = createMutationRegistry(config.identity.mode); // throws unless "proxy-header"
for (const def of createMutations({ writeClient, ackStore, proposalStore, now: () => new Date() })) {
  registry.register(def);
}
```

### Definitions: `apps/web/src/server/mutations/definitions.ts`

#### `createMutations(deps: MutationsDeps): readonly MutationDefinition<any, any>[]`

Returns the five definitions, frozen, in this order: silence create, silence expire, ack set, ack remove, proposal create. `MutationsDeps` is `{writeClient: AlertmanagerWriteClient; ackStore: AckStore; proposalStore: ProposalStore; now: () => Date}`.

### Dispatcher: `apps/web/src/server/mutations/dispatcher.ts`

#### `createMutationDispatcher(deps: MutationDispatcherDeps): MutationDispatcher`

`MutationDispatcherDeps` is `{identityConfig, getRuntime: () => ServerRuntime | null, registry, audit: AuditWriter, writePath: WritePath, idempotency: IdempotencyStore, now?}`.

The dispatcher returns `null` when nothing matches, so the router answers `405`. It never rejects.

### Bootstrap: `apps/web/src/server/mutations/bootstrap.ts`

#### `buildWriteRuntime(config: ServerConfig, deps: BuildWriteRuntimeDeps): Promise<WriteRuntime>`

The single place where write objects are constructed. `BuildWriteRuntimeDeps` is `{secret: SecretProvider; fetchImpl?}`. The returned `WriteRuntime` has:

- `dispatcher`
- `runtimeDeps`: `{ackStore, onSlowCycle}`, for `createServerRuntime`
- `writePath`
- `attachRuntime(runtime)`
- `close()`

```typescript
import { loadProposalSecret, loadServerConfig } from "../config.js";
import { buildWriteRuntime } from "./bootstrap.js";
import { createServerRuntime } from "../refresh.js";
import { createFetchHandler } from "../router.js";

const config = loadServerConfig();
const write = await buildWriteRuntime(config, { secret: loadProposalSecret(process.env) });
const runtime = createServerRuntime(config, write.runtimeDeps);
write.attachRuntime(runtime);
const fetch = createFetchHandler(runtime, undefined, write.dispatcher);
```

### Guards: `apps/web/src/server/mutations/guards.ts`

Every guard returns `GuardResult<T> = {ok: true; value: T} | {ok: false; reason: RefusalReason; fields?}`.

| Function | Purpose |
|---|---|
| `checkSameOrigin(headers: Headers): GuardResult<null>` | Uses `Sec-Fetch-Site` if present, otherwise compares `Origin` with `Host` |
| `checkContentType(headers: Headers): GuardResult<null>` | Requires JSON, optionally with the `utf-8` charset |
| `readBoundedJson(request: Request, maxBytes: number): Promise<GuardResult<Uint8Array>>` | Bounds the body by `Content-Length` and by counting stream bytes |
| `parseIdempotencyKey(headers: Headers): GuardResult<string>` | Checks the `IDEMPOTENCY_KEY_RE` shape |
| `parseStrictBody<B>(schema, bytes: Uint8Array): GuardResult<B>` | Fatal UTF-8 decode, `JSON.parse`, then `safeParse` |
| `zodIssuePaths(issues): string[]`, `formatInvalidFields(paths): string \| undefined` | Build the sanitized `details.fields` |

### Capabilities: `capabilities.ts` and `session-provider.ts`

#### `computeCapabilities(identity, authMode, writePath): {flags, denials}`

- `flags` is `SessionCapabilities`.
- `denials[cap]` is `null` when the capability is granted. Otherwise it is `{kind: "mode"}`, `{kind: "identity"}` or `{kind: "store", store, reason}`.
- `CAPABILITY_STORES` maps each capability to its stores:

  | Capability | Stores |
  |---|---|
  | `silence` | `audit`, `alertmanager` |
  | `ack` | `audit`, `acks` |
  | `proposeEstateEdit` | `audit`, `proposals`, `secret` |

#### `currentCapabilities(identity: Identity | null, authMode: AuthMode): SessionCapabilities`

Reads through the installed provider. It returns all `false` when no provider is installed, as in `none` mode, or when the provider throws. `/api/session` and `/api/proposals` use it.

#### `currentHealthWritePath(authMode): NonNullable<HealthBody["writePath"]>`

Builds the `/healthz` `writePath` block.

#### `setWritePathProvider(next)` / `resetWritePathProvider()`

Install or remove the snapshot provider. The reset function exists for tests.

### Write path: `apps/web/src/server/mutations/write-path.ts`

#### `createWritePath(config: WritePathConfig, deps: WritePathDeps): WritePath`

```typescript
interface WritePath {
  snapshot(): WritePathSnapshot;                               // Record<WritePathStore, {ok, reason}>
  markFailed(store: "audit" | "acks" | "proposals",
             reason: "write-failed" | "unwritable" | "corrupt"): void;
  probe(): Promise<WritePathSnapshot>;                         // single-flight, never rejects
}
```

`WritePathStore` is one of `audit`, `acks`, `proposals`, `secret` or `alertmanager`. `WritePathDeps` is `{secret: SecretStatus; alertmanagerConfigured: boolean; ackLoadStatus?; fs?; log?}`. The `fs` and `log` seams exist for tests.

### Idempotency: `apps/web/src/server/mutations/idempotency.ts`

#### `createIdempotencyStore(options: IdempotencyStoreOptions): IdempotencyStore`

`options` is `{ttlMs, maxEntries, now?}`. Production uses a 24 h TTL and 10,000 entries.

The store has these methods:
- `lookup(scope, bodyHash)`: returns `miss`, `replay`, `conflict` or `in-flight`;
- `begin`, `complete` and `abandon`;
- `sweep()`, which returns the number of entries removed;
- `size()`.

`scope` is `{subject, action, key}`.

#### `canonicalBodyHash(body: unknown): string | null`

Returns the SHA-256 hex digest of the canonical JSON of the parsed body.

### Refusals: `apps/web/src/server/mutations/refusal.ts`

- `REFUSAL_POLICY` and `FAILED_POLICY` map each reason to `{status, code, audited, stored, degrades}`.
- `refuse(reason, rc, fields?): Response` emits the metric and log, then builds the response.
- `refusalResponse` builds the response only, without emitting.
- `resolveFailedPolicy(reason)` normalizes a handler reason.
- `mutationHeaders(requestId, replayed)` builds the standard response headers.

### Audit encoding: `apps/web/src/server/mutations/audit.ts`

| Function | Purpose |
|---|---|
| `encodeAuditDetails(raw: AuditDetails): AuditDetailsEncoding` | Chunks `rationale`, `note`, `matchers` and `silenceId` into `<key>.1..k`, and adds `matchersSha256` and `matchersTruncated`. Reports defects instead of throwing |
| `buildAuditEvent(input: AuditEventInput): AuditEvent` | Builds the event, with `actor.source: "proxy-header"` and `correlationId: null` |
| `isWriterValidEvent(event: AuditEvent): boolean` | Pre-checks the event against the writer's bounds |
| `canonicalMatchers(matchers): string` | Sorted `name=value` pairs, comma-joined |
| `neutralizeControl(text): string` | `\n` becomes `␤`; other control characters become U+FFFD |

### Constants: `apps/web/src/server/mutations/constants.ts`

| Constant | Value |
|---|---|
| `MUTATION_PATH_PREFIX` | `"/api/mutations/"` |
| `IDEMPOTENCY_KEY_HEADER` | `"idempotency-key"` |
| `REQUEST_ID_HEADER` | `"x-request-id"` |
| `IDEMPOTENCY_REPLAYED_HEADER` | `"idempotency-replayed"` |
| `MUTATION_BODY_MAX_BYTES` | 16 KiB |
| `IDEMPOTENCY_KEY_RE` | `^[A-Za-z0-9_-]{8,128}$` |
| `IDEMPOTENCY_TTL_MS` | 24 h |
| `IDEMPOTENCY_MAX_ENTRIES` | 10,000 |
| `PROPOSAL_LIST_MAX` | 50 |
| `WRITE_PATH_ENV`, `WRITE_PATH_DEFAULTS` | Environment variable names and relative default paths |

### Config: `apps/web/src/server/config.ts`

- `parseWritePath(env, mode: AuthMode): WritePathConfig`. Fatal `ConfigError` on a relative or control-character path in `proxy-header` mode; ignores the write-path variables in `none` mode.
- `loadProposalSecret(env): SecretProvider`. Returns a frozen `{status, bytes()}`; `bytes()` returns a copy, or `null`.
- `secretStatusOf(raw): SecretStatus`

## Handlers and Stores

### Silences: `apps/web/src/server/mutations/handlers/silences.ts`

- `createSilenceMutation(deps: SilenceMutationDeps): MutationDefinition<CreateSilenceBody, CreateSilenceResult>`
- `expireSilenceMutation(deps: SilenceMutationDeps): MutationDefinition<ExpireSilenceBody, ExpireSilenceResult>`
- `SilenceMutationDeps` is `{writeClient: AlertmanagerWriteClient; now: () => Date}`.
- Helpers:
  - `checkSilenceWindow(endsAt, now)`
  - `toCreateSilenceRequest(body, actor, now)`
  - `isSilenceGone(error, silenceId, cycle)`
  - `upstreamFailure(error)`
  - `utf8ByteLength`, `codePointLength`, `hasForbiddenControl`
- Schemas: `createSilenceBodySchema`, `expireSilenceBodySchema`.

### Acks: `handlers/acks.ts` and `stores/ack-store.ts`

- `setAckMutation(deps: AckMutationDeps)` / `removeAckMutation(deps: AckMutationDeps)`. `AckMutationDeps` is `{ackStore: AckStore; now?}`.
- `normalizeNote(note?: string): string | null`

#### `createAckStore(path: string, deps: { writePath: WritePath }): Promise<AckStore>`

```typescript
interface AckStore {
  readonly loadStatus: StoreStatus;
  set(fingerprint: string, record: AckRecord): Promise<StoreWriteResult<AckRecord>>;
  remove(fingerprint: string): Promise<StoreWriteResult<boolean>>;
  reconcile(record: SourceRecord<readonly AlertmanagerAlert[]>): Promise<number>; // count cleared
  foldView(): ReadonlyMap<string, AckFoldRecord>;                                 // {by, at, note}
  get(fingerprint: string): AckRecord | undefined;
}
```

`AckRecord` is `{actor: {subject, displayName}, at: string, note: string | null}`. `StoreWriteResult<T>` is `{ok: true; value: T} | {ok: false; error: "write-failed"}`.

### Proposals (web): `handlers/proposals.ts`, `stores/proposal-store.ts` and `estate-values.ts`

- `createProposalMutation(deps: ProposalMutationDeps)`. `ProposalMutationDeps` is `{store: ProposalStore; randomBytes?}`.
- `createProposalStore(dir: string, secret: SecretProvider, deps: {writePath}): ProposalStore`. The store has:
  - `write(payload)`: signs, then creates the file exclusively;
  - `listFor(kind, drilldownId)`.
- `setProposalStoreProvider`, `currentProposalStore` and `resetProposalStoreProvider` manage the store used by `GET /api/proposals`.
- `resolveTarget(model, kind, id)` and `readProposableValue(model, target, field): CurrentValue` read values from the rendered estate model.

### Atomic writes: `apps/web/src/server/mutations/stores/atomic-file.ts`

#### `writeFileAtomic(path: string, bytes: Uint8Array, options?: AtomicWriteOptions): Promise<AtomicWriteResult>`

1. Writes a temp file with `wx` (default mode `0o640`) and fsyncs it.
2. Replaces the target: `rename` in the default mode, or `link` then `unlink` when `exclusive: true` (a collision gives `kind: "exists"`).
3. Fsyncs the directory.

It never rejects. The result is `{ok: true, durable}` or `{ok: false, kind: "exists" | "io", step, code}`.

## `@pulse/core/proposals`

`packages/core/src/proposals/`. The barrel is browser-safe; signing lives in the `./sign` subpath.

### Types

```typescript
type ProposableField = "expectedChurn" | "scrapeIntervalClass" | "cadvisor" | "heartbeat" | "suppressed";
type ProposalValue = boolean | string | SuppressionMarkValue | null;
interface ProposalChange { field: ProposableField; seen: ProposalValue; proposed: ProposalValue }
interface ProposalPayload {
  id: string; createdAt: string; requestId: string;
  proposer: { subject: string; displayName: string };
  target: { kind: "host" | "service"; id: string; name: string };
  changes: readonly ProposalChange[]; rationale: string;
}
interface ProposalFileV1 { format: "pulse-proposal/v1"; payload: ProposalPayload;
                           signature: { alg: "HMAC-SHA256"; value: string } }
type ProposalResultV1 =
  | { format: "pulse-proposal-result/v1"; id: string; state: "applied"; at: string; by: string; commit: string }
  | { format: "pulse-proposal-result/v1"; id: string; state: "rejected"; at: string; by: string; reason: string };
type ProposalState = "pending" | "applied" | "rejected";
```

Zod schemas for each type are exported alongside it: `proposalFileSchema`, `proposalPayloadSchema`, `proposalResultSchema`, `proposalChangeSchema`, `proposalValueSchema`, `storedRationaleSchema` and `proposableFieldSchema`.

### Fields

#### `PROPOSABLE_FIELDS: readonly ProposableFieldSpec[]`

Each entry has `{field, yamlKey, kinds, hostClasses, nullable, valueKind}`.

#### `fieldApplies(field, kind, hostClass: string | null): boolean`

#### `fieldValueSchema(field, kind)` / `fieldSeenSchema(field)`

#### `checkProposalChanges(kind, changes): ChangeIssue[]`

Reports duplicate fields, fields that do not apply to the kind, invalid `proposed` or `seen` values, and unchanged values.

### `readCoreValue(entity: Host | Service, field: ProposableField, suppressions?: readonly Suppression[]): CurrentValue`

Returns `{applicable: true, value}` or `{applicable: false}`.

```typescript
import { readCoreValue } from "@pulse/core/proposals";

const current = readCoreValue(host, "expectedChurn");
if (current.applicable && current.value === false) {
  // safe to propose `true`
}
```

### Ids and canonical JSON

- `newProposalId(now?: Date, randomBytes?): string` returns an id like `p-20260930T120000Z-1a2b3c4d`.
- `proposalFileName(id)` and `resultFileName(id)` throw a `TypeError` on a malformed id. `parseProposalFileName(name): string | null`.
- The patterns are `PROPOSAL_ID_RE`, `PROPOSAL_FILE_RE` and `RESULT_FILE_RE`.
- `canonicalProposalJson(value: unknown): string` sorts keys and emits no whitespace. It throws a `TypeError` on a value that is not JSON.
- `proposalValuesEqual(a, b): boolean`

### Constants

| Constant | Value |
|---|---|
| `PROPOSAL_SECRET_MIN_BYTES` | 32 |
| `PROPOSAL_CHANGES_MAX` | 5 |
| `PROPOSAL_RATIONALE_MIN_CHARS` / `MAX_CHARS` | 10 / 500 |
| `PROPOSAL_REJECT_REASON_MIN_CHARS` / `MAX_CHARS` | 10 / 500 |
| `PROPOSAL_TARGET_ID_MAX_BYTES` | 247 |
| `PROPOSAL_FILE_MAX_BYTES` | 65,536 |

### `@pulse/core/proposals/sign`

#### `signProposal(payload: ProposalPayload, secret: Uint8Array): ProposalFileV1`

**Throws:**
- `ProposalSecretError` (code `PROPOSAL_SECRET_TOO_SHORT`) when the secret is under 32 bytes;
- `TypeError` when the payload fails its schema.

#### `verifyProposal(file: unknown, secret: Uint8Array): VerifyResult`

Never throws. On failure the result's reason is one of `unparseable`, `schema`, `alg` or `signature`.

```typescript
import { newProposalId } from "@pulse/core/proposals";
import { signProposal, verifyProposal } from "@pulse/core/proposals/sign";

const secret = new TextEncoder().encode(process.env.PULSE_PROPOSAL_SECRET!);
const file = signProposal({
  id: newProposalId(),
  createdAt: new Date().toISOString(),
  requestId: "6b1e0f5a-0000-4000-8000-000000000000",
  proposer: { subject: "alice", displayName: "Alice" },
  target: { kind: "host", id: "host:nas01", name: "nas01" },
  changes: [{ field: "expectedChurn", seen: false, proposed: true }],
  rationale: "nas01 reboots nightly for backups",
}, secret);

const check = verifyProposal(JSON.parse(JSON.stringify(file)), secret);
```

## `pulse proposals` CLI

```text
pulse proposals list   [--state pending|applied|rejected]
pulse proposals show   <id>
pulse proposals apply  <id> [--overlay <file>]
pulse proposals reject <id> --reason "<10–500 chars>"
```

Every sub-verb accepts the global flags, including `--json` and the estate and output options, plus `--proposals-dir <path>`.

- **Proposals directory:** `--proposals-dir`, then `PULSE_PROPOSALS_DIR`, then `proposalsDir` in `pulse.config.yaml`. There is no default.
- **Secret:** `PULSE_PROPOSAL_SECRET`, at least 32 bytes. Every sub-verb requires it, `list` included.
- **Exit codes:**
  - `0`: no error findings;
  - `1`: error findings, such as not found, bad signature, stale or dirty tree;
  - `2`: a usage, config or tool fault.

| Verb | Behavior | Data (`--json`) |
|---|---|---|
| `list` | Verifies each file. Invalid files are listed separately and never fail the command | `{verb:"list", proposals, invalid}` |
| `show` | Prints the verified payload. Unverified content is never shown | `{verb:"show", proposal}` |
| `apply` | Verifies the signature, checks the tree and staleness, edits the overlay, validates and renders, commits, then writes the sidecar. Never pushes | `{verb:"apply", id, state, commit, reason, changedFiles, alreadyDecided}` |
| `reject` | Verifies the signature, then writes a `rejected` sidecar. Needs no git; inside a repo, a commit already carrying the proposal's `Proposal-Id` trailer is recorded as `applied` instead | `{verb:"reject", …}` |

Finding codes: `PROPOSAL_NOT_FOUND`, `PROPOSAL_SIGNATURE_INVALID`, `PROPOSAL_STALE`, `PROPOSAL_DIRTY_TREE`, `PROPOSAL_OVERLAY_AMBIGUOUS`, `PROPOSAL_CANNOT_CLEAR_BASE`, `PROPOSAL_INVALID_ESTATE` (phases `before`, `after`, `no-effect` and `render`) and `PROPOSAL_ALREADY_DECIDED` (info, exit 0).

The commit `apply` makes looks like this:

```text
estate: apply proposal p-20260930T120000Z-1a2b3c4d (host nas01)

nas01 reboots nightly for backups

Proposal-Id: p-20260930T120000Z-1a2b3c4d
Proposed-By: Alice
Changes: expectedChurn: false -> true
```

## Client Modules

All modules live under `apps/web/src/client/mutations/`.

### Session and gating

- `ensureSession(store: AppStore, fetchImpl?): Promise<void>`: loads `/api/session` once per store. It never throws.
- `refreshSession(store: AppStore, fetchImpl?): Promise<void>`: fetches the session again.
- `SESSION_REFRESH_REASONS`: `capability-false`, `untrusted-identity` and `write-path-degraded`.
- `canAct(store: AppStore, cap: ClientCapability): boolean`: false in wallboard density, under `?kiosk=1`, or when the capability is not `=== true`.

```tsx
import { canAct } from "../../mutations/gating.js";

export function MyAction(p: { store: AppStore }) {
  if (!canAct(p.store, "ack")) return null; // render nothing, never a disabled control
  return <MyActionInner store={p.store} />;
}
```

### Request client: `client.ts`

#### `postMutation<R>(path: `/api/mutations/${string}`, body: unknown, idempotencyKey: string, fetchImpl?): Promise<MutationSuccess<R>>`

**Throws:** `MutationClientError`, with fields:
- `reason`: a `MutationReason`, `"network"` or `"malformed-response"`;
- `status`;
- `requestId`;
- `fields`.

Helpers:
- `newIdempotencyKey(): string`: 22 base64url characters from 16 random bytes.
- `STORED_FAILURE_REASONS`: after one of these reasons, mint a new key.
- `failureText(err): string`: the reason copy plus the request id.
- `fieldHasError(fields, name): boolean`
- `displayText(s): string`: neutralizes control characters.

### Pending tracker: `pending.ts`

- `pendingTracker: PendingTracker`: a singleton with `add`, `observe`, `stateOf(target, nowMs)` (`"pending"`, `"not-reflected"` or `null`), `dismiss` and `version`.
- `predicates`:
  - `ackSet(fp, at)`
  - `ackRemoved(fp)`
  - `silenceCreated(id)`
  - `silenceExpired(id)`
- `installPendingObserver(store, tracker?)`: attaches an effect on `store.alerts` that clears entries as live data satisfies them.

### Components

| Export | Purpose |
|---|---|
| `ActionButton`, `useLazyDialog(load)` | Trigger button and lazy dialog loader (`{Comp, loading, error, open}`) |
| `StateBadge {state: "acked" \| "pending" \| "failed"}`, `PendingMarker {target}` | Status chips |
| `AckInfo {ack}` | Ack by, at and note in the detail pane |
| `ExpireButton {silence, store}` | Gated expire trigger used in the detail pane and the Silences tab |
| `ProposeEditAction {store, target, declared}` | Gated propose-edit trigger on the estate entity page |
| `ProposalList {target}` | `<details>` list backed by `GET /api/proposals`, refreshed via the `proposalListRefresh` signal |
| `TextField`, `TextArea`, `Checkbox`, `RadioGroup` | Accessible form primitives with counters and a locked state |
| `dialogs/SilenceDialog`, `AckDialog`, `ExpireDialog`, `ProposeDialog` | Lazy `default` exports. Each takes `MutationDialogBaseProps<R>`: `{store, open, onClose, onDone}` |

### Silence matcher helpers: `matchers.ts`

- `defaultMatchers(alert)`
- `matcherIssue(m)`
- `matchesAll(labels, matchers)`
- `matchedCount(payload, matchers)`
- `silenceRationaleIssue(raw)`

### Shared limits: `apps/web/src/shared/mutations.ts`

| Constant | Value |
|---|---|
| `SILENCE_DEFAULT_DURATION_MS` | 2 h |
| `SILENCE_MAX_DURATION_MS` | 7 d |
| `SILENCE_PRESETS_MS` | 1, 2, 4, 24, 168 h |
| `SILENCE_MATCHERS_MIN` / `MAX` | 1 / 24 |
| `SILENCE_COMMENT_PREFIX` | `"[pulse] "` |
| `SILENCE_COMMENT_MAX_BYTES` | 512 |
| `RATIONALE_MIN_CHARS` / `MAX_CHARS` | 10 / 500 |
| `ACK_NOTE_MAX_CHARS` | 280 |
| `PENDING_STALE_MS` | 30,000 |

## Observability

**Metrics:**

| Metric | Type and labels |
|---|---|
| `pulse_web_mutations_total` | counter; `action`, `outcome` = `succeeded`, `failed` or `replayed` |
| `pulse_web_mutation_refusals_total` | counter; `action`, `reason` |
| `pulse_web_audit_write_failures_total` | counter; `phase` = `attempted` or `finalize` |
| `pulse_web_ack_auto_clears_total` | counter |
| `pulse_web_write_path_status` | gauge, always `1`; `store`, `reason` (`ok` when healthy). Absent in `none` mode |

**Log events:**

- `mutation_succeeded`, `mutation_failed` and `mutation_refused`
- `mutation_internal_error`: carries a `phase` of `encode`, `validate`, `handler` or `dispatch`.
- `audit_write_failed`: carries `phase` and `kind`.
- `write_path_degraded` and `write_path_recovered`
- `ack_auto_cleared` and `ack_store_corrupt`

The idempotency key is never logged or audited.
