# Pulse client contract

This document is the contract between the Pulse web server and separately installed Pulse clients. Sections between
`generated:` comment markers are produced by `bun run contract:gen`. Everything else is written by hand.

Contents: [About](#about) · [Versioning](#versioning) · [Handshake](#handshake) ·
[Announcing the client](#announcing) · [Tolerance rules](#tolerance) · [Operations](#operations) ·
[Response fields](#fields) · [Request bodies](#request-bodies) · [Limits](#limits) · [Enum fallbacks](#enum-fallbacks) · [Caching](#caching) ·
[Live events](#events) · [Request limits](#request-limits) · [Authentication](#auth) ·
[Not in the contract](#not-in-contract) · [Connect link](#connect-link) · [Push payload](#push-payload) · [Fixtures](#fixtures) ·
[Extending the contract](#extending)

<a id="about"></a>

## About this contract

This contract defines the read operations, response fields, events, limits and connect-link format that a separately
installed Pulse client may rely on. It covers the session, the overview, alerts, estate and timeline views, the four
history families (estate, target, alerts and checks), and the live event stream.

This contract is a promise to first-party Pulse clients maintained in this repository. It makes no stability
promise to any third-party client.

The source of truth is the TypeScript wire types in `packages/web-data`. The tables in this document, the fixtures
under `fixtures/`, the fixture index and the shape baselines under `shape/` are generated from those types and from the
running route handlers. Generated sections are marked and must not be edited by hand: a hand edit is overwritten by
the next generation, and the test suite fails first.

The current contract version is `1.1` (`CONTRACT_VERSION`). The [Fixtures](#fixtures) section repeats the version the
generated content was built for.

<a id="versioning"></a>

## Versioning

A contract version is `major.minor`, two non-negative integers (`ContractVersion`).

**Additive** changes bump `minor`:

- adding a response field;
- adding an enum member;
- adding a server capability;
- adding an event type;
- adding an endpoint;
- adding an optional request parameter;
- adding a connect-link parameter.

**Breaking** changes bump `major` and reset `minor` to 0:

- removing, renaming or retyping a field;
- changing a field's optionality or nullability;
- removing an enum member;
- narrowing a parameter's valid values;
- removing an endpoint or an event type.

CI enforces these rules against the frozen baseline `shape/<major>.<minor>.json`. A change to the shape of a response
without the matching version bump fails the test suite.

The server speaks exactly one contract version. Serving two versions side by side is out of scope.

<a id="handshake"></a>

## Handshake

The handshake is the `contract` member of the `GET /api/session` response: `{ major, minor, capabilities }`. It is
served even when the estate bundle failed to load, so a client can always tell whether it is compatible.

A client declares `{ major, minMinor }`, where `minMinor` is the lowest minor version whose additions the client uses.

The client then applies this decision table from top to bottom. The first matching row wins.

| # | Condition | Outcome | Update |
|---|---|---|---|
| 1 | the session response has no `contract` member | `server-too-old` | server |
| 2 | `server.major > client.major` | `client-too-old` | client |
| 3 | `server.major < client.major` | `server-too-old` | server |
| 4 | `server.minor < client.minMinor` | `server-too-old` | server |
| 5 | otherwise | `compatible` | — |

On `client-too-old` or `server-too-old` a client must stop: show the incompatible state, say
which side must be updated, and show no monitoring data.

**Capabilities.** `contract.capabilities` lists the optional features the server can provide right now. A capability
is listed only while the feature is available. Contract 1.1 defines one capability, `push`. It is listed only while the
server can accept pairing and registration right now, and is absent when push is not configured or is misconfigured. A
client shows push features, and calls the push operations, only while `push` is listed. A client must hide any feature
whose capability is absent, and must ignore capability names it does not know.

The session's top-level `capabilities` object is a different thing: it holds the per-identity write permissions and
keeps that meaning.

The `handshake` fixtures pin every row of the decision table (see [Fixtures](#fixtures)).

<a id="announcing"></a>

## Announcing the client

On `GET /api/session` a client may send two request headers:

- `X-Pulse-Client: <name>`, where the name matches `^[a-z0-9-]{1,32}$`. The first-party names are `ios` and
  `ios-widget`.
- `X-Pulse-Contract: <major>.<minMinor>`, the client's requirement, matching `CONTRACT_VERSION_PATTERN`
  (`^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$`).

Announcing is optional. A missing, malformed, oversized or repeated value is ignored and the request is served
normally. It is never an error.

Announced values feed only bounded operator metrics. They never affect access or the content of a response.

<a id="tolerance"></a>

## Tolerance rules

A client must:

- ignore unknown object members anywhere in a response or an event;
- ignore unknown entries in `contract.capabilities`;
- ignore SSE events whose `event` name is not `tick`;
- ignore unknown keys in `LiveTick.identities` (the `view-id` fallback);
- ignore unknown connect-link parameters;
- treat an unknown enum value as the [Enum fallbacks](#enum-fallbacks) table says.

The web client bundled with the server is always the same build as the server and is exempt from
these rules. Its validators stay strict. The rules bind every separately installed client.

<a id="operations"></a>

## Operations

Every contract operation is a `GET`. The table lists each one with its parameters, statuses, errors and caching.

<!-- generated:operations -->
| Operation | Method | Path | Auth | Parameters | Request body | Success | Errors | Caching | Response |
|---|---|---|---|---|---|---|---|---|---|
| Session | `GET` | `/api/session` | none | `X-Pulse-Client` (header, optional): client name, lower-case letters, digits and hyphens, 1 to 32 characters; ignored when malformed<br>`X-Pulse-Contract` (header, optional): the client's `<major>.<minMinor>`; ignored when malformed | none | 200 | `400` `INVALID_REQUEST`: query string over 2048 bytes, a repeated query key, or a malformed/over-512-byte path parameter<br>`500` `INTERNAL_ERROR`: unexpected server fault | `private, no-store` | [`SessionPayload`](#fields-sessionpayload) |
| Overview | `GET` | `/api/overview` | none | none | none | 200, 304 | `400` `INVALID_REQUEST`: query string over 2048 bytes, a repeated query key, or a malformed/over-512-byte path parameter<br>`500` `INTERNAL_ERROR`: unexpected server fault<br>`503` `ESTATE_BUNDLE_*` (BundleErrorBody): the estate bundle failed to load<br>`503` `NOT_READY`: before the first cycle is published | ETag + If-None-Match → 304; `private, no-cache`; Vary: Accept-Encoding | [`OverviewSnapshotV2`](#fields-overviewsnapshotv2) |
| Alerts | `GET` | `/api/alerts` | none | none | none | 200, 304 | `400` `INVALID_REQUEST`: query string over 2048 bytes, a repeated query key, or a malformed/over-512-byte path parameter<br>`500` `INTERNAL_ERROR`: unexpected server fault<br>`503` `ESTATE_BUNDLE_*` (BundleErrorBody): the estate bundle failed to load<br>`503` `NOT_READY`: before the first cycle is published | ETag + If-None-Match → 304; `private, no-cache`; Vary: Accept-Encoding | [`AlertsPayload`](#fields-alertspayload) |
| Estate | `GET` | `/api/estate` | none | none | none | 200, 304 | `400` `INVALID_REQUEST`: query string over 2048 bytes, a repeated query key, or a malformed/over-512-byte path parameter<br>`500` `INTERNAL_ERROR`: unexpected server fault<br>`503` `ESTATE_BUNDLE_*` (BundleErrorBody): the estate bundle failed to load<br>`503` `NOT_READY`: before the first cycle is published | ETag + If-None-Match → 304; `private, no-cache`; Vary: Accept-Encoding | [`EstatePayload`](#fields-estatepayload) |
| Timeline | `GET` | `/api/timeline` | none | none | none | 200, 304 | `400` `INVALID_REQUEST`: query string over 2048 bytes, a repeated query key, or a malformed/over-512-byte path parameter<br>`500` `INTERNAL_ERROR`: unexpected server fault<br>`503` `ESTATE_BUNDLE_*` (BundleErrorBody): the estate bundle failed to load<br>`503` `NOT_READY`: before the first cycle is published | ETag + If-None-Match → 304; `private, no-cache`; Vary: Accept-Encoding | [`TimelinePayload`](#fields-timelinepayload) |
| Estate history | `GET` | `/api/history/estate/:queryId` | none | `queryId` (path, required): `estate.liveness`, `alerts.firing`, `engine.ingestion-rate`, `engine.active-series`, `engine.disk-usage`, `engine.notification-failures`, `engine.notification-latency`<br>`range` (query, optional): `1h`, `6h`, `24h`, `7d`; default: the query's default range; no other query key is accepted | none | 200 | `400` `INVALID_REQUEST`: query string over 2048 bytes, a repeated query key, or a malformed/over-512-byte path parameter<br>`400` `INVALID_REQUEST`: a `range` value outside the allowed ids, or any query key other than `range`<br>`404` `QUERY_NOT_FOUND`: unknown `queryId`<br>`404` `TARGET_NOT_FOUND`: no target or endpoint with that exact id in the current estate<br>`422` `QUERY_NOT_APPLICABLE`: the query does not apply to that kind of target<br>`422` `RANGE_UNSUPPORTED`: the range is longer than the query supports<br>`500` `INTERNAL_ERROR`: unexpected server fault<br>`502` `HISTORY_LIMIT_EXCEEDED`: the result exceeds a history maximum<br>`502` `SOURCE_UNAVAILABLE`: the upstream metrics or checks source failed<br>`503` `ESTATE_BUNDLE_*` (BundleErrorBody): the estate bundle failed to load<br>`503` `HISTORY_CANCELLED`: the request was cancelled before it finished<br>`503` `HISTORY_OVERLOADED`: too many history requests are in progress [Retry-After]<br>`503` `MODEL_CHANGED`: the estate model changed while the query ran<br>`504` `SOURCE_TIMEOUT`: the upstream source timed out | always 200, no ETag; `private, no-cache` | [`HistoryPayload`](#fields-historypayload) |
| Target history | `GET` | `/api/history/target/:drilldownId/:queryId` | none | `drilldownId` (path, required): exact drilldown id from overview or estate; may contain an encoded slash (`%2F`)<br>`queryId` (path, required): `estate.liveness`, `host.cpu.utilization`, `host.memory.utilization`, `host.disk.utilization`, `host.load.1m`, `service.deep-health`, `service.backup-age`, `endpoint.check.latency`<br>`range` (query, optional): `1h`, `6h`, `24h`, `7d`; default: the query's default range; no other query key is accepted | none | 200 | `400` `INVALID_REQUEST`: query string over 2048 bytes, a repeated query key, or a malformed/over-512-byte path parameter<br>`400` `INVALID_REQUEST`: a `range` value outside the allowed ids, or any query key other than `range`<br>`404` `QUERY_NOT_FOUND`: unknown `queryId`<br>`404` `TARGET_NOT_FOUND`: no target or endpoint with that exact id in the current estate<br>`422` `QUERY_NOT_APPLICABLE`: the query does not apply to that kind of target<br>`422` `RANGE_UNSUPPORTED`: the range is longer than the query supports<br>`500` `INTERNAL_ERROR`: unexpected server fault<br>`502` `HISTORY_LIMIT_EXCEEDED`: the result exceeds a history maximum<br>`502` `SOURCE_UNAVAILABLE`: the upstream metrics or checks source failed<br>`503` `ESTATE_BUNDLE_*` (BundleErrorBody): the estate bundle failed to load<br>`503` `HISTORY_CANCELLED`: the request was cancelled before it finished<br>`503` `HISTORY_OVERLOADED`: too many history requests are in progress [Retry-After]<br>`503` `MODEL_CHANGED`: the estate model changed while the query ran<br>`504` `SOURCE_TIMEOUT`: the upstream source timed out | always 200, no ETag; `private, no-cache` | [`HistoryPayload`](#fields-historypayload) |
| Alert history | `GET` | `/api/history/alerts` | none | `range` (query, optional): `1h`, `6h`, `24h`, `7d`; default: `6h`; no other query key is accepted | none | 200 | `400` `INVALID_REQUEST`: query string over 2048 bytes, a repeated query key, or a malformed/over-512-byte path parameter<br>`400` `INVALID_REQUEST`: a `range` value outside the allowed ids, or any query key other than `range`<br>`404` `QUERY_NOT_FOUND`: unknown `queryId`<br>`404` `TARGET_NOT_FOUND`: no target or endpoint with that exact id in the current estate<br>`422` `QUERY_NOT_APPLICABLE`: the query does not apply to that kind of target<br>`422` `RANGE_UNSUPPORTED`: the range is longer than the query supports<br>`500` `INTERNAL_ERROR`: unexpected server fault<br>`502` `HISTORY_LIMIT_EXCEEDED`: the result exceeds a history maximum<br>`502` `SOURCE_UNAVAILABLE`: the upstream metrics or checks source failed<br>`503` `ESTATE_BUNDLE_*` (BundleErrorBody): the estate bundle failed to load<br>`503` `HISTORY_CANCELLED`: the request was cancelled before it finished<br>`503` `HISTORY_OVERLOADED`: too many history requests are in progress [Retry-After]<br>`503` `MODEL_CHANGED`: the estate model changed while the query ran<br>`504` `SOURCE_TIMEOUT`: the upstream source timed out | always 200, no ETag; `private, no-cache` | [`IntervalHistoryPayload`](#fields-intervalhistorypayload) |
| Check history | `GET` | `/api/history/checks/:endpoint` | none | `endpoint` (path, required): exact Gatus endpoint name; may contain an encoded slash (`%2F`)<br>`range` (query, optional): `1h`, `6h`, `24h`, `7d`; default: `24h`; no other query key is accepted | none | 200 | `400` `INVALID_REQUEST`: query string over 2048 bytes, a repeated query key, or a malformed/over-512-byte path parameter<br>`400` `INVALID_REQUEST`: a `range` value outside the allowed ids, or any query key other than `range`<br>`404` `QUERY_NOT_FOUND`: unknown `queryId`<br>`404` `TARGET_NOT_FOUND`: no target or endpoint with that exact id in the current estate<br>`422` `QUERY_NOT_APPLICABLE`: the query does not apply to that kind of target<br>`422` `RANGE_UNSUPPORTED`: the range is longer than the query supports<br>`500` `INTERNAL_ERROR`: unexpected server fault<br>`502` `HISTORY_LIMIT_EXCEEDED`: the result exceeds a history maximum<br>`502` `SOURCE_UNAVAILABLE`: the upstream metrics or checks source failed<br>`503` `ESTATE_BUNDLE_*` (BundleErrorBody): the estate bundle failed to load<br>`503` `HISTORY_CANCELLED`: the request was cancelled before it finished<br>`503` `HISTORY_OVERLOADED`: too many history requests are in progress [Retry-After]<br>`503` `MODEL_CHANGED`: the estate model changed while the query ran<br>`504` `SOURCE_TIMEOUT`: the upstream source timed out | always 200, no ETag; `private, no-cache` | [`EndpointHistoryPayload`](#fields-endpointhistorypayload) |
| Live events | `GET` | `/api/events` (SSE) | none | `Last-Event-ID` (header, optional): the `id` of the last tick received | none | 200 | `400` `INVALID_REQUEST`: query string over 2048 bytes, a repeated query key, or a malformed/over-512-byte path parameter<br>`500` `INTERNAL_ERROR`: unexpected server fault | `no-cache` (event stream) | [`LiveTick`](#fields-livetick) |
| Redeem pairing token | `POST` | `/api/push/pairings/redeem` | pairing token (body `token`) | none | [`PairingRedeemRequest`](#fields-pairingredeemrequest) | 201 | `400` `INVALID_REQUEST`: the media type is not `application/json`, the body is not valid JSON, or it fails validation (unknown member, missing member, bad value)<br>`403` `PAIRING_REFUSED`: the token is missing, malformed, unknown, expired or already used; the response does not say which<br>`405` `METHOD_NOT_ALLOWED`: push is not configured on this server (the `push` capability is absent)<br>`409` `DEVICE_CAP_REACHED`: the server's paired-device limit is reached; an operator must revoke a device first<br>`413` `PAYLOAD_TOO_LARGE`: the body is over 4096 bytes<br>`429` `RATE_LIMITED`: too many failed redemptions recently; every outstanding token was invalidated [Retry-After]<br>`500` `INTERNAL_ERROR`: unexpected server fault<br>`503` `PUSH_UNAVAILABLE`: push is configured but unavailable (misconfigured, or the device registry cannot be written) | `private, no-store` | [`PairingRedeemResponse`](#fields-pairingredeemresponse) |
| Register device | `PUT` | `/api/push/device` | `Authorization: Bearer <credential>` | none | [`DeviceRegistrationRequest`](#fields-deviceregistrationrequest) | 200 | `400` `INVALID_REQUEST`: the media type is not `application/json`, the body is not valid JSON, or it fails validation (unknown member, missing member, bad value)<br>`401` `UNAUTHORIZED`: the `Authorization` header is missing, repeated or malformed, or the credential is unknown or revoked; the response does not say which<br>`405` `METHOD_NOT_ALLOWED`: push is not configured on this server (the `push` capability is absent)<br>`413` `PAYLOAD_TOO_LARGE`: the body is over 4096 bytes<br>`500` `INTERNAL_ERROR`: unexpected server fault<br>`503` `PUSH_UNAVAILABLE`: push is configured but unavailable (misconfigured, or the device registry cannot be written) | `private, no-store` | [`DeviceRegistrationResponse`](#fields-deviceregistrationresponse) |
| Remove device | `DELETE` | `/api/push/device` | `Authorization: Bearer <credential>` | none | none | 204 | `401` `UNAUTHORIZED`: the `Authorization` header is missing, repeated or malformed, or the credential is unknown or revoked; the response does not say which<br>`405` `METHOD_NOT_ALLOWED`: push is not configured on this server (the `push` capability is absent)<br>`500` `INTERNAL_ERROR`: unexpected server fault<br>`503` `PUSH_UNAVAILABLE`: push is configured but unavailable (misconfigured, or the device registry cannot be written) | `private, no-store` | none (204) |

- **Session:** Served even when the estate bundle failed to load. Unknown query keys are ignored.
- **Overview:** Before the first cycle, the server may answer 200 with the same body type and no `ETag`, `X-Pulse-*` or `Vary` headers.
- **Live events:** The response is `text/event-stream`. The server sends `retry: 10000` on connect and a heartbeat comment every 5000 ms, and keeps at most 64 streams open.
- **Live events:** There is no `NOT_READY` response: before the first publication the stream opens and sends only `retry` and heartbeats.
- **Redeem pairing token:** The body is `Content-Type: application/json`, at most 4096 bytes. `displayName` is 1 to 64 UTF-8 bytes after trimming, from letters, digits, space and `'’.-_()#`.
- **Redeem pairing token:** `credential` appears in this response only. Store it in the Keychain; never log, display or send it anywhere except the `Authorization` header of the device operations.
- **Redeem pairing token:** A token is valid for 10 minutes and can be redeemed once. A server restart invalidates it.
- **Register device:** The body is `Content-Type: application/json`, at most 4096 bytes. Every member is required; a request replaces the APNs token, environment and preferences.
- **Register device:** Refresh the registration at least every 30 days whenever the app runs, including background launches. A device not seen for 90 days is removed.
- **Register device:** On `401 UNAUTHORIZED`, discard the stored credential and show that the device must be paired again. Do not retry with the same credential.
- **Remove device:** No request body. On 204 the credential is invalidated and nothing more is sent to the device; discard it.
<!-- /generated:operations -->

Paths use `:name` for path parameters, percent-encoded. Error bodies are `ErrorEnvelope` `{code, message, details?}`
unless marked `BundleErrorBody`. A client must branch on `code`, never on `message`.

<a id="fields"></a>

## Response fields

Each table below lists every field of one response type.

- **Field** is the path from the root of the response. `[]` is an array element, `{}` is a map value, `[n]` is a tuple
  slot, and `(field=value)` marks fields that exist only in one variant of a discriminated union.
- **Type** is the JSON type. `enum` is a closed set of strings, `constant` is a single fixed value, `map` is an object
  with arbitrary keys, and `string (pattern)` is a string with a fixed format.
- **Optional** says whether the member may be absent. **Nullable** says whether its value may be `null`.
- **Values** lists the known members of an enum or constant, and names the [Enum fallbacks](#enum-fallbacks) group that
  says how to treat an unknown member.

`EstatePayload.estate` (the `WebEstateModelV2` model) is expanded in full. A response may carry fields beyond those
listed here, and a client must ignore them (see [Tolerance rules](#tolerance)).

<a id="fields-sessionpayload"></a>

### SessionPayload

<!-- generated:fields:SessionPayload -->
| Field | Type | Optional | Nullable | Values |
|---|---|---|---|---|
| `authMode` | enum | no | no | `none`, `proxy-header` (unknown: see `auth-mode`) |
| `capabilities` | object | no | no |  |
| `capabilities.ack` | boolean | no | no |  |
| `capabilities.proposeEstateEdit` | boolean | no | no |  |
| `capabilities.silence` | boolean | no | no |  |
| `contract` | object | no | no |  |
| `contract.capabilities` | array | no | no |  |
| `contract.capabilities[]` | string | no | no |  |
| `contract.major` | number | no | no |  |
| `contract.minor` | number | no | no |  |
| `identity` | object | no | yes |  |
| `identity.displayName` | string | no | no |  |
| `identity.source` | constant | no | no | `proxy-header` |
| `identity.subject` | string | no | no |  |
<!-- /generated:fields:SessionPayload -->

<a id="fields-overviewsnapshotv2"></a>

### OverviewSnapshotV2

<!-- generated:fields:OverviewSnapshotV2 -->
| Field | Type | Optional | Nullable | Values |
|---|---|---|---|---|
| `alertCounts` | object | no | no |  |
| `alertCounts.firing` | number | no | no |  |
| `alertCounts.inhibited` | number | no | no |  |
| `alertCounts.silenced` | number | no | no |  |
| `alerts` | array | no | no |  |
| `alerts[]` | object | no | no |  |
| `alerts[].acked` | constant | yes | no | `true` |
| `alerts[].fingerprint` | string | no | no |  |
| `alerts[].name` | string | no | no |  |
| `alerts[].severity` | enum | no | no | `critical`, `info`, `warning` (unknown: see `overview-severity`) |
| `alerts[].startsAt` | string | no | no |  |
| `alerts[].summary` | string | yes | no |  |
| `alerts[].target` | object | no | yes |  |
| `alerts[].target.id` | string | no | no |  |
| `alerts[].target.kind` | enum | no | no | `endpoint`, `host`, `service` (unknown: see `target-kind`) |
| `appVersion` | string | no | no |  |
| `coverage` | object | no | no |  |
| `coverage.availability` | object | no | no |  |
| `coverage.availability.lastGoodAt` | string | no | yes |  |
| `coverage.availability.message` | string | no | yes |  |
| `coverage.availability.source` | enum | no | no | `alertmanager-alerts`, `alertmanager-receivers`, `alertmanager-silences`, `alertmanager-status`, `gatus-statuses`, `grafana-health`, `rendered-estate`, `victoriametrics-buildinfo`, `victoriametrics-signals`, `victoriametrics-targets`, `vmalert-rules` (unknown: see `source-id`) |
| `coverage.availability.state` | enum | no | no | `current`, `not-configured`, `stale`, `unavailable` (unknown: see `availability-state`) |
| `coverage.value` | object | no | yes |  |
| `coverage.value.covered` | number | no | no |  |
| `coverage.value.extras` | number | no | no |  |
| `coverage.value.gaps` | number | no | no |  |
| `engine` | object | no | no |  |
| `engine.availability` | object | no | no |  |
| `engine.availability.lastGoodAt` | string | no | yes |  |
| `engine.availability.message` | string | no | yes |  |
| `engine.availability.source` | enum | no | no | `alertmanager-alerts`, `alertmanager-receivers`, `alertmanager-silences`, `alertmanager-status`, `gatus-statuses`, `grafana-health`, `rendered-estate`, `victoriametrics-buildinfo`, `victoriametrics-signals`, `victoriametrics-targets`, `vmalert-rules` (unknown: see `source-id`) |
| `engine.availability.state` | enum | no | no | `current`, `not-configured`, `stale`, `unavailable` (unknown: see `availability-state`) |
| `engine.value` | object | no | yes |  |
| `engine.value.ok` | boolean | no | no |  |
| `engine.value.problems` | array | yes | no |  |
| `engine.value.problems[]` | string | no | no |  |
| `estate` | object | no | no |  |
| `estate.name` | string | no | no |  |
| `estate.timezone` | string | no | no |  |
| `estate.tzFallback` | boolean | no | no |  |
| `generatedAt` | string | no | no |  |
| `hosts` | array | no | no |  |
| `hosts[]` | object | no | no |  |
| `hosts[].activeAlerts` | array | no | no |  |
| `hosts[].activeAlerts[]` | object | no | no |  |
| `hosts[].activeAlerts[].acked` | constant | yes | no | `true` |
| `hosts[].activeAlerts[].fingerprint` | string | no | no |  |
| `hosts[].activeAlerts[].name` | string | no | no |  |
| `hosts[].activeAlerts[].severity` | enum | no | no | `critical`, `info`, `warning` (unknown: see `overview-severity`) |
| `hosts[].activeAlerts[].startsAt` | string | no | no |  |
| `hosts[].activeAlerts[].summary` | string | yes | no |  |
| `hosts[].activeAlerts[].target` | object | no | yes |  |
| `hosts[].activeAlerts[].target.id` | string | no | no |  |
| `hosts[].activeAlerts[].target.kind` | enum | no | no | `endpoint`, `host`, `service` (unknown: see `target-kind`) |
| `hosts[].addresses` | array | no | no |  |
| `hosts[].addresses[]` | string | no | no |  |
| `hosts[].checks` | array | no | no |  |
| `hosts[].checks[]` | object | no | no |  |
| `hosts[].checks[].endpoint` | string | no | no |  |
| `hosts[].checks[].lastEvaluatedAt` | string | no | no |  |
| `hosts[].checks[].responseTimeMs` | number | yes | no |  |
| `hosts[].checks[].success` | boolean | no | no |  |
| `hosts[].collectionClass` | enum | no | no | `excluded`, `hypervisor-api`, `managed-linux`, `nas-api`, `probe-only` (unknown: see `collection-class`) |
| `hosts[].drilldownId` | string | no | no |  |
| `hosts[].grafana` | object | no | yes |  |
| `hosts[].grafana.boardUid` | string | no | no |  |
| `hosts[].grafana.url` | string | no | no |  |
| `hosts[].live` | boolean | no | yes |  |
| `hosts[].name` | string | no | no |  |
| `hosts[].rollup` | enum | no | no | `critical`, `ok`, `suppressed`, `unknown`, `warning` (unknown: see `target-status`) |
| `hosts[].rollupEvidence` | object | no | no |  |
| `hosts[].rollupEvidence.availability` | object | no | no |  |
| `hosts[].rollupEvidence.availability.lastGoodAt` | string | no | yes |  |
| `hosts[].rollupEvidence.availability.message` | string | no | yes |  |
| `hosts[].rollupEvidence.availability.source` | enum | no | no | `alertmanager-alerts`, `alertmanager-receivers`, `alertmanager-silences`, `alertmanager-status`, `gatus-statuses`, `grafana-health`, `rendered-estate`, `victoriametrics-buildinfo`, `victoriametrics-signals`, `victoriametrics-targets`, `vmalert-rules` (unknown: see `source-id`) |
| `hosts[].rollupEvidence.availability.state` | enum | no | no | `current`, `not-configured`, `stale`, `unavailable` (unknown: see `availability-state`) |
| `hosts[].rollupEvidence.status` | enum | no | no | `critical`, `ok`, `suppressed`, `unknown`, `warning` (unknown: see `target-status`) |
| `hosts[].services` | array | no | no |  |
| `hosts[].services[]` | object | no | no |  |
| `hosts[].services[].activeAlerts` | array | no | no |  |
| `hosts[].services[].activeAlerts[]` | object | no | no |  |
| `hosts[].services[].activeAlerts[].acked` | constant | yes | no | `true` |
| `hosts[].services[].activeAlerts[].fingerprint` | string | no | no |  |
| `hosts[].services[].activeAlerts[].name` | string | no | no |  |
| `hosts[].services[].activeAlerts[].severity` | enum | no | no | `critical`, `info`, `warning` (unknown: see `overview-severity`) |
| `hosts[].services[].activeAlerts[].startsAt` | string | no | no |  |
| `hosts[].services[].activeAlerts[].summary` | string | yes | no |  |
| `hosts[].services[].activeAlerts[].target` | object | no | yes |  |
| `hosts[].services[].activeAlerts[].target.id` | string | no | no |  |
| `hosts[].services[].activeAlerts[].target.kind` | enum | no | no | `endpoint`, `host`, `service` (unknown: see `target-kind`) |
| `hosts[].services[].checks` | array | no | no |  |
| `hosts[].services[].checks[]` | object | no | no |  |
| `hosts[].services[].checks[].endpoint` | string | no | no |  |
| `hosts[].services[].checks[].lastEvaluatedAt` | string | no | no |  |
| `hosts[].services[].checks[].responseTimeMs` | number | yes | no |  |
| `hosts[].services[].checks[].success` | boolean | no | no |  |
| `hosts[].services[].deepHealth` | boolean | no | no |  |
| `hosts[].services[].drilldownId` | string | no | no |  |
| `hosts[].services[].grafana` | object | no | yes |  |
| `hosts[].services[].grafana.boardUid` | string | no | no |  |
| `hosts[].services[].grafana.url` | string | no | no |  |
| `hosts[].services[].host` | string | no | no |  |
| `hosts[].services[].ingressUrl` | string | yes | no |  |
| `hosts[].services[].live` | boolean | no | yes |  |
| `hosts[].services[].managed` | boolean | no | no |  |
| `hosts[].services[].name` | string | no | no |  |
| `hosts[].services[].status` | enum | no | no | `critical`, `ok`, `suppressed`, `unknown`, `warning` (unknown: see `target-status`) |
| `hosts[].services[].statusEvidence` | object | no | no |  |
| `hosts[].services[].statusEvidence.availability` | object | no | no |  |
| `hosts[].services[].statusEvidence.availability.lastGoodAt` | string | no | yes |  |
| `hosts[].services[].statusEvidence.availability.message` | string | no | yes |  |
| `hosts[].services[].statusEvidence.availability.source` | enum | no | no | `alertmanager-alerts`, `alertmanager-receivers`, `alertmanager-silences`, `alertmanager-status`, `gatus-statuses`, `grafana-health`, `rendered-estate`, `victoriametrics-buildinfo`, `victoriametrics-signals`, `victoriametrics-targets`, `vmalert-rules` (unknown: see `source-id`) |
| `hosts[].services[].statusEvidence.availability.state` | enum | no | no | `current`, `not-configured`, `stale`, `unavailable` (unknown: see `availability-state`) |
| `hosts[].services[].statusEvidence.status` | enum | no | no | `critical`, `ok`, `suppressed`, `unknown`, `warning` (unknown: see `target-status`) |
| `hosts[].services[].suppressed` | object | no | yes |  |
| `hosts[].services[].suppressed.class` | string | no | no |  |
| `hosts[].services[].suppressed.rationale` | string | no | no |  |
| `hosts[].status` | enum | no | no | `critical`, `ok`, `suppressed`, `unknown`, `warning` (unknown: see `target-status`) |
| `hosts[].statusEvidence` | object | no | no |  |
| `hosts[].statusEvidence.availability` | object | no | no |  |
| `hosts[].statusEvidence.availability.lastGoodAt` | string | no | yes |  |
| `hosts[].statusEvidence.availability.message` | string | no | yes |  |
| `hosts[].statusEvidence.availability.source` | enum | no | no | `alertmanager-alerts`, `alertmanager-receivers`, `alertmanager-silences`, `alertmanager-status`, `gatus-statuses`, `grafana-health`, `rendered-estate`, `victoriametrics-buildinfo`, `victoriametrics-signals`, `victoriametrics-targets`, `vmalert-rules` (unknown: see `source-id`) |
| `hosts[].statusEvidence.availability.state` | enum | no | no | `current`, `not-configured`, `stale`, `unavailable` (unknown: see `availability-state`) |
| `hosts[].statusEvidence.status` | enum | no | no | `critical`, `ok`, `suppressed`, `unknown`, `warning` (unknown: see `target-status`) |
| `hosts[].suppressed` | object | no | yes |  |
| `hosts[].suppressed.class` | string | no | no |  |
| `hosts[].suppressed.rationale` | string | no | no |  |
| `recentChecks` | array | no | no |  |
| `recentChecks[]` | object | no | no |  |
| `recentChecks[].durationMs` | number | no | yes |  |
| `recentChecks[].endpoint` | string | no | no |  |
| `recentChecks[].observedAt` | string | no | yes |  |
| `recentChecks[].success` | boolean | no | yes |  |
| `recentChecks[].target` | object | no | yes |  |
| `recentChecks[].target.id` | string | no | no |  |
| `recentChecks[].target.kind` | enum | no | no | `endpoint`, `host`, `service` (unknown: see `target-kind`) |
| `signals` | array | no | no |  |
| `signals[]` | object | no | no |  |
| `signals[].availability` | object | no | no |  |
| `signals[].availability.lastGoodAt` | string | no | yes |  |
| `signals[].availability.message` | string | no | yes |  |
| `signals[].availability.source` | enum | no | no | `alertmanager-alerts`, `alertmanager-receivers`, `alertmanager-silences`, `alertmanager-status`, `gatus-statuses`, `grafana-health`, `rendered-estate`, `victoriametrics-buildinfo`, `victoriametrics-signals`, `victoriametrics-targets`, `vmalert-rules` (unknown: see `source-id`) |
| `signals[].availability.state` | enum | no | no | `current`, `not-configured`, `stale`, `unavailable` (unknown: see `availability-state`) |
| `signals[].id` | string | no | no |  |
| `signals[].label` | string | no | no |  |
| `signals[].target` | object | no | no |  |
| `signals[].target.id` | string | no | no |  |
| `signals[].target.kind` | enum | no | no | `endpoint`, `host`, `service` (unknown: see `target-kind`) |
| `signals[].unit` | enum | no | no | `bytes`, `count`, `milliseconds`, `percent`, `scalar`, `seconds`, `state` (unknown: see `unit`) |
| `signals[].value` | boolean \| number \| string | no | yes |  |
| `sources` | object | no | no |  |
| `sources.alerts` | object | no | no |  |
| `sources.alerts.error` | string | no | yes |  |
| `sources.alerts.lastSuccess` | string | no | yes |  |
| `sources.alerts.ok` | boolean | no | no |  |
| `sources.checks` | object | no | no |  |
| `sources.checks.error` | string | no | yes |  |
| `sources.checks.lastSuccess` | string | no | yes |  |
| `sources.checks.ok` | boolean | no | no |  |
| `sources.metrics` | object | no | no |  |
| `sources.metrics.error` | string | no | yes |  |
| `sources.metrics.lastSuccess` | string | no | yes |  |
| `sources.metrics.ok` | boolean | no | no |  |
<!-- /generated:fields:OverviewSnapshotV2 -->

<a id="fields-alertspayload"></a>

### AlertsPayload

<!-- generated:fields:AlertsPayload -->
| Field | Type | Optional | Nullable | Values |
|---|---|---|---|---|
| `alertmanager` | object | no | no |  |
| `alertmanager.lastGoodAt` | string | no | yes |  |
| `alertmanager.message` | string | no | yes |  |
| `alertmanager.source` | enum | no | no | `alertmanager-alerts`, `alertmanager-receivers`, `alertmanager-silences`, `alertmanager-status`, `gatus-statuses`, `grafana-health`, `rendered-estate`, `victoriametrics-buildinfo`, `victoriametrics-signals`, `victoriametrics-targets`, `vmalert-rules` (unknown: see `source-id`) |
| `alertmanager.state` | enum | no | no | `current`, `not-configured`, `stale`, `unavailable` (unknown: see `availability-state`) |
| `alerts` | array | no | no |  |
| `alerts[]` | object | no | no |  |
| `alerts[].ack` | object | yes | no |  |
| `alerts[].ack.at` | string | no | no |  |
| `alerts[].ack.by` | string | no | no |  |
| `alerts[].ack.note` | string | no | yes |  |
| `alerts[].annotations` | map | no | no |  |
| `alerts[].annotations{}` | string | no | no |  |
| `alerts[].fingerprint` | string | no | no |  |
| `alerts[].group` | string | no | yes |  |
| `alerts[].historyRef` | object | no | yes |  |
| `alerts[].historyRef.queryId` | constant | no | no | `alerts.firing` |
| `alerts[].historyRef.target` | object | no | yes |  |
| `alerts[].historyRef.target.id` | string | no | no |  |
| `alerts[].historyRef.target.kind` | enum | no | no | `endpoint`, `host`, `service` (unknown: see `target-kind`) |
| `alerts[].inhibitedBy` | array | no | no |  |
| `alerts[].inhibitedBy[]` | string | no | no |  |
| `alerts[].labels` | map | no | no |  |
| `alerts[].labels{}` | string | no | no |  |
| `alerts[].name` | string | no | no |  |
| `alerts[].receivers` | array | no | no |  |
| `alerts[].receivers[]` | string | no | no |  |
| `alerts[].severity` | string | no | no |  |
| `alerts[].silencedBy` | array | no | no |  |
| `alerts[].silencedBy[]` | string | no | no |  |
| `alerts[].startsAt` | string | no | no |  |
| `alerts[].state` | enum | no | no | `firing`, `inhibited`, `silenced` (unknown: see `alert-state`) |
| `alerts[].target` | object | no | yes |  |
| `alerts[].target.id` | string | no | no |  |
| `alerts[].target.kind` | enum | no | no | `endpoint`, `host`, `service` (unknown: see `target-kind`) |
| `generatedAt` | string | no | no |  |
| `rules` | array | no | no |  |
| `rules[]` | object | no | no |  |
| `rules[].deadman` | boolean | no | no |  |
| `rules[].family` | string | no | no |  |
| `rules[].group` | string | no | no |  |
| `rules[].health` | enum | no | no | `healthy`, `unhealthy`, `unknown` (unknown: see `rule-health`) |
| `rules[].lastError` | string | no | yes |  |
| `rules[].lastEvaluationAt` | string | no | yes |  |
| `rules[].name` | string | no | no |  |
| `rules[].state` | string | no | no |  |
| `silences` | array | no | no |  |
| `silences[]` | object | no | no |  |
| `silences[].comment` | string | no | no |  |
| `silences[].createdBy` | string | no | no |  |
| `silences[].endsAt` | string | no | no |  |
| `silences[].id` | string | no | no |  |
| `silences[].matchers` | array | no | no |  |
| `silences[].matchers[]` | object | no | no |  |
| `silences[].matchers[].isEqual` | boolean | no | no |  |
| `silences[].matchers[].isRegex` | boolean | no | no |  |
| `silences[].matchers[].name` | string | no | no |  |
| `silences[].matchers[].value` | string | no | no |  |
| `silences[].startsAt` | string | no | no |  |
| `silences[].state` | enum | no | no | `active`, `expired`, `pending` (unknown: see `silence-state`) |
| `vmalert` | object | no | no |  |
| `vmalert.lastGoodAt` | string | no | yes |  |
| `vmalert.message` | string | no | yes |  |
| `vmalert.source` | enum | no | no | `alertmanager-alerts`, `alertmanager-receivers`, `alertmanager-silences`, `alertmanager-status`, `gatus-statuses`, `grafana-health`, `rendered-estate`, `victoriametrics-buildinfo`, `victoriametrics-signals`, `victoriametrics-targets`, `vmalert-rules` (unknown: see `source-id`) |
| `vmalert.state` | enum | no | no | `current`, `not-configured`, `stale`, `unavailable` (unknown: see `availability-state`) |
<!-- /generated:fields:AlertsPayload -->

<a id="fields-estatepayload"></a>

### EstatePayload

<!-- generated:fields:EstatePayload -->
| Field | Type | Optional | Nullable | Values |
|---|---|---|---|---|
| `coverage` | object | no | no |  |
| `coverage.availability` | object | no | no |  |
| `coverage.availability.lastGoodAt` | string | no | yes |  |
| `coverage.availability.message` | string | no | yes |  |
| `coverage.availability.source` | enum | no | no | `alertmanager-alerts`, `alertmanager-receivers`, `alertmanager-silences`, `alertmanager-status`, `gatus-statuses`, `grafana-health`, `rendered-estate`, `victoriametrics-buildinfo`, `victoriametrics-signals`, `victoriametrics-targets`, `vmalert-rules` (unknown: see `source-id`) |
| `coverage.availability.state` | enum | no | no | `current`, `not-configured`, `stale`, `unavailable` (unknown: see `availability-state`) |
| `coverage.value` | object | no | yes |  |
| `coverage.value.bundleId` | string (pattern) | no | no |  |
| `coverage.value.covered` | array | no | no |  |
| `coverage.value.covered[]` | object | no | no |  |
| `coverage.value.covered[].artifacts` | array | no | no |  |
| `coverage.value.covered[].artifacts[]` | string | no | no |  |
| `coverage.value.covered[].collectionClass` | enum | no | no | `excluded`, `hypervisor-api`, `managed-linux`, `nas-api`, `probe-only` (unknown: see `collection-class`) |
| `coverage.value.covered[].kind` | enum | no | no | `host`, `service` (unknown: see `coverage-kind`) |
| `coverage.value.covered[].name` | string | no | no |  |
| `coverage.value.covered[].suppressed` | object | no | yes |  |
| `coverage.value.covered[].suppressed.class` | enum | no | no | `excluded`, `expected-churn`, `known-expected` (unknown: see `suppression-class`) |
| `coverage.value.covered[].suppressed.rationale` | string | no | no |  |
| `coverage.value.formatVersion` | constant | no | no | `2` |
| `coverage.value.gaps` | array | no | no |  |
| `coverage.value.gaps[]` | object | no | no |  |
| `coverage.value.gaps[].artifacts` | array | no | no |  |
| `coverage.value.gaps[].artifacts[]` | string | no | no |  |
| `coverage.value.gaps[].collectionClass` | enum | no | no | `excluded`, `hypervisor-api`, `managed-linux`, `nas-api`, `probe-only` (unknown: see `collection-class`) |
| `coverage.value.gaps[].kind` | enum | no | no | `host`, `service` (unknown: see `coverage-kind`) |
| `coverage.value.gaps[].name` | string | no | no |  |
| `coverage.value.gaps[].suppressed` | object | no | yes |  |
| `coverage.value.gaps[].suppressed.class` | enum | no | no | `excluded`, `expected-churn`, `known-expected` (unknown: see `suppression-class`) |
| `coverage.value.gaps[].suppressed.rationale` | string | no | no |  |
| `coverage.value.suppressed` | array | no | no |  |
| `coverage.value.suppressed[]` | object | no | no |  |
| `coverage.value.suppressed[].artifacts` | array | no | no |  |
| `coverage.value.suppressed[].artifacts[]` | string | no | no |  |
| `coverage.value.suppressed[].collectionClass` | enum | no | no | `excluded`, `hypervisor-api`, `managed-linux`, `nas-api`, `probe-only` (unknown: see `collection-class`) |
| `coverage.value.suppressed[].kind` | enum | no | no | `host`, `service` (unknown: see `coverage-kind`) |
| `coverage.value.suppressed[].name` | string | no | no |  |
| `coverage.value.suppressed[].suppressed` | object | no | yes |  |
| `coverage.value.suppressed[].suppressed.class` | enum | no | no | `excluded`, `expected-churn`, `known-expected` (unknown: see `suppression-class`) |
| `coverage.value.suppressed[].suppressed.rationale` | string | no | no |  |
| `declaredVersusScraped` | object | no | no |  |
| `declaredVersusScraped.availability` | object | no | no |  |
| `declaredVersusScraped.availability.lastGoodAt` | string | no | yes |  |
| `declaredVersusScraped.availability.message` | string | no | yes |  |
| `declaredVersusScraped.availability.source` | enum | no | no | `alertmanager-alerts`, `alertmanager-receivers`, `alertmanager-silences`, `alertmanager-status`, `gatus-statuses`, `grafana-health`, `rendered-estate`, `victoriametrics-buildinfo`, `victoriametrics-signals`, `victoriametrics-targets`, `vmalert-rules` (unknown: see `source-id`) |
| `declaredVersusScraped.availability.state` | enum | no | no | `current`, `not-configured`, `stale`, `unavailable` (unknown: see `availability-state`) |
| `declaredVersusScraped.value` | array | no | yes |  |
| `declaredVersusScraped.value[]` | object | no | no |  |
| `declaredVersusScraped.value[].drilldownId` | string | no | no |  |
| `declaredVersusScraped.value[].health` | enum | yes | no | `down`, `unknown`, `up` (unknown: see `declared-scrape-health`) |
| `declaredVersusScraped.value[].job` | string | yes | no |  |
| `declaredVersusScraped.value[].message` | string | no | no |  |
| `declaredVersusScraped.value[].scrapeTarget` | string | no | yes |  |
| `declaredVersusScraped.value[].state` | enum | no | no | `engine`, `matched`, `missing`, `unexpected`, `unknown` (unknown: see `declared-scrape-state`) |
| `estate` | object | no | no |  |
| `estate.bundleId` | string (pattern) | no | no |  |
| `estate.channels` | array | no | no |  |
| `estate.channels[]` | object | no | no |  |
| `estate.channels[].credential` | object | no | no |  |
| `estate.channels[].credential.display` | string | no | no |  |
| `estate.channels[].credential.kind` | enum | no | no | `env`, `op` (unknown: see `credential-kind`) |
| `estate.channels[].kind` | enum | no | no | `chat`, `email`, `push`, `telegram`, `webhook` (unknown: see `channel-kind`) |
| `estate.channels[].name` | string | no | no |  |
| `estate.channels[].options` | map | no | yes |  |
| `estate.channels[].options{}` | boolean \| number \| string | no | no |  |
| `estate.channels[].provenance` | object | no | no |  |
| `estate.channels[].provenance.col` | number | no | no |  |
| `estate.channels[].provenance.file` | string | no | no |  |
| `estate.channels[].provenance.line` | number | no | no |  |
| `estate.channels[].provenance.path` | string | no | no |  |
| `estate.estate` | object | no | no |  |
| `estate.estate.deadman` | object | no | no |  |
| `estate.estate.deadman.configured` | boolean | no | no |  |
| `estate.estate.deadman.kind` | enum | no | no | `plain`, `secret-ref` (unknown: see `deadman-kind`) |
| `estate.estate.dnsResolver` | string | no | yes |  |
| `estate.estate.domains` | array | no | no |  |
| `estate.estate.domains[]` | string | no | no |  |
| `estate.estate.name` | string | no | no |  |
| `estate.estate.retention` | string | no | yes |  |
| `estate.estate.schemaMajor` | number | no | no |  |
| `estate.estate.timezone` | string | no | no |  |
| `estate.formatVersion` | constant | no | no | `2` |
| `estate.hosts` | array | no | no |  |
| `estate.hosts[]` | object | no | no |  |
| `estate.hosts[](collectionClass=excluded).detail` | object | no | no |  |
| `estate.hosts[](collectionClass=hypervisor-api).detail` | object | no | no |  |
| `estate.hosts[](collectionClass=hypervisor-api).detail.apiEndpoint` | string | no | no |  |
| `estate.hosts[](collectionClass=hypervisor-api).detail.credential` | object | no | no |  |
| `estate.hosts[](collectionClass=hypervisor-api).detail.credential.display` | string | no | no |  |
| `estate.hosts[](collectionClass=hypervisor-api).detail.credential.kind` | enum | no | no | `env`, `op` (unknown: see `credential-kind`) |
| `estate.hosts[](collectionClass=managed-linux).detail` | object | no | no |  |
| `estate.hosts[](collectionClass=managed-linux).detail.cadvisor` | boolean | no | no |  |
| `estate.hosts[](collectionClass=managed-linux).detail.commandSignals` | array | no | no |  |
| `estate.hosts[](collectionClass=managed-linux).detail.commandSignals[]` | object | no | no |  |
| `estate.hosts[](collectionClass=managed-linux).detail.commandSignals[](output=scalar).labels` | map | yes | no |  |
| `estate.hosts[](collectionClass=managed-linux).detail.commandSignals[](output=scalar).labels{}` | string | no | no |  |
| `estate.hosts[](collectionClass=managed-linux).detail.commandSignals[](output=scalar).metric` | string | no | no |  |
| `estate.hosts[](collectionClass=managed-linux).detail.commandSignals[](output=scalar).upMetric` | string | no | no |  |
| `estate.hosts[](collectionClass=managed-linux).detail.commandSignals[].command` | string | no | no |  |
| `estate.hosts[](collectionClass=managed-linux).detail.commandSignals[].credential` | object | no | yes |  |
| `estate.hosts[](collectionClass=managed-linux).detail.commandSignals[].credential.display` | string | no | no |  |
| `estate.hosts[](collectionClass=managed-linux).detail.commandSignals[].credential.kind` | enum | no | no | `env`, `op` (unknown: see `credential-kind`) |
| `estate.hosts[](collectionClass=managed-linux).detail.commandSignals[].interval` | string | no | no |  |
| `estate.hosts[](collectionClass=managed-linux).detail.commandSignals[].name` | string | no | no |  |
| `estate.hosts[](collectionClass=managed-linux).detail.commandSignals[].output` | enum | no | no | `exposition`, `scalar` (unknown: see `command-output`) |
| `estate.hosts[](collectionClass=managed-linux).detail.deliveryForm` | enum | no | no | `compose`, `systemd` (unknown: see `delivery-form`) |
| `estate.hosts[](collectionClass=managed-linux).detail.exporterPorts` | array | no | no |  |
| `estate.hosts[](collectionClass=managed-linux).detail.exporterPorts[]` | number | no | no |  |
| `estate.hosts[](collectionClass=managed-linux).detail.heartbeat` | boolean | no | no |  |
| `estate.hosts[](collectionClass=nas-api).detail` | object | no | no |  |
| `estate.hosts[](collectionClass=nas-api).detail.apiEndpoint` | string | no | yes |  |
| `estate.hosts[](collectionClass=nas-api).detail.credential` | object | no | yes |  |
| `estate.hosts[](collectionClass=nas-api).detail.credential.display` | string | no | no |  |
| `estate.hosts[](collectionClass=nas-api).detail.credential.kind` | enum | no | no | `env`, `op` (unknown: see `credential-kind`) |
| `estate.hosts[](collectionClass=probe-only).detail` | object | no | no |  |
| `estate.hosts[](collectionClass=probe-only).detail.probe` | object | no | no |  |
| `estate.hosts[](collectionClass=probe-only).detail.probe.expect` | string | no | yes |  |
| `estate.hosts[](collectionClass=probe-only).detail.probe.kind` | string | no | no |  |
| `estate.hosts[](collectionClass=probe-only).detail.probe.target` | string | no | no |  |
| `estate.hosts[].addresses` | array | no | no |  |
| `estate.hosts[].addresses[]` | string | no | no |  |
| `estate.hosts[].artifacts` | array | no | no |  |
| `estate.hosts[].artifacts[]` | string | no | no |  |
| `estate.hosts[].collectionClass` | enum | no | no | `excluded`, `hypervisor-api`, `managed-linux`, `nas-api`, `probe-only` (unknown: see `collection-class`) |
| `estate.hosts[].drilldownId` | string | no | no |  |
| `estate.hosts[].expectedChurn` | boolean | no | no |  |
| `estate.hosts[].name` | string | no | no |  |
| `estate.hosts[].provenance` | object | no | no |  |
| `estate.hosts[].provenance.col` | number | no | no |  |
| `estate.hosts[].provenance.file` | string | no | no |  |
| `estate.hosts[].provenance.line` | number | no | no |  |
| `estate.hosts[].provenance.path` | string | no | no |  |
| `estate.hosts[].scrapeIntervalClass` | string | no | yes |  |
| `estate.hosts[].scrapeTargets` | array | no | no |  |
| `estate.hosts[].scrapeTargets[]` | object | no | no |  |
| `estate.hosts[].scrapeTargets[].instance` | string | no | no |  |
| `estate.hosts[].scrapeTargets[].job` | string | no | no |  |
| `estate.hosts[].suppressed` | object | no | yes |  |
| `estate.hosts[].suppressed.class` | enum | no | no | `excluded`, `expected-churn`, `known-expected` (unknown: see `suppression-class`) |
| `estate.hosts[].suppressed.rationale` | string | no | no |  |
| `estate.routingOverrides` | array | no | no |  |
| `estate.routingOverrides[]` | object | no | no |  |
| `estate.routingOverrides[].channels` | array | no | no |  |
| `estate.routingOverrides[].channels[]` | string | no | no |  |
| `estate.routingOverrides[].provenance` | object | no | no |  |
| `estate.routingOverrides[].provenance.col` | number | no | no |  |
| `estate.routingOverrides[].provenance.file` | string | no | no |  |
| `estate.routingOverrides[].provenance.line` | number | no | no |  |
| `estate.routingOverrides[].provenance.path` | string | no | no |  |
| `estate.routingOverrides[].severity` | string | no | no |  |
| `estate.services` | array | no | no |  |
| `estate.services[]` | object | no | no |  |
| `estate.services[].alerts` | array | no | no |  |
| `estate.services[].alerts[]` | object | no | no |  |
| `estate.services[].alerts[].description` | string | yes | no |  |
| `estate.services[].alerts[].enabled` | boolean | yes | no |  |
| `estate.services[].alerts[].failureThreshold` | number | yes | no |  |
| `estate.services[].alerts[].sendOnResolved` | boolean | yes | no |  |
| `estate.services[].alerts[].successThreshold` | number | yes | no |  |
| `estate.services[].alerts[].type` | string | no | no |  |
| `estate.services[].artifacts` | array | no | no |  |
| `estate.services[].artifacts[]` | string | no | no |  |
| `estate.services[].backupFreshness` | object | no | yes |  |
| `estate.services[].backupFreshness.hasCommand` | boolean | no | no |  |
| `estate.services[].backupFreshness.interval` | string | no | no |  |
| `estate.services[].backupFreshness.signal` | string | no | no |  |
| `estate.services[].backupFreshness.threshold` | string | no | no |  |
| `estate.services[].deepHealth` | boolean | no | no |  |
| `estate.services[].deepHealthDetail` | object | no | yes |  |
| `estate.services[].deepHealthDetail.alertExpression` | string | no | no |  |
| `estate.services[].deepHealthDetail.credential` | object | no | yes |  |
| `estate.services[].deepHealthDetail.credential.display` | string | no | no |  |
| `estate.services[].deepHealthDetail.credential.kind` | enum | no | no | `env`, `op` (unknown: see `credential-kind`) |
| `estate.services[].deepHealthDetail.endpoint` | string | no | no |  |
| `estate.services[].deepHealthDetail.hostLocal` | boolean | no | no |  |
| `estate.services[].deepHealthDetail.metrics` | array | no | no |  |
| `estate.services[].deepHealthDetail.metrics[]` | string | no | no |  |
| `estate.services[].deepHealthDetail.responseMapping` | map | no | no |  |
| `estate.services[].deepHealthDetail.responseMapping{}` | string | no | no |  |
| `estate.services[].drilldownId` | string | no | no |  |
| `estate.services[].gatusEndpoints` | array | no | no |  |
| `estate.services[].gatusEndpoints[]` | string | no | no |  |
| `estate.services[].host` | string | no | no |  |
| `estate.services[].ingressUrl` | string | yes | no |  |
| `estate.services[].kind` | string | no | no |  |
| `estate.services[].managed` | boolean | no | no |  |
| `estate.services[].name` | string | no | no |  |
| `estate.services[].provenance` | object | no | no |  |
| `estate.services[].provenance.col` | number | no | no |  |
| `estate.services[].provenance.file` | string | no | no |  |
| `estate.services[].provenance.line` | number | no | no |  |
| `estate.services[].provenance.path` | string | no | no |  |
| `estate.services[].suppressed` | object | no | yes |  |
| `estate.services[].suppressed.class` | enum | no | no | `excluded`, `expected-churn`, `known-expected` (unknown: see `suppression-class`) |
| `estate.services[].suppressed.rationale` | string | no | no |  |
| `estate.suppressions` | array | no | no |  |
| `estate.suppressions[]` | object | no | no |  |
| `estate.suppressions[].class` | enum | no | no | `excluded`, `expected-churn`, `known-expected` (unknown: see `suppression-class`) |
| `estate.suppressions[].provenance` | object | no | no |  |
| `estate.suppressions[].provenance.col` | number | no | no |  |
| `estate.suppressions[].provenance.file` | string | no | no |  |
| `estate.suppressions[].provenance.line` | number | no | no |  |
| `estate.suppressions[].provenance.path` | string | no | no |  |
| `estate.suppressions[].rationale` | string | no | no |  |
| `estate.suppressions[].resolves` | array | no | no |  |
| `estate.suppressions[].resolves[]` | string | no | no |  |
| `estate.suppressions[].target` | string | no | no |  |
| `findings` | object | no | no |  |
| `findings.availability` | object | no | no |  |
| `findings.availability.lastGoodAt` | string | no | yes |  |
| `findings.availability.message` | string | no | yes |  |
| `findings.availability.source` | enum | no | no | `alertmanager-alerts`, `alertmanager-receivers`, `alertmanager-silences`, `alertmanager-status`, `gatus-statuses`, `grafana-health`, `rendered-estate`, `victoriametrics-buildinfo`, `victoriametrics-signals`, `victoriametrics-targets`, `vmalert-rules` (unknown: see `source-id`) |
| `findings.availability.state` | enum | no | no | `current`, `not-configured`, `stale`, `unavailable` (unknown: see `availability-state`) |
| `findings.value` | object | no | yes |  |
| `findings.value.bundleId` | string (pattern) | no | no |  |
| `findings.value.findings` | array | no | no |  |
| `findings.value.findings[]` | object | no | no |  |
| `findings.value.findings[].code` | enum | no | no | `backup_command_host`, `connect_link_no_address`, `connect_link_refused`, `duplicate_command_signal`, `duplicate_estate`, `duplicate_identity`, `gatus_unsafe_name`, `host_local_probe_host`, `incomplete_nas_api`, `inert_alert_binding`, `invalid_enum`, `invalid_hypervisor_endpoint`, `invalid_layer`, `invalid_timezone`, `malformed_yaml`, `missing_chat_id`, `missing_field`, `missing_rationale`, `missing_timezone`, `missing_version`, `proposal_already_decided`, `proposal_cannot_clear_base`, `proposal_dirty_tree`, `proposal_invalid_estate`, `proposal_not_found`, `proposal_overlay_ambiguous`, `proposal_signature_invalid`, `proposal_stale`, `push_device_not_found`, `push_misconfigured`, `push_no_devices`, `push_not_configured`, `push_operator_refused`, `push_operator_secret_missing`, `push_pair_no_address`, `push_server_missing`, `push_server_unreachable`, `push_test_failed`, `secret_literal`, `unknown_field`, `unresolved_channel`, `unresolved_host`, `unsupported_version`, `web_artifact_leak_detected`, `web_sensitive_channel_option_omitted`, `web_unsafe_provenance`, `web_url_userinfo_removed`, `wrong_type` (unknown: see `finding-code`) |
| `findings.value.findings[].file` | string | no | no |  |
| `findings.value.findings[].fix` | string | no | no |  |
| `findings.value.findings[].message` | string | no | no |  |
| `findings.value.findings[].path` | string | no | no |  |
| `findings.value.findings[].severity` | enum | no | no | `error`, `info`, `warning` (unknown: see `finding-severity`) |
| `findings.value.formatVersion` | constant | no | no | `2` |
| `generatedAt` | string | no | no |  |
| `liveTargets` | array | no | no |  |
| `liveTargets[]` | object | no | no |  |
| `liveTargets[].alertFingerprints` | array | no | no |  |
| `liveTargets[].alertFingerprints[]` | string | no | no |  |
| `liveTargets[].availability` | object | no | no |  |
| `liveTargets[].availability.lastGoodAt` | string | no | yes |  |
| `liveTargets[].availability.message` | string | no | yes |  |
| `liveTargets[].availability.source` | enum | no | no | `alertmanager-alerts`, `alertmanager-receivers`, `alertmanager-silences`, `alertmanager-status`, `gatus-statuses`, `grafana-health`, `rendered-estate`, `victoriametrics-buildinfo`, `victoriametrics-signals`, `victoriametrics-targets`, `vmalert-rules` (unknown: see `source-id`) |
| `liveTargets[].availability.state` | enum | no | no | `current`, `not-configured`, `stale`, `unavailable` (unknown: see `availability-state`) |
| `liveTargets[].name` | string | no | no |  |
| `liveTargets[].state` | enum | no | no | `healthy`, `not-configured`, `unhealthy`, `unknown` (unknown: see `health-state`) |
| `liveTargets[].target` | object | no | no |  |
| `liveTargets[].target.id` | string | no | no |  |
| `liveTargets[].target.kind` | enum | no | no | `endpoint`, `host`, `service` (unknown: see `target-kind`) |
<!-- /generated:fields:EstatePayload -->

<a id="fields-timelinepayload"></a>

### TimelinePayload

<!-- generated:fields:TimelinePayload -->
| Field | Type | Optional | Nullable | Values |
|---|---|---|---|---|
| `alertHistory` | object | no | no |  |
| `alertHistory.provenance` | constant | no | no | `vmalert` |
| `alertHistory.ranges` | array | no | no |  |
| `alertHistory.ranges[]` | enum | no | no | `1h`, `24h`, `6h`, `7d` (unknown: see `range-id`) |
| `checkHistory` | object | no | no |  |
| `checkHistory.endpoints` | array | no | no |  |
| `checkHistory.endpoints[]` | string | no | no |  |
| `checkHistory.provenance` | constant | no | no | `gatus` |
| `domains` | array | no | no |  |
| `domains[]` | object | no | no |  |
| `domains[].domain` | string | no | no |  |
| `domains[].endpoint` | string | no | no |  |
| `generatedAt` | string | no | no |  |
| `targets` | array | no | no |  |
| `targets[]` | object | no | no |  |
| `targets[].name` | string | no | no |  |
| `targets[].parent` | object | no | yes |  |
| `targets[].parent.id` | string | no | no |  |
| `targets[].parent.kind` | enum | no | no | `endpoint`, `host`, `service` (unknown: see `target-kind`) |
| `targets[].queryIds` | array | no | no |  |
| `targets[].queryIds[]` | enum | no | no | `alerts.firing`, `endpoint.check.latency`, `engine.active-series`, `engine.disk-usage`, `engine.ingestion-rate`, `engine.notification-failures`, `engine.notification-latency`, `estate.liveness`, `host.cpu.utilization`, `host.disk.utilization`, `host.load.1m`, `host.memory.utilization`, `service.backup-age`, `service.deep-health` (unknown: see `query-id`) |
| `targets[].ranges` | array | no | no |  |
| `targets[].ranges[]` | enum | no | no | `1h`, `24h`, `6h`, `7d` (unknown: see `range-id`) |
| `targets[].target` | object | no | no |  |
| `targets[].target.id` | string | no | no |  |
| `targets[].target.kind` | enum | no | no | `endpoint`, `host`, `service` (unknown: see `target-kind`) |
<!-- /generated:fields:TimelinePayload -->

<a id="fields-historypayload"></a>

### HistoryPayload

<!-- generated:fields:HistoryPayload -->
| Field | Type | Optional | Nullable | Values |
|---|---|---|---|---|
| `effectiveStepSeconds` | number | no | no |  |
| `fetchedAt` | string | no | no |  |
| `queryId` | enum | no | no | `alerts.firing`, `endpoint.check.latency`, `engine.active-series`, `engine.disk-usage`, `engine.ingestion-rate`, `engine.notification-failures`, `engine.notification-latency`, `estate.liveness`, `host.cpu.utilization`, `host.disk.utilization`, `host.load.1m`, `host.memory.utilization`, `service.backup-age`, `service.deep-health` (unknown: see `query-id`) |
| `range` | enum | no | no | `1h`, `24h`, `6h`, `7d` (unknown: see `range-id`) |
| `series` | array | no | no |  |
| `series[]` | object | no | no |  |
| `series[].labels` | map | no | no |  |
| `series[].labels{}` | string | no | no |  |
| `series[].points` | array | no | no |  |
| `series[].points[]` | tuple | no | no |  |
| `series[].points[][0]` | number | no | no |  |
| `series[].points[][1]` | number | no | yes |  |
| `stale` | boolean | no | no |  |
| `target` | object | no | yes |  |
| `target.id` | string | no | no |  |
| `target.kind` | enum | no | no | `endpoint`, `host`, `service` (unknown: see `target-kind`) |
| `unit` | enum | no | no | `bytes`, `count`, `milliseconds`, `percent`, `scalar`, `seconds`, `state` (unknown: see `unit`) |
<!-- /generated:fields:HistoryPayload -->

<a id="fields-intervalhistorypayload"></a>

### IntervalHistoryPayload

<!-- generated:fields:IntervalHistoryPayload -->
| Field | Type | Optional | Nullable | Values |
|---|---|---|---|---|
| `effectiveStepSeconds` | number | no | no |  |
| `fetchedAt` | string | no | no |  |
| `lanes` | array | no | no |  |
| `lanes[]` | object | no | no |  |
| `lanes[].alertname` | string | no | no |  |
| `lanes[].attribution` | enum | no | no | `matched`, `unmatched` (unknown: see `attribution`) |
| `lanes[].id` | string (pattern) | no | no |  |
| `lanes[].intervals` | array | no | no |  |
| `lanes[].intervals[]` | object | no | no |  |
| `lanes[].intervals[].end` | string | no | no |  |
| `lanes[].intervals[].provenance` | enum | no | no | `gatus`, `vmalert` (unknown: see `provenance`) |
| `lanes[].intervals[].start` | string | no | no |  |
| `lanes[].intervals[].state` | enum | no | no | `failed`, `firing` (unknown: see `interval-state`) |
| `lanes[].labels` | object | no | no |  |
| `lanes[].labels.alertname` | string | no | yes |  |
| `lanes[].labels.host` | string | no | yes |  |
| `lanes[].labels.instance` | string | no | yes |  |
| `lanes[].labels.service` | string | no | yes |  |
| `lanes[].labels.severity` | string | no | yes |  |
| `lanes[].provenance` | constant | no | no | `vmalert` |
| `lanes[].severity` | enum | no | no | `critical`, `info`, `unknown`, `warning` (unknown: see `history-severity`) |
| `lanes[].target` | object | no | yes |  |
| `lanes[].target.id` | string | no | no |  |
| `lanes[].target.kind` | enum | no | no | `endpoint`, `host`, `service` (unknown: see `target-kind`) |
| `operation` | constant | no | no | `alert-intervals` |
| `range` | enum | no | no | `1h`, `24h`, `6h`, `7d` (unknown: see `range-id`) |
| `stale` | boolean | no | no |  |
| `target` | object | no | yes |  |
| `target.id` | string | no | no |  |
| `target.kind` | enum | no | no | `endpoint`, `host`, `service` (unknown: see `target-kind`) |
| `unit` | constant | no | no | `state` |
<!-- /generated:fields:IntervalHistoryPayload -->

<a id="fields-endpointhistorypayload"></a>

### EndpointHistoryPayload

<!-- generated:fields:EndpointHistoryPayload -->
| Field | Type | Optional | Nullable | Values |
|---|---|---|---|---|
| `effectiveStepSeconds` | number | no | yes |  |
| `endpoint` | string | no | no |  |
| `fetchedAt` | string | no | no |  |
| `incidents` | array | no | no |  |
| `incidents[]` | object | no | no |  |
| `incidents[].end` | string | no | no |  |
| `incidents[].provenance` | enum | no | no | `gatus`, `vmalert` (unknown: see `provenance`) |
| `incidents[].start` | string | no | no |  |
| `incidents[].state` | enum | no | no | `failed`, `firing` (unknown: see `interval-state`) |
| `operation` | constant | no | no | `endpoint-history` |
| `provenance` | constant | no | no | `gatus` |
| `range` | enum | no | no | `1h`, `24h`, `6h`, `7d` (unknown: see `range-id`) |
| `results` | array | no | no |  |
| `results[]` | object | no | no |  |
| `results[].durationMs` | number | no | yes |  |
| `results[].success` | boolean | no | no |  |
| `results[].timestamp` | string | no | no |  |
| `stale` | boolean | no | no |  |
| `target` | object | no | yes |  |
| `target.id` | string | no | no |  |
| `target.kind` | enum | no | no | `endpoint`, `host`, `service` (unknown: see `target-kind`) |
| `unit` | constant | no | no | `milliseconds` |
<!-- /generated:fields:EndpointHistoryPayload -->

<a id="fields-livetick"></a>

### LiveTick

<!-- generated:fields:LiveTick -->
| Field | Type | Optional | Nullable | Values |
|---|---|---|---|---|
| `identities` | object | no | no |  |
| `identities.alerts` | string (pattern) | no | no |  |
| `identities.engine` | string (pattern) | no | no |  |
| `identities.estate` | string (pattern) | no | no |  |
| `identities.overview` | string (pattern) | no | no |  |
| `identities.timeline` | string (pattern) | no | no |  |
| `observation` | object | no | no |  |
| `observation.appVersion` | string | no | no |  |
| `observation.generation` | string | no | no |  |
| `observation.observedAt` | string | no | no |  |
| `observation.seq` | number | no | no |  |
| `observation.sources` | object | no | no |  |
| `observation.sources.alertmanager-alerts` | object | no | no |  |
| `observation.sources.alertmanager-alerts.lastAttemptAt` | string | no | yes |  |
| `observation.sources.alertmanager-alerts.lastSuccess` | string | no | yes |  |
| `observation.sources.alertmanager-alerts.state` | enum | no | no | `current`, `not-configured`, `stale`, `unavailable` (unknown: see `availability-state`) |
| `observation.sources.alertmanager-receivers` | object | no | no |  |
| `observation.sources.alertmanager-receivers.lastAttemptAt` | string | no | yes |  |
| `observation.sources.alertmanager-receivers.lastSuccess` | string | no | yes |  |
| `observation.sources.alertmanager-receivers.state` | enum | no | no | `current`, `not-configured`, `stale`, `unavailable` (unknown: see `availability-state`) |
| `observation.sources.alertmanager-silences` | object | no | no |  |
| `observation.sources.alertmanager-silences.lastAttemptAt` | string | no | yes |  |
| `observation.sources.alertmanager-silences.lastSuccess` | string | no | yes |  |
| `observation.sources.alertmanager-silences.state` | enum | no | no | `current`, `not-configured`, `stale`, `unavailable` (unknown: see `availability-state`) |
| `observation.sources.alertmanager-status` | object | no | no |  |
| `observation.sources.alertmanager-status.lastAttemptAt` | string | no | yes |  |
| `observation.sources.alertmanager-status.lastSuccess` | string | no | yes |  |
| `observation.sources.alertmanager-status.state` | enum | no | no | `current`, `not-configured`, `stale`, `unavailable` (unknown: see `availability-state`) |
| `observation.sources.gatus-statuses` | object | no | no |  |
| `observation.sources.gatus-statuses.lastAttemptAt` | string | no | yes |  |
| `observation.sources.gatus-statuses.lastSuccess` | string | no | yes |  |
| `observation.sources.gatus-statuses.state` | enum | no | no | `current`, `not-configured`, `stale`, `unavailable` (unknown: see `availability-state`) |
| `observation.sources.grafana-health` | object | no | no |  |
| `observation.sources.grafana-health.lastAttemptAt` | string | no | yes |  |
| `observation.sources.grafana-health.lastSuccess` | string | no | yes |  |
| `observation.sources.grafana-health.state` | enum | no | no | `current`, `not-configured`, `stale`, `unavailable` (unknown: see `availability-state`) |
| `observation.sources.victoriametrics-buildinfo` | object | no | no |  |
| `observation.sources.victoriametrics-buildinfo.lastAttemptAt` | string | no | yes |  |
| `observation.sources.victoriametrics-buildinfo.lastSuccess` | string | no | yes |  |
| `observation.sources.victoriametrics-buildinfo.state` | enum | no | no | `current`, `not-configured`, `stale`, `unavailable` (unknown: see `availability-state`) |
| `observation.sources.victoriametrics-signals` | object | no | no |  |
| `observation.sources.victoriametrics-signals.lastAttemptAt` | string | no | yes |  |
| `observation.sources.victoriametrics-signals.lastSuccess` | string | no | yes |  |
| `observation.sources.victoriametrics-signals.state` | enum | no | no | `current`, `not-configured`, `stale`, `unavailable` (unknown: see `availability-state`) |
| `observation.sources.victoriametrics-targets` | object | no | no |  |
| `observation.sources.victoriametrics-targets.lastAttemptAt` | string | no | yes |  |
| `observation.sources.victoriametrics-targets.lastSuccess` | string | no | yes |  |
| `observation.sources.victoriametrics-targets.state` | enum | no | no | `current`, `not-configured`, `stale`, `unavailable` (unknown: see `availability-state`) |
| `observation.sources.vmalert-rules` | object | no | no |  |
| `observation.sources.vmalert-rules.lastAttemptAt` | string | no | yes |  |
| `observation.sources.vmalert-rules.lastSuccess` | string | no | yes |  |
| `observation.sources.vmalert-rules.state` | enum | no | no | `current`, `not-configured`, `stale`, `unavailable` (unknown: see `availability-state`) |
<!-- /generated:fields:LiveTick -->

<a id="fields-errorenvelope"></a>

### ErrorEnvelope

<!-- generated:fields:ErrorEnvelope -->
| Field | Type | Optional | Nullable | Values |
|---|---|---|---|---|
| `code` | enum | no | no | `API_NOT_FOUND`, `CYCLE_BUILD_FAILED`, `DEVICE_CAP_REACHED`, `ESTATE_BUNDLE_INCOHERENT`, `ESTATE_BUNDLE_MISSING`, `ESTATE_BUNDLE_STRUCTURE`, `ESTATE_BUNDLE_UNPARSEABLE`, `ESTATE_BUNDLE_UNREADABLE`, `ESTATE_BUNDLE_VERSION`, `HISTORY_CANCELLED`, `HISTORY_LIMIT_EXCEEDED`, `HISTORY_OVERLOADED`, `INTERNAL_ERROR`, `INVALID_REQUEST`, `METHOD_NOT_ALLOWED`, `MODEL_CHANGED`, `NOT_READY`, `PAIRING_REFUSED`, `PAYLOAD_TOO_LARGE`, `PUSH_UNAVAILABLE`, `QUERY_NOT_APPLICABLE`, `QUERY_NOT_FOUND`, `RANGE_UNSUPPORTED`, `RATE_LIMITED`, `SOURCE_TIMEOUT`, `SOURCE_UNAVAILABLE`, `TARGET_NOT_FOUND`, `UNAUTHORIZED` (unknown: see `api-error-code`) |
| `details` | map | yes | no |  |
| `details{}` | boolean \| number \| string | no | yes |  |
| `message` | string | no | no |  |
<!-- /generated:fields:ErrorEnvelope -->

<a id="fields-bundleerrorbody"></a>

### BundleErrorBody

<!-- generated:fields:BundleErrorBody -->
| Field | Type | Optional | Nullable | Values |
|---|---|---|---|---|
| `code` | string | no | no |  |
| `kind` | enum | no | no | `incoherent`, `missing`, `structure`, `unparseable`, `unreadable`, `version` (unknown: see `bundle-error-kind`) |
| `message` | string | no | no |  |
| `path` | string | no | no |  |
<!-- /generated:fields:BundleErrorBody -->

<a id="fields-pairingredeemresponse"></a>

### PairingRedeemResponse

<!-- generated:fields:PairingRedeemResponse -->
| Field | Type | Optional | Nullable | Values |
|---|---|---|---|---|
| `credential` | string | no | no |  |
| `deviceId` | string | no | no |  |
<!-- /generated:fields:PairingRedeemResponse -->

<a id="fields-deviceregistrationresponse"></a>

### DeviceRegistrationResponse

<!-- generated:fields:DeviceRegistrationResponse -->
| Field | Type | Optional | Nullable | Values |
|---|---|---|---|---|
| `deviceId` | string | no | no |  |
| `environment` | enum | no | no | `production`, `sandbox` (unknown: see `push-environment`) |
| `preferences` | object | no | no |  |
| `preferences.critical` | boolean | no | no |  |
| `preferences.info` | boolean | no | no |  |
| `preferences.warning` | boolean | no | no |  |
| `seenAt` | string | no | no |  |
<!-- /generated:fields:DeviceRegistrationResponse -->

<a id="request-bodies"></a>

## Request bodies

The bodies the push operations take. Columns as in [Response fields](#fields). The server refuses unknown members.

<a id="fields-pairingredeemrequest"></a>

### PairingRedeemRequest

<!-- generated:fields:PairingRedeemRequest -->
| Field | Type | Optional | Nullable | Values |
|---|---|---|---|---|
| `displayName` | string | no | no |  |
| `token` | string | no | no |  |
<!-- /generated:fields:PairingRedeemRequest -->

<a id="fields-deviceregistrationrequest"></a>

### DeviceRegistrationRequest

<!-- generated:fields:DeviceRegistrationRequest -->
| Field | Type | Optional | Nullable | Values |
|---|---|---|---|---|
| `apnsToken` | string | no | no |  |
| `environment` | enum | no | no | `production`, `sandbox` (unknown: see `push-environment`) |
| `preferences` | object | no | no |  |
| `preferences.critical` | boolean | no | no |  |
| `preferences.info` | boolean | no | no |  |
| `preferences.warning` | boolean | no | no |  |
<!-- /generated:fields:DeviceRegistrationRequest -->

<a id="limits"></a>

## Limits

<!-- generated:limits -->
| Response | Limit | Maximum | Unit | Over the maximum |
|---|---|---|---|---|
| overview | hosts (`hosts`) | 100 | items | trimmed by the server to the first N in its existing order |
| overview | services, summed over hosts (`servicesTotal`) | 300 | items | trimmed by the server to the first N in its existing order |
| overview | alerts, top-level and per host or service (`alerts`) | 1024 | items | trimmed by the server to the first N in its existing order |
| overview | live signals (`signals`) | 4096 | items | trimmed by the server to the first N in its existing order |
| overview | recent checks (`recentChecks`) | 2048 | items | trimmed fair-share per endpoint |
| overview | checks per target (`targetChecks`) | 2048 | items | trimmed by the server to the first N in its existing order |
| overview | addresses per host (`hostAddresses`) | 64 | items | trimmed by the server to the first N in its existing order |
| overview | engine summary problems (`engineProblems`) | 16 | items | trimmed by the server to the first N in its existing order |
| overview | short text (`textBytes`) | 512 | bytes | truncated by the server at the last whole UTF-8 code point; no marker |
| overview | long text (summary, rationale, URL) (`messageBytes`) | 1024 (1 KiB) | bytes | truncated by the server at the last whole UTF-8 code point; no marker |
| alerts | active alerts (`alerts`) | 1024 | items | trimmed by the server to the first N in its existing order |
| alerts | rule states (`rules`) | 2048 | items | trimmed by the server to the first N in its existing order |
| alerts | active silences (`silences`) | 1024 | items | trimmed by the server to the first N in its existing order |
| estate | live targets (`liveTargets`) | 2048 | items | trimmed by the server to the first N in its existing order |
| estate | findings (`findings`) | 1024 | items | trimmed by the server to the first N in its existing order |
| estate | declared-versus-scraped rows (`declaredVersusScraped`) | 4096 | items | trimmed by the server to the first N in its existing order |
| timeline | targets (`targets`) | 2048 | items | trimmed by the server to the first N in its existing order |
| timeline | domains (`domains`) | 512 | items | trimmed by the server to the first N in its existing order |
| timeline | check-history endpoints (`checkEndpoints`) | 511 | items | trimmed by the server to the first N in its existing order |
| history | series per query (`series`) | 1024 | items | the request fails with `502 HISTORY_LIMIT_EXCEEDED`; never trimmed |
| history | points per series (`pointsPerSeries`) | 600 | items | the request fails with `502 HISTORY_LIMIT_EXCEEDED`; never trimmed |
| history | labels per series (`labels`) | 32 | items | the request fails with `502 HISTORY_LIMIT_EXCEEDED`; never trimmed |
| history | label key (`labelKeyBytes`) | 128 | bytes | the request fails with `502 HISTORY_LIMIT_EXCEEDED`; never trimmed |
| history | label value (`labelValueBytes`) | 256 | bytes | the request fails with `502 HISTORY_LIMIT_EXCEEDED`; never trimmed |
| history | lanes per alert-interval result (`lanes`) | 1024 | items | the request fails with `502 HISTORY_LIMIT_EXCEEDED`; never trimmed |
| history | intervals per lane (`intervalsPerLane`) | 600 | items | the request fails with `502 HISTORY_LIMIT_EXCEEDED`; never trimmed |
| history | endpoint results (`endpointResults`) | 600 | items | the request fails with `502 HISTORY_LIMIT_EXCEEDED`; never trimmed |
| history | endpoint incidents (`incidents`) | 600 | items | the request fails with `502 HISTORY_LIMIT_EXCEEDED`; never trimmed |
| history | whole body (`bodyBytes`) | 33554432 (32 MiB) | bytes | the request fails with `502 HISTORY_LIMIT_EXCEEDED`; never trimmed |
| current views (whole body) | canonical plain JSON (`plainBytes`) | 5242880 (5 MiB) | bytes | the cycle is not published; the server keeps serving the previous cycle, or `503 NOT_READY` before the first |
| current views (whole body) | gzip (`gzipBytes`) | 1048576 (1 MiB) | bytes | the cycle is not published; the server keeps serving the previous cycle, or `503 NOT_READY` before the first |
| requests | request body, every client-originated operation (`bodyBytes`) | 4096 (4 KiB) | bytes | the request fails with `413 PAYLOAD_TOO_LARGE` |
| push payload and registration | push payload (whole notification body) (`payloadBytes`) | 4096 (4 KiB) | bytes | never sent over the limit: title and body are truncated until it fits |
| push payload and registration | notification title (`titleBytes`) | 128 | bytes | truncated by the server at the last whole UTF-8 code point; no marker |
| push payload and registration | notification body (`bodyBytes`) | 512 | bytes | truncated by the server at the last whole UTF-8 code point; no marker |
| push payload and registration | device display name (`displayNameBytes`) | 64 | bytes | the request fails with `400 INVALID_REQUEST` |
| push payload and registration | APNs device token (`apnsTokenMaxChars`) | 200 | characters | the request fails with `400 INVALID_REQUEST` |
<!-- /generated:limits -->

The server never sends a contract response above a stated maximum.

- **Current views** (overview, alerts, estate, timeline): the server trims an over-cap collection, keeping its existing
  order. Overview `recentChecks` keeps a fair share per endpoint instead. A max-size fixture shows each cap.
- **History:** history is never trimmed. A result over any history maximum fails with `502 HISTORY_LIMIT_EXCEEDED`.
  The whole-body ceiling is 32 MiB of plain JSON.
- **Strings:** overview strings are truncated to `textBytes` (512) or `messageBytes` (1024) UTF-8 bytes, at a whole
  code point, with no marker. Alerts, estate and timeline strings are bounded only by the body cap. History label keys
  and values have their own caps.
- **Nested estate model:** the collections inside `estate` (hosts, services, channels, routing overrides, suppressions
  and their nested arrays) have no count caps. They are bounded only by the whole-body cap.
- **Body caps:** every current-view body is at most 5 MiB of canonical plain JSON and 1 MiB gzipped. A cycle that would
  exceed either is not published, and the previous body stays current.

A client should size its decode buffers from this table, not from observed responses.

<a id="enum-fallbacks"></a>

## Enum fallbacks

<!-- generated:enum-fallbacks -->
| Group | Fields | Known values | Unknown value |
|---|---|---|---|
| `alert-state` | `AlertsPayload.alerts[].state` | `firing`, `inhibited`, `silenced` | treat as `firing` |
| `api-error-code` | `ErrorEnvelope.code` | `API_NOT_FOUND`, `CYCLE_BUILD_FAILED`, `DEVICE_CAP_REACHED`, `ESTATE_BUNDLE_INCOHERENT`, `ESTATE_BUNDLE_MISSING`, `ESTATE_BUNDLE_STRUCTURE`, `ESTATE_BUNDLE_UNPARSEABLE`, `ESTATE_BUNDLE_UNREADABLE`, `ESTATE_BUNDLE_VERSION`, `HISTORY_CANCELLED`, `HISTORY_LIMIT_EXCEEDED`, `HISTORY_OVERLOADED`, `INTERNAL_ERROR`, `INVALID_REQUEST`, `METHOD_NOT_ALLOWED`, `MODEL_CHANGED`, `NOT_READY`, `PAIRING_REFUSED`, `PAYLOAD_TOO_LARGE`, `PUSH_UNAVAILABLE`, `QUERY_NOT_APPLICABLE`, `QUERY_NOT_FOUND`, `RANGE_UNSUPPORTED`, `RATE_LIMITED`, `SOURCE_TIMEOUT`, `SOURCE_UNAVAILABLE`, `TARGET_NOT_FOUND`, `UNAUTHORIZED` | Treat as a generic failure and show the message. |
| `attribution` | `IntervalHistoryPayload.lanes[].attribution` | `matched`, `unmatched` | treat as `unmatched` |
| `auth-mode` | `SessionPayload.authMode` | `none`, `proxy-header` | Treat as no write access. |
| `availability-state` | `AlertsPayload.alertmanager.state`<br>`AlertsPayload.vmalert.state`<br>`EstatePayload.coverage.availability.state`<br>`EstatePayload.declaredVersusScraped.availability.state`<br>`EstatePayload.findings.availability.state`<br>`EstatePayload.liveTargets[].availability.state`<br>`LiveTick.observation.sources.alertmanager-alerts.state`<br>`LiveTick.observation.sources.alertmanager-receivers.state`<br>`LiveTick.observation.sources.alertmanager-silences.state`<br>`LiveTick.observation.sources.alertmanager-status.state`<br>`LiveTick.observation.sources.gatus-statuses.state`<br>`LiveTick.observation.sources.grafana-health.state`<br>`LiveTick.observation.sources.victoriametrics-buildinfo.state`<br>`LiveTick.observation.sources.victoriametrics-signals.state`<br>`LiveTick.observation.sources.victoriametrics-targets.state`<br>`LiveTick.observation.sources.vmalert-rules.state`<br>`OverviewSnapshotV2.coverage.availability.state`<br>`OverviewSnapshotV2.engine.availability.state`<br>`OverviewSnapshotV2.hosts[].rollupEvidence.availability.state`<br>`OverviewSnapshotV2.hosts[].services[].statusEvidence.availability.state`<br>`OverviewSnapshotV2.hosts[].statusEvidence.availability.state`<br>`OverviewSnapshotV2.signals[].availability.state` | `current`, `not-configured`, `stale`, `unavailable` | treat as `unavailable` |
| `bundle-error-kind` | `BundleErrorBody.kind` | `incoherent`, `missing`, `structure`, `unparseable`, `unreadable`, `version` | Show that the estate bundle failed to load. |
| `channel-kind` | `EstatePayload.estate.channels[].kind` | `chat`, `email`, `push`, `telegram`, `webhook` | Show the kind as text. |
| `collection-class` | `EstatePayload.coverage.value.covered[].collectionClass`<br>`EstatePayload.coverage.value.gaps[].collectionClass`<br>`EstatePayload.coverage.value.suppressed[].collectionClass`<br>`EstatePayload.estate.hosts[].collectionClass`<br>`OverviewSnapshotV2.hosts[].collectionClass` | `excluded`, `hypervisor-api`, `managed-linux`, `nas-api`, `probe-only` | Show as a generic host. |
| `command-output` | `EstatePayload.estate.hosts[](collectionClass=managed-linux).detail.commandSignals[].output` | `exposition`, `scalar` | Show the name and command only. |
| `coverage-kind` | `EstatePayload.coverage.value.covered[].kind`<br>`EstatePayload.coverage.value.gaps[].kind`<br>`EstatePayload.coverage.value.suppressed[].kind` | `host`, `service` | Show as a generic covered target. |
| `credential-kind` | `EstatePayload.estate.channels[].credential.kind`<br>`EstatePayload.estate.hosts[](collectionClass=hypervisor-api).detail.credential.kind`<br>`EstatePayload.estate.hosts[](collectionClass=managed-linux).detail.commandSignals[].credential.kind`<br>`EstatePayload.estate.hosts[](collectionClass=nas-api).detail.credential.kind`<br>`EstatePayload.estate.services[].deepHealthDetail.credential.kind` | `env`, `op` | Show the display text only. |
| `deadman-kind` | `EstatePayload.estate.estate.deadman.kind` | `plain`, `secret-ref` | Show as configured. |
| `declared-scrape-health` | `EstatePayload.declaredVersusScraped.value[].health` | `down`, `unknown`, `up` | treat as `unknown` |
| `declared-scrape-state` | `EstatePayload.declaredVersusScraped.value[].state` | `engine`, `matched`, `missing`, `unexpected`, `unknown` | treat as `unknown` |
| `delivery-form` | `EstatePayload.estate.hosts[](collectionClass=managed-linux).detail.deliveryForm` | `compose`, `systemd` | Show the value as text. |
| `finding-code` | `EstatePayload.findings.value.findings[].code` | `backup_command_host`, `connect_link_no_address`, `connect_link_refused`, `duplicate_command_signal`, `duplicate_estate`, `duplicate_identity`, `gatus_unsafe_name`, `host_local_probe_host`, `incomplete_nas_api`, `inert_alert_binding`, `invalid_enum`, `invalid_hypervisor_endpoint`, `invalid_layer`, `invalid_timezone`, `malformed_yaml`, `missing_chat_id`, `missing_field`, `missing_rationale`, `missing_timezone`, `missing_version`, `proposal_already_decided`, `proposal_cannot_clear_base`, `proposal_dirty_tree`, `proposal_invalid_estate`, `proposal_not_found`, `proposal_overlay_ambiguous`, `proposal_signature_invalid`, `proposal_stale`, `push_device_not_found`, `push_misconfigured`, `push_no_devices`, `push_not_configured`, `push_operator_refused`, `push_operator_secret_missing`, `push_pair_no_address`, `push_server_missing`, `push_server_unreachable`, `push_test_failed`, `secret_literal`, `unknown_field`, `unresolved_channel`, `unresolved_host`, `unsupported_version`, `web_artifact_leak_detected`, `web_sensitive_channel_option_omitted`, `web_unsafe_provenance`, `web_url_userinfo_removed`, `wrong_type` | Show the code as text. |
| `finding-severity` | `EstatePayload.findings.value.findings[].severity` | `error`, `info`, `warning` | treat as `info` |
| `health-state` | `EstatePayload.liveTargets[].state` | `healthy`, `not-configured`, `unhealthy`, `unknown` | treat as `unknown` |
| `history-severity` | `IntervalHistoryPayload.lanes[].severity` | `critical`, `info`, `unknown`, `warning` | treat as `unknown` |
| `interval-state` | `EndpointHistoryPayload.incidents[].state`<br>`IntervalHistoryPayload.lanes[].intervals[].state` | `failed`, `firing` | treat as `failed` |
| `overview-severity` | `OverviewSnapshotV2.alerts[].severity`<br>`OverviewSnapshotV2.hosts[].activeAlerts[].severity`<br>`OverviewSnapshotV2.hosts[].services[].activeAlerts[].severity` | `critical`, `info`, `warning` | Display as the lowest severity, labelled unknown. |
| `provenance` | `EndpointHistoryPayload.incidents[].provenance`<br>`IntervalHistoryPayload.lanes[].intervals[].provenance` | `gatus`, `vmalert` | Show the value as text. |
| `push-alert-status` | `PushPayload.pulse.alert.status` | `firing`, `resolved` | treat as `firing` |
| `push-category` | `PushPayload.aps.category` | `PULSE_ALERT_FIRING`, `PULSE_ALERT_RESOLVED`, `PULSE_ALERT_SUMMARY`, `PULSE_TEST` | Use the default category, with no actions. |
| `push-environment` | `DeviceRegistrationRequest.environment`<br>`DeviceRegistrationResponse.environment` | `production`, `sandbox` | In a response, treat the registration as needing a refresh. In a request, the server refuses the value with 400 INVALID_REQUEST. |
| `push-interruption-level` | `PushPayload.aps.interruption-level` | `active`, `passive`, `time-sensitive` | treat as `active` |
| `push-kind` | `PushPayload.pulse.kind` | `alert`, `summary`, `test` | Ignore the pulse object, show aps.alert as is, and open the home screen on tap. |
| `push-severity` | `PushPayload.pulse.alert.severity`<br>`PushPayload.pulse.summary.severity` | `critical`, `info`, `unknown`, `warning` | treat as `unknown` |
| `push-target-screen` | `PushPayload.pulse.target.screen` | `alert`, `alerts`, `home` | treat as `home` |
| `query-id` | `HistoryPayload.queryId`<br>`TimelinePayload.targets[].queryIds[]` | `alerts.firing`, `endpoint.check.latency`, `engine.active-series`, `engine.disk-usage`, `engine.ingestion-rate`, `engine.notification-failures`, `engine.notification-latency`, `estate.liveness`, `host.cpu.utilization`, `host.disk.utilization`, `host.load.1m`, `host.memory.utilization`, `service.backup-age`, `service.deep-health` | Omit the chart. |
| `range-id` | `EndpointHistoryPayload.range`<br>`HistoryPayload.range`<br>`IntervalHistoryPayload.range`<br>`TimelinePayload.alertHistory.ranges[]`<br>`TimelinePayload.targets[].ranges[]` | `1h`, `24h`, `6h`, `7d` | Hide the range. |
| `rule-health` | `AlertsPayload.rules[].health` | `healthy`, `unhealthy`, `unknown` | treat as `unknown` |
| `silence-state` | `AlertsPayload.silences[].state` | `active`, `expired`, `pending` | treat as `expired` |
| `source-id` | `AlertsPayload.alertmanager.source`<br>`AlertsPayload.vmalert.source`<br>`EstatePayload.coverage.availability.source`<br>`EstatePayload.declaredVersusScraped.availability.source`<br>`EstatePayload.findings.availability.source`<br>`EstatePayload.liveTargets[].availability.source`<br>`OverviewSnapshotV2.coverage.availability.source`<br>`OverviewSnapshotV2.engine.availability.source`<br>`OverviewSnapshotV2.hosts[].rollupEvidence.availability.source`<br>`OverviewSnapshotV2.hosts[].services[].statusEvidence.availability.source`<br>`OverviewSnapshotV2.hosts[].statusEvidence.availability.source`<br>`OverviewSnapshotV2.signals[].availability.source` | `alertmanager-alerts`, `alertmanager-receivers`, `alertmanager-silences`, `alertmanager-status`, `gatus-statuses`, `grafana-health`, `rendered-estate`, `victoriametrics-buildinfo`, `victoriametrics-signals`, `victoriametrics-targets`, `vmalert-rules` | Show under 'other sources'. |
| `suppression-class` | `EstatePayload.coverage.value.covered[].suppressed.class`<br>`EstatePayload.coverage.value.gaps[].suppressed.class`<br>`EstatePayload.coverage.value.suppressed[].suppressed.class`<br>`EstatePayload.estate.hosts[].suppressed.class`<br>`EstatePayload.estate.services[].suppressed.class`<br>`EstatePayload.estate.suppressions[].class` | `excluded`, `expected-churn`, `known-expected` | Show as suppressed. |
| `target-kind` | `AlertsPayload.alerts[].historyRef.target.kind`<br>`AlertsPayload.alerts[].target.kind`<br>`EndpointHistoryPayload.target.kind`<br>`EstatePayload.liveTargets[].target.kind`<br>`HistoryPayload.target.kind`<br>`IntervalHistoryPayload.lanes[].target.kind`<br>`IntervalHistoryPayload.target.kind`<br>`OverviewSnapshotV2.alerts[].target.kind`<br>`OverviewSnapshotV2.hosts[].activeAlerts[].target.kind`<br>`OverviewSnapshotV2.hosts[].services[].activeAlerts[].target.kind`<br>`OverviewSnapshotV2.recentChecks[].target.kind`<br>`OverviewSnapshotV2.signals[].target.kind`<br>`TimelinePayload.targets[].parent.kind`<br>`TimelinePayload.targets[].target.kind` | `endpoint`, `host`, `service` | Show as a generic target with no drill-down. |
| `target-status` | `OverviewSnapshotV2.hosts[].rollup`<br>`OverviewSnapshotV2.hosts[].rollupEvidence.status`<br>`OverviewSnapshotV2.hosts[].services[].status`<br>`OverviewSnapshotV2.hosts[].services[].statusEvidence.status`<br>`OverviewSnapshotV2.hosts[].status`<br>`OverviewSnapshotV2.hosts[].statusEvidence.status` | `critical`, `ok`, `suppressed`, `unknown`, `warning` | treat as `unknown` |
| `unit` | `HistoryPayload.unit`<br>`OverviewSnapshotV2.signals[].unit` | `bytes`, `count`, `milliseconds`, `percent`, `scalar`, `seconds`, `state` | Show the raw number with no unit. |
| `view-id` | `LiveTick.identities` |  | Ignore the key. |
<!-- /generated:enum-fallbacks -->

Every string-literal enum in a contract response is open for extension. New members arrive in minor versions, so a
client must handle a value it does not know as the table says.

- An unknown `OverviewAlertSummary.severity` is displayed as the lowest
  severity and labelled unknown.
- `ActiveAlert.severity` is a free string, not an enum, so it has no table row. The known values are `critical`,
  `warning` and `info`. A client applies the same display rule to any other value.
- `BundleErrorBody.kind`: an unknown kind is shown as "estate bundle failed to load".

<a id="caching"></a>

## Caching

- **Overview, alerts, estate and timeline:** a 200 and a 304 both carry a strong `ETag`. Send `If-None-Match` with the
  stored ETag. A match returns a 304 with no body, which still carries the latest headers. The responses carry
  `Cache-Control: private, no-cache` and `Vary: Accept-Encoding`. The plain and gzip representations have different
  ETags.
- **Overview before the first cycle:** the server may return 200 with the same body type and **no ETag**. A client must
  accept that, and simply not send `If-None-Match` on the next request.
- **Other current views before the first cycle:** the server returns `503 NOT_READY`. A client must retry later and
  must not treat the response as an empty view.
- **History:** always a full 200 with no ETag (`Cache-Control: private, no-cache`). Conditional requests are not
  supported.
- **Session:** `Cache-Control: private, no-store`. Never cache it.

<a id="events"></a>

## Live events

- `GET /api/events` is a Server-Sent Events stream. Each event is named `tick`. Its `id` is `<generation>:<seq>` and its
  `data` is one `LiveTick` JSON object. A tick carries the identities of the views, not their bodies. On a tick the
  client refetches each view whose identity changed.
- On connect the server sends `retry: 10000` (`SSE_RETRY_MS`). A client must wait at least that long before
  reconnecting, unless it was displaced.
- A `: heartbeat` comment arrives every 5000 ms (`SSE_HEARTBEAT_MS`). A client may treat about three missed heartbeats
  as a dead connection.
- **Resume:** send `Last-Event-ID`. If it equals the current `<generation>:<seq>`, no tick is sent on connect. Any
  other value (absent, malformed, older, newer, or from another generation) gets the current tick at once. There is no
  replay of missed ticks. The stream converges to the current state.
- Before the first publication the stream sends only `retry` and heartbeats.
- The server keeps at most 64 simultaneous streams (`SSE_MAX_STREAMS`). A new stream beyond 64 closes the oldest. A
  displaced or disconnected client must reconnect. A phone counts as one stream.
- `identities.engine` and everything in `observation` except `generation`
  and `seq` are not part of the contract. A client must ignore them.

Example transcript, with placeholder values:

```
retry: 10000

id: 00000000-0000-4000-8000-000000000001:7
event: tick
data: {"identities":{…},"observation":{…}}

: heartbeat
```

<a id="request-limits"></a>

## Request limits

- A query string is at most 2048 UTF-8 bytes (`MAX_QUERY_BYTES`), and a query key must not repeat.
- A path parameter, after decoding, is at most 512 UTF-8 bytes (`MAX_PARAM_BYTES`) and must contain no control
  characters. A slash is allowed only where the [Operations](#operations) table says it may be encoded as `%2F`.
- A violation returns `400 INVALID_REQUEST`.
- History accepts only the `range` key. Any other key is a 400. The current views and the session ignore unknown keys.
  A client should send none.

<a id="auth"></a>

## Authentication

- No contract operation needs client credentials, in any authentication mode (`PULSE_WEB_AUTH_MODE`).
- `identity` in the session response may be `null`. A client must not treat that as an error.
- Any access control in front of the server, such as a VPN or a proxy, is deployment configuration and is outside the
  contract.

<a id="not-in-contract"></a>

## Not in the contract

A client must not depend on any of the following:

- `GET /api/engine`;
- the proposals routes;
- `/healthz` and `/metrics`;
- `GET /api/connect-link`, which serves the web UI only;
- every non-GET method (they currently return `405 METHOD_NOT_ALLOWED`);
- the response headers `X-Pulse-Observation` and `X-Pulse-Payload-Id`;
- in `LiveTick`, `identities.engine` and the content of `observation` beyond `generation` and `seq`;
- static assets and the HTML shell.

<a id="connect-link"></a>

## Connect link

A connect link tells a client where the server is. It is what the QR code on the web connect screen encodes.

- **Format:** `pulse://connect?v=1&url=<percent-encoded https base URL>[&<name>=<value>…]`. For the base URL
  `https://pulse.example.com` the link is `pulse://connect?v=1&url=https%3A%2F%2Fpulse.example.com`.
- `v` is the link format version (`CONNECT_LINK_FORMAT_VERSION`, currently 1). It is independent of the contract
  version.
- Parameters appear in the order `v`, `url`, then extras sorted by name. An extra name matches
  `LINK_PARAM_NAME_PATTERN` (`^[a-z][a-z0-9-]{0,31}$`), and `v` and `url` are reserved. A client must ignore extras it
  does not know. Adding one needs no format version bump. Contract 1.1 defines one extra parameter, `pair`: a pairing
  token (22 base64url characters, `PAIR_TOKEN_PATTERN`) that authorises this device to register for push
  notifications. **A link carrying `pair` is a secret.** A client must not log it, persist it, share it or show it
  again after reading it; it uses the token once, for redemption, and then discards it. A link without `pair` carries
  no secret. A client ignores a malformed `pair` as if it were absent, and a client without push support ignores `pair`
  like any unknown parameter.
- A base URL built by the server is normalised: https only, no credentials, query or fragment, a lower-case host, no
  default port and no trailing slash. Producers emit links of at most 256 characters (`CONNECT_LINK_MAX_LENGTH`).

A client validates a link with these checks, in this order. The first failure is the rejection
(`ConnectLinkRejection`).

1. The link does not parse as a URL, its scheme is not `pulse:`, or its host is not `connect` (compared without regard
   to case; no port, credentials or path) → `wrong-scheme`.
2. There is not exactly one `v`, or it is not exactly the string `1` → `unsupported-version`.
3. `url` is absent or empty → `missing-url`.
4. `url` appears more than once, does not parse, or carries credentials → `malformed-url`.
5. The scheme of `url` is not `https:` → `not-https`.
6. `url` is https but names a loopback or unspecified host → `malformed-url`.

Unknown extra parameters are kept and ignored. When an extra repeats, the first occurrence wins. A reader applies no
length limit.

On success the client uses the normalised base URL, and then performs the [handshake](#handshake) before it shows any
data.

The `connect-link` fixtures pin every rule.

<a id="push-payload"></a>

## Push payload

A push notification's body is one `PushPayload` JSON object of at most 4096 bytes. A client must ignore unknown
members in `aps`, in `pulse` and at the top level.

<a id="fields-pushpayload"></a>

### PushPayload

<!-- generated:fields:PushPayload -->
| Field | Type | Optional | Nullable | Values |
|---|---|---|---|---|
| `aps` | object | no | no |  |
| `aps.alert` | object | no | no |  |
| `aps.alert.body` | string | no | no |  |
| `aps.alert.title` | string | no | no |  |
| `aps.badge` | number | yes | no |  |
| `aps.category` | enum | no | no | `PULSE_ALERT_FIRING`, `PULSE_ALERT_RESOLVED`, `PULSE_ALERT_SUMMARY`, `PULSE_TEST` (unknown: see `push-category`) |
| `aps.interruption-level` | enum | no | no | `active`, `passive`, `time-sensitive` (unknown: see `push-interruption-level`) |
| `aps.sound` | constant | yes | no | `default` |
| `pulse` | object | no | no |  |
| `pulse.alert` | object | yes | no |  |
| `pulse.alert.fingerprint` | string | no | no |  |
| `pulse.alert.severity` | enum | no | no | `critical`, `info`, `unknown`, `warning` (unknown: see `push-severity`) |
| `pulse.alert.status` | enum | no | no | `firing`, `resolved` (unknown: see `push-alert-status`) |
| `pulse.collapseId` | string | no | yes |  |
| `pulse.kind` | enum | no | no | `alert`, `summary`, `test` (unknown: see `push-kind`) |
| `pulse.summary` | object | yes | no |  |
| `pulse.summary.firing` | number | no | no |  |
| `pulse.summary.group` | string | no | no |  |
| `pulse.summary.resolved` | number | no | no |  |
| `pulse.summary.severity` | enum | no | yes | `critical`, `info`, `unknown`, `warning` (unknown: see `push-severity`) |
| `pulse.target` | object | no | no |  |
| `pulse.target(screen=alert).fingerprint` | string | no | no |  |
| `pulse.target.screen` | enum | no | no | `alert`, `alerts`, `home` (unknown: see `push-target-screen`) |
| `pulse.v` | constant | no | no | `1` |
<!-- /generated:fields:PushPayload -->

<a id="fixtures"></a>

## Fixtures

Fixtures live under `fixtures/<group>/<scenario>.json` (or `.sse` for an event-stream transcript). The file
`index.json` lists them all. A consumer must iterate the index and never hard-code file names.

Each index entry has these fields:

- `path`, `group`, `operation`, `scenario`: where the fixture is and what it exercises.
- `kind`: what the file holds. `response` and `error` are HTTP bodies, `event` is one event's data, `stream` is a raw
  SSE transcript, `handshake` is a handshake case, and `connect-link` is a connect-link case.
- `status`: the HTTP status for `response` and `error` fixtures, otherwise `null`.
- `expect`: `accept` when a conforming client must decode the fixture, `reject` when it must refuse it. A client
  accepts an error fixture by decoding it as the documented error.
- `webValidator`: internal to the web client. Other clients ignore it.
- `client` and `expectedOutcome` (handshake fixtures): the client requirement and the decision the
  [handshake](#handshake) table must give.
- `rejection` (rejecting connect-link fixtures): the rejection the [connect link](#connect-link) checks must give.

A decoder is correct when it gives the result the index records for every fixture.

<!-- generated:fixtures -->
Index format 1, contract 1.1, 194 fixtures.

| Fixture | Operation | Scenario | Kind | Status | Expect | Expected result |
|---|---|---|---|---|---|---|
| [`fixtures/alerts/all-optional.json`](fixtures/alerts/all-optional.json) | `GET /api/alerts` | `all-optional` | response | 200 | accept | — |
| [`fixtures/alerts/bundle-error.json`](fixtures/alerts/bundle-error.json) | `GET /api/alerts` | `bundle-error` | error | 503 | accept | — |
| [`fixtures/alerts/empty.json`](fixtures/alerts/empty.json) | `GET /api/alerts` | `empty` | response | 200 | accept | — |
| [`fixtures/alerts/error-invalid-request.json`](fixtures/alerts/error-invalid-request.json) | `GET /api/alerts` | `error-invalid-request` | error | 400 | accept | — |
| [`fixtures/alerts/error-not-ready.json`](fixtures/alerts/error-not-ready.json) | `GET /api/alerts` | `error-not-ready` | error | 503 | accept | — |
| [`fixtures/alerts/max-size.json`](fixtures/alerts/max-size.json) | `GET /api/alerts` | `max-size` | response | 200 | accept | — |
| [`fixtures/alerts/typical.json`](fixtures/alerts/typical.json) | `GET /api/alerts` | `typical` | response | 200 | accept | — |
| [`fixtures/alerts/unknown-enum-alert-state.json`](fixtures/alerts/unknown-enum-alert-state.json) | `GET /api/alerts` | `unknown-enum-alert-state` | response | 200 | accept | — |
| [`fixtures/alerts/unknown-enum-availability-state.json`](fixtures/alerts/unknown-enum-availability-state.json) | `GET /api/alerts` | `unknown-enum-availability-state` | response | 200 | accept | — |
| [`fixtures/alerts/unknown-enum-rule-health.json`](fixtures/alerts/unknown-enum-rule-health.json) | `GET /api/alerts` | `unknown-enum-rule-health` | response | 200 | accept | — |
| [`fixtures/alerts/unknown-enum-silence-state.json`](fixtures/alerts/unknown-enum-silence-state.json) | `GET /api/alerts` | `unknown-enum-silence-state` | response | 200 | accept | — |
| [`fixtures/alerts/unknown-enum-source-id.json`](fixtures/alerts/unknown-enum-source-id.json) | `GET /api/alerts` | `unknown-enum-source-id` | response | 200 | accept | — |
| [`fixtures/alerts/unknown-enum-target-kind.json`](fixtures/alerts/unknown-enum-target-kind.json) | `GET /api/alerts` | `unknown-enum-target-kind` | response | 200 | accept | — |
| [`fixtures/connect-link/basic.json`](fixtures/connect-link/basic.json) | `connect-link` | `basic` | connect-link | — | accept | — |
| [`fixtures/connect-link/http-loopback.json`](fixtures/connect-link/http-loopback.json) | `connect-link` | `http-loopback` | connect-link | — | reject | rejection `not-https` |
| [`fixtures/connect-link/http-url.json`](fixtures/connect-link/http-url.json) | `connect-link` | `http-url` | connect-link | — | reject | rejection `not-https` |
| [`fixtures/connect-link/malformed-url.json`](fixtures/connect-link/malformed-url.json) | `connect-link` | `malformed-url` | connect-link | — | reject | rejection `malformed-url` |
| [`fixtures/connect-link/missing-url.json`](fixtures/connect-link/missing-url.json) | `connect-link` | `missing-url` | connect-link | — | reject | rejection `missing-url` |
| [`fixtures/connect-link/unknown-param.json`](fixtures/connect-link/unknown-param.json) | `connect-link` | `unknown-param` | connect-link | — | accept | — |
| [`fixtures/connect-link/unsupported-version.json`](fixtures/connect-link/unsupported-version.json) | `connect-link` | `unsupported-version` | connect-link | — | reject | rejection `unsupported-version` |
| [`fixtures/connect-link/with-pair-token.json`](fixtures/connect-link/with-pair-token.json) | `connect-link` | `with-pair-token` | connect-link | — | accept | — |
| [`fixtures/connect-link/with-path.json`](fixtures/connect-link/with-path.json) | `connect-link` | `with-path` | connect-link | — | accept | — |
| [`fixtures/connect-link/wrong-scheme.json`](fixtures/connect-link/wrong-scheme.json) | `connect-link` | `wrong-scheme` | connect-link | — | reject | rejection `wrong-scheme` |
| [`fixtures/errors/api-not-found.json`](fixtures/errors/api-not-found.json) | `GET /api/*` | `api-not-found` | error | 404 | accept | — |
| [`fixtures/errors/bundle-error-incoherent.json`](fixtures/errors/bundle-error-incoherent.json) | `GET /api/*` | `bundle-error-incoherent` | error | 503 | accept | — |
| [`fixtures/errors/bundle-error-missing.json`](fixtures/errors/bundle-error-missing.json) | `GET /api/*` | `bundle-error-missing` | error | 503 | accept | — |
| [`fixtures/errors/bundle-error-structure.json`](fixtures/errors/bundle-error-structure.json) | `GET /api/*` | `bundle-error-structure` | error | 503 | accept | — |
| [`fixtures/errors/bundle-error-unparseable.json`](fixtures/errors/bundle-error-unparseable.json) | `GET /api/*` | `bundle-error-unparseable` | error | 503 | accept | — |
| [`fixtures/errors/bundle-error-unreadable.json`](fixtures/errors/bundle-error-unreadable.json) | `GET /api/*` | `bundle-error-unreadable` | error | 503 | accept | — |
| [`fixtures/errors/bundle-error-version.json`](fixtures/errors/bundle-error-version.json) | `GET /api/*` | `bundle-error-version` | error | 503 | accept | — |
| [`fixtures/errors/internal-error.json`](fixtures/errors/internal-error.json) | `GET /api/*` | `internal-error` | error | 500 | accept | — |
| [`fixtures/errors/invalid-request.json`](fixtures/errors/invalid-request.json) | `GET /api/*` | `invalid-request` | error | 400 | accept | — |
| [`fixtures/errors/unknown-enum-api-error-code.json`](fixtures/errors/unknown-enum-api-error-code.json) | `GET /api/*` | `unknown-enum-api-error-code` | error | 400 | accept | — |
| [`fixtures/errors/unknown-enum-bundle-error-kind.json`](fixtures/errors/unknown-enum-bundle-error-kind.json) | `GET /api/*` | `unknown-enum-bundle-error-kind` | error | 503 | accept | — |
| [`fixtures/estate/all-optional.json`](fixtures/estate/all-optional.json) | `GET /api/estate` | `all-optional` | response | 200 | accept | — |
| [`fixtures/estate/bundle-error.json`](fixtures/estate/bundle-error.json) | `GET /api/estate` | `bundle-error` | error | 503 | accept | — |
| [`fixtures/estate/empty.json`](fixtures/estate/empty.json) | `GET /api/estate` | `empty` | response | 200 | accept | — |
| [`fixtures/estate/error-invalid-request.json`](fixtures/estate/error-invalid-request.json) | `GET /api/estate` | `error-invalid-request` | error | 400 | accept | — |
| [`fixtures/estate/error-not-ready.json`](fixtures/estate/error-not-ready.json) | `GET /api/estate` | `error-not-ready` | error | 503 | accept | — |
| [`fixtures/estate/max-size.json`](fixtures/estate/max-size.json) | `GET /api/estate` | `max-size` | response | 200 | accept | — |
| [`fixtures/estate/typical.json`](fixtures/estate/typical.json) | `GET /api/estate` | `typical` | response | 200 | accept | — |
| [`fixtures/estate/unknown-enum-channel-kind.json`](fixtures/estate/unknown-enum-channel-kind.json) | `GET /api/estate` | `unknown-enum-channel-kind` | response | 200 | accept | — |
| [`fixtures/estate/unknown-enum-collection-class.json`](fixtures/estate/unknown-enum-collection-class.json) | `GET /api/estate` | `unknown-enum-collection-class` | response | 200 | accept | — |
| [`fixtures/estate/unknown-enum-command-output.json`](fixtures/estate/unknown-enum-command-output.json) | `GET /api/estate` | `unknown-enum-command-output` | response | 200 | accept | — |
| [`fixtures/estate/unknown-enum-coverage-kind.json`](fixtures/estate/unknown-enum-coverage-kind.json) | `GET /api/estate` | `unknown-enum-coverage-kind` | response | 200 | accept | — |
| [`fixtures/estate/unknown-enum-credential-kind.json`](fixtures/estate/unknown-enum-credential-kind.json) | `GET /api/estate` | `unknown-enum-credential-kind` | response | 200 | accept | — |
| [`fixtures/estate/unknown-enum-deadman-kind.json`](fixtures/estate/unknown-enum-deadman-kind.json) | `GET /api/estate` | `unknown-enum-deadman-kind` | response | 200 | accept | — |
| [`fixtures/estate/unknown-enum-declared-scrape-health.json`](fixtures/estate/unknown-enum-declared-scrape-health.json) | `GET /api/estate` | `unknown-enum-declared-scrape-health` | response | 200 | accept | — |
| [`fixtures/estate/unknown-enum-declared-scrape-state.json`](fixtures/estate/unknown-enum-declared-scrape-state.json) | `GET /api/estate` | `unknown-enum-declared-scrape-state` | response | 200 | accept | — |
| [`fixtures/estate/unknown-enum-delivery-form.json`](fixtures/estate/unknown-enum-delivery-form.json) | `GET /api/estate` | `unknown-enum-delivery-form` | response | 200 | accept | — |
| [`fixtures/estate/unknown-enum-finding-code.json`](fixtures/estate/unknown-enum-finding-code.json) | `GET /api/estate` | `unknown-enum-finding-code` | response | 200 | accept | — |
| [`fixtures/estate/unknown-enum-finding-severity.json`](fixtures/estate/unknown-enum-finding-severity.json) | `GET /api/estate` | `unknown-enum-finding-severity` | response | 200 | accept | — |
| [`fixtures/estate/unknown-enum-health-state.json`](fixtures/estate/unknown-enum-health-state.json) | `GET /api/estate` | `unknown-enum-health-state` | response | 200 | accept | — |
| [`fixtures/estate/unknown-enum-suppression-class.json`](fixtures/estate/unknown-enum-suppression-class.json) | `GET /api/estate` | `unknown-enum-suppression-class` | response | 200 | accept | — |
| [`fixtures/events/stream-resume-match.sse`](fixtures/events/stream-resume-match.sse) | `SSE /api/events` | `stream-resume-match` | stream | — | accept | — |
| [`fixtures/events/stream-typical.sse`](fixtures/events/stream-typical.sse) | `SSE /api/events` | `stream-typical` | stream | — | accept | — |
| [`fixtures/events/stream-unknown-event.sse`](fixtures/events/stream-unknown-event.sse) | `SSE /api/events` | `stream-unknown-event` | stream | — | accept | — |
| [`fixtures/events/tick-typical.json`](fixtures/events/tick-typical.json) | `SSE /api/events` | `tick-typical` | event | — | accept | — |
| [`fixtures/events/tick-unknown-fields.json`](fixtures/events/tick-unknown-fields.json) | `SSE /api/events` | `tick-unknown-fields` | event | — | accept | — |
| [`fixtures/events/tick-unknown-view.json`](fixtures/events/tick-unknown-view.json) | `SSE /api/events` | `tick-unknown-view` | event | — | accept | — |
| [`fixtures/events/unknown-enum-view-id.json`](fixtures/events/unknown-enum-view-id.json) | `SSE /api/events` | `unknown-enum-view-id` | event | — | accept | — |
| [`fixtures/handshake/client-too-old.json`](fixtures/handshake/client-too-old.json) | `handshake` | `client-too-old` | handshake | — | accept | outcome `client-too-old` for client `0.0` |
| [`fixtures/handshake/compatible.json`](fixtures/handshake/compatible.json) | `handshake` | `compatible` | handshake | — | accept | outcome `compatible` for client `1.1` |
| [`fixtures/handshake/server-too-old-absent.json`](fixtures/handshake/server-too-old-absent.json) | `handshake` | `server-too-old-absent` | handshake | — | accept | outcome `server-too-old` for client `1.1` |
| [`fixtures/handshake/server-too-old-major.json`](fixtures/handshake/server-too-old-major.json) | `handshake` | `server-too-old-major` | handshake | — | accept | outcome `server-too-old` for client `2.0` |
| [`fixtures/handshake/server-too-old-minor.json`](fixtures/handshake/server-too-old-minor.json) | `handshake` | `server-too-old-minor` | handshake | — | accept | outcome `server-too-old` for client `1.2` |
| [`fixtures/history-alerts/all-optional.json`](fixtures/history-alerts/all-optional.json) | `GET /api/history/alerts` | `all-optional` | response | 200 | accept | — |
| [`fixtures/history-alerts/bundle-error.json`](fixtures/history-alerts/bundle-error.json) | `GET /api/history/alerts` | `bundle-error` | error | 503 | accept | — |
| [`fixtures/history-alerts/empty.json`](fixtures/history-alerts/empty.json) | `GET /api/history/alerts` | `empty` | response | 200 | accept | — |
| [`fixtures/history-alerts/error-history-cancelled.json`](fixtures/history-alerts/error-history-cancelled.json) | `GET /api/history/alerts` | `error-history-cancelled` | error | 503 | accept | — |
| [`fixtures/history-alerts/error-history-limit-exceeded.json`](fixtures/history-alerts/error-history-limit-exceeded.json) | `GET /api/history/alerts` | `error-history-limit-exceeded` | error | 502 | accept | — |
| [`fixtures/history-alerts/error-history-overloaded.json`](fixtures/history-alerts/error-history-overloaded.json) | `GET /api/history/alerts` | `error-history-overloaded` | error | 503 | accept | — |
| [`fixtures/history-alerts/error-invalid-request.json`](fixtures/history-alerts/error-invalid-request.json) | `GET /api/history/alerts` | `error-invalid-request` | error | 400 | accept | — |
| [`fixtures/history-alerts/error-model-changed.json`](fixtures/history-alerts/error-model-changed.json) | `GET /api/history/alerts` | `error-model-changed` | error | 503 | accept | — |
| [`fixtures/history-alerts/error-query-not-applicable.json`](fixtures/history-alerts/error-query-not-applicable.json) | `GET /api/history/alerts` | `error-query-not-applicable` | error | 422 | accept | — |
| [`fixtures/history-alerts/error-query-not-found.json`](fixtures/history-alerts/error-query-not-found.json) | `GET /api/history/alerts` | `error-query-not-found` | error | 404 | accept | — |
| [`fixtures/history-alerts/error-range-unsupported.json`](fixtures/history-alerts/error-range-unsupported.json) | `GET /api/history/alerts` | `error-range-unsupported` | error | 422 | accept | — |
| [`fixtures/history-alerts/error-source-timeout.json`](fixtures/history-alerts/error-source-timeout.json) | `GET /api/history/alerts` | `error-source-timeout` | error | 504 | accept | — |
| [`fixtures/history-alerts/error-source-unavailable.json`](fixtures/history-alerts/error-source-unavailable.json) | `GET /api/history/alerts` | `error-source-unavailable` | error | 502 | accept | — |
| [`fixtures/history-alerts/error-target-not-found.json`](fixtures/history-alerts/error-target-not-found.json) | `GET /api/history/alerts` | `error-target-not-found` | error | 404 | accept | — |
| [`fixtures/history-alerts/max-size-intervals.json`](fixtures/history-alerts/max-size-intervals.json) | `GET /api/history/alerts` | `max-size-intervals` | response | 200 | accept | — |
| [`fixtures/history-alerts/max-size-lanes.json`](fixtures/history-alerts/max-size-lanes.json) | `GET /api/history/alerts` | `max-size-lanes` | response | 200 | accept | — |
| [`fixtures/history-alerts/typical.json`](fixtures/history-alerts/typical.json) | `GET /api/history/alerts` | `typical` | response | 200 | accept | — |
| [`fixtures/history-alerts/unknown-enum-attribution.json`](fixtures/history-alerts/unknown-enum-attribution.json) | `GET /api/history/alerts` | `unknown-enum-attribution` | response | 200 | accept | — |
| [`fixtures/history-alerts/unknown-enum-history-severity.json`](fixtures/history-alerts/unknown-enum-history-severity.json) | `GET /api/history/alerts` | `unknown-enum-history-severity` | response | 200 | accept | — |
| [`fixtures/history-checks/all-optional.json`](fixtures/history-checks/all-optional.json) | `GET /api/history/checks/:endpoint` | `all-optional` | response | 200 | accept | — |
| [`fixtures/history-checks/bundle-error.json`](fixtures/history-checks/bundle-error.json) | `GET /api/history/checks/:endpoint` | `bundle-error` | error | 503 | accept | — |
| [`fixtures/history-checks/empty.json`](fixtures/history-checks/empty.json) | `GET /api/history/checks/:endpoint` | `empty` | response | 200 | accept | — |
| [`fixtures/history-checks/error-history-cancelled.json`](fixtures/history-checks/error-history-cancelled.json) | `GET /api/history/checks/:endpoint` | `error-history-cancelled` | error | 503 | accept | — |
| [`fixtures/history-checks/error-history-limit-exceeded.json`](fixtures/history-checks/error-history-limit-exceeded.json) | `GET /api/history/checks/:endpoint` | `error-history-limit-exceeded` | error | 502 | accept | — |
| [`fixtures/history-checks/error-history-overloaded.json`](fixtures/history-checks/error-history-overloaded.json) | `GET /api/history/checks/:endpoint` | `error-history-overloaded` | error | 503 | accept | — |
| [`fixtures/history-checks/error-invalid-request.json`](fixtures/history-checks/error-invalid-request.json) | `GET /api/history/checks/:endpoint` | `error-invalid-request` | error | 400 | accept | — |
| [`fixtures/history-checks/error-model-changed.json`](fixtures/history-checks/error-model-changed.json) | `GET /api/history/checks/:endpoint` | `error-model-changed` | error | 503 | accept | — |
| [`fixtures/history-checks/error-query-not-applicable.json`](fixtures/history-checks/error-query-not-applicable.json) | `GET /api/history/checks/:endpoint` | `error-query-not-applicable` | error | 422 | accept | — |
| [`fixtures/history-checks/error-query-not-found.json`](fixtures/history-checks/error-query-not-found.json) | `GET /api/history/checks/:endpoint` | `error-query-not-found` | error | 404 | accept | — |
| [`fixtures/history-checks/error-range-unsupported.json`](fixtures/history-checks/error-range-unsupported.json) | `GET /api/history/checks/:endpoint` | `error-range-unsupported` | error | 422 | accept | — |
| [`fixtures/history-checks/error-source-timeout.json`](fixtures/history-checks/error-source-timeout.json) | `GET /api/history/checks/:endpoint` | `error-source-timeout` | error | 504 | accept | — |
| [`fixtures/history-checks/error-source-unavailable.json`](fixtures/history-checks/error-source-unavailable.json) | `GET /api/history/checks/:endpoint` | `error-source-unavailable` | error | 502 | accept | — |
| [`fixtures/history-checks/error-target-not-found.json`](fixtures/history-checks/error-target-not-found.json) | `GET /api/history/checks/:endpoint` | `error-target-not-found` | error | 404 | accept | — |
| [`fixtures/history-checks/max-size.json`](fixtures/history-checks/max-size.json) | `GET /api/history/checks/:endpoint` | `max-size` | response | 200 | accept | — |
| [`fixtures/history-checks/typical.json`](fixtures/history-checks/typical.json) | `GET /api/history/checks/:endpoint` | `typical` | response | 200 | accept | — |
| [`fixtures/history-checks/unknown-enum-interval-state.json`](fixtures/history-checks/unknown-enum-interval-state.json) | `GET /api/history/checks/:endpoint` | `unknown-enum-interval-state` | response | 200 | accept | — |
| [`fixtures/history-checks/unknown-enum-provenance.json`](fixtures/history-checks/unknown-enum-provenance.json) | `GET /api/history/checks/:endpoint` | `unknown-enum-provenance` | response | 200 | accept | — |
| [`fixtures/history-checks/unknown-enum-range-id.json`](fixtures/history-checks/unknown-enum-range-id.json) | `GET /api/history/checks/:endpoint` | `unknown-enum-range-id` | response | 200 | accept | — |
| [`fixtures/history-estate/all-optional.json`](fixtures/history-estate/all-optional.json) | `GET /api/history/estate/:queryId` | `all-optional` | response | 200 | accept | — |
| [`fixtures/history-estate/bundle-error.json`](fixtures/history-estate/bundle-error.json) | `GET /api/history/estate/:queryId` | `bundle-error` | error | 503 | accept | — |
| [`fixtures/history-estate/empty.json`](fixtures/history-estate/empty.json) | `GET /api/history/estate/:queryId` | `empty` | response | 200 | accept | — |
| [`fixtures/history-estate/error-history-cancelled.json`](fixtures/history-estate/error-history-cancelled.json) | `GET /api/history/estate/:queryId` | `error-history-cancelled` | error | 503 | accept | — |
| [`fixtures/history-estate/error-history-limit-exceeded.json`](fixtures/history-estate/error-history-limit-exceeded.json) | `GET /api/history/estate/:queryId` | `error-history-limit-exceeded` | error | 502 | accept | — |
| [`fixtures/history-estate/error-history-overloaded.json`](fixtures/history-estate/error-history-overloaded.json) | `GET /api/history/estate/:queryId` | `error-history-overloaded` | error | 503 | accept | — |
| [`fixtures/history-estate/error-invalid-request.json`](fixtures/history-estate/error-invalid-request.json) | `GET /api/history/estate/:queryId` | `error-invalid-request` | error | 400 | accept | — |
| [`fixtures/history-estate/error-model-changed.json`](fixtures/history-estate/error-model-changed.json) | `GET /api/history/estate/:queryId` | `error-model-changed` | error | 503 | accept | — |
| [`fixtures/history-estate/error-query-not-applicable.json`](fixtures/history-estate/error-query-not-applicable.json) | `GET /api/history/estate/:queryId` | `error-query-not-applicable` | error | 422 | accept | — |
| [`fixtures/history-estate/error-query-not-found.json`](fixtures/history-estate/error-query-not-found.json) | `GET /api/history/estate/:queryId` | `error-query-not-found` | error | 404 | accept | — |
| [`fixtures/history-estate/error-range-unsupported.json`](fixtures/history-estate/error-range-unsupported.json) | `GET /api/history/estate/:queryId` | `error-range-unsupported` | error | 422 | accept | — |
| [`fixtures/history-estate/error-source-timeout.json`](fixtures/history-estate/error-source-timeout.json) | `GET /api/history/estate/:queryId` | `error-source-timeout` | error | 504 | accept | — |
| [`fixtures/history-estate/error-source-unavailable.json`](fixtures/history-estate/error-source-unavailable.json) | `GET /api/history/estate/:queryId` | `error-source-unavailable` | error | 502 | accept | — |
| [`fixtures/history-estate/error-target-not-found.json`](fixtures/history-estate/error-target-not-found.json) | `GET /api/history/estate/:queryId` | `error-target-not-found` | error | 404 | accept | — |
| [`fixtures/history-estate/max-size-points.json`](fixtures/history-estate/max-size-points.json) | `GET /api/history/estate/:queryId` | `max-size-points` | response | 200 | accept | — |
| [`fixtures/history-estate/max-size-series.json`](fixtures/history-estate/max-size-series.json) | `GET /api/history/estate/:queryId` | `max-size-series` | response | 200 | accept | — |
| [`fixtures/history-estate/typical.json`](fixtures/history-estate/typical.json) | `GET /api/history/estate/:queryId` | `typical` | response | 200 | accept | — |
| [`fixtures/history-estate/unknown-enum-query-id.json`](fixtures/history-estate/unknown-enum-query-id.json) | `GET /api/history/estate/:queryId` | `unknown-enum-query-id` | response | 200 | accept | — |
| [`fixtures/history-estate/unknown-enum-unit.json`](fixtures/history-estate/unknown-enum-unit.json) | `GET /api/history/estate/:queryId` | `unknown-enum-unit` | response | 200 | accept | — |
| [`fixtures/history-target/all-optional.json`](fixtures/history-target/all-optional.json) | `GET /api/history/target/:drilldownId/:queryId` | `all-optional` | response | 200 | accept | — |
| [`fixtures/history-target/bundle-error.json`](fixtures/history-target/bundle-error.json) | `GET /api/history/target/:drilldownId/:queryId` | `bundle-error` | error | 503 | accept | — |
| [`fixtures/history-target/empty.json`](fixtures/history-target/empty.json) | `GET /api/history/target/:drilldownId/:queryId` | `empty` | response | 200 | accept | — |
| [`fixtures/history-target/error-history-cancelled.json`](fixtures/history-target/error-history-cancelled.json) | `GET /api/history/target/:drilldownId/:queryId` | `error-history-cancelled` | error | 503 | accept | — |
| [`fixtures/history-target/error-history-limit-exceeded.json`](fixtures/history-target/error-history-limit-exceeded.json) | `GET /api/history/target/:drilldownId/:queryId` | `error-history-limit-exceeded` | error | 502 | accept | — |
| [`fixtures/history-target/error-history-overloaded.json`](fixtures/history-target/error-history-overloaded.json) | `GET /api/history/target/:drilldownId/:queryId` | `error-history-overloaded` | error | 503 | accept | — |
| [`fixtures/history-target/error-invalid-request.json`](fixtures/history-target/error-invalid-request.json) | `GET /api/history/target/:drilldownId/:queryId` | `error-invalid-request` | error | 400 | accept | — |
| [`fixtures/history-target/error-model-changed.json`](fixtures/history-target/error-model-changed.json) | `GET /api/history/target/:drilldownId/:queryId` | `error-model-changed` | error | 503 | accept | — |
| [`fixtures/history-target/error-query-not-applicable.json`](fixtures/history-target/error-query-not-applicable.json) | `GET /api/history/target/:drilldownId/:queryId` | `error-query-not-applicable` | error | 422 | accept | — |
| [`fixtures/history-target/error-query-not-found.json`](fixtures/history-target/error-query-not-found.json) | `GET /api/history/target/:drilldownId/:queryId` | `error-query-not-found` | error | 404 | accept | — |
| [`fixtures/history-target/error-range-unsupported.json`](fixtures/history-target/error-range-unsupported.json) | `GET /api/history/target/:drilldownId/:queryId` | `error-range-unsupported` | error | 422 | accept | — |
| [`fixtures/history-target/error-source-timeout.json`](fixtures/history-target/error-source-timeout.json) | `GET /api/history/target/:drilldownId/:queryId` | `error-source-timeout` | error | 504 | accept | — |
| [`fixtures/history-target/error-source-unavailable.json`](fixtures/history-target/error-source-unavailable.json) | `GET /api/history/target/:drilldownId/:queryId` | `error-source-unavailable` | error | 502 | accept | — |
| [`fixtures/history-target/error-target-not-found.json`](fixtures/history-target/error-target-not-found.json) | `GET /api/history/target/:drilldownId/:queryId` | `error-target-not-found` | error | 404 | accept | — |
| [`fixtures/history-target/max-size-points.json`](fixtures/history-target/max-size-points.json) | `GET /api/history/target/:drilldownId/:queryId` | `max-size-points` | response | 200 | accept | — |
| [`fixtures/history-target/max-size-series.json`](fixtures/history-target/max-size-series.json) | `GET /api/history/target/:drilldownId/:queryId` | `max-size-series` | response | 200 | accept | — |
| [`fixtures/history-target/typical.json`](fixtures/history-target/typical.json) | `GET /api/history/target/:drilldownId/:queryId` | `typical` | response | 200 | accept | — |
| [`fixtures/overview/all-optional.json`](fixtures/overview/all-optional.json) | `GET /api/overview` | `all-optional` | response | 200 | accept | — |
| [`fixtures/overview/bundle-error.json`](fixtures/overview/bundle-error.json) | `GET /api/overview` | `bundle-error` | error | 503 | accept | — |
| [`fixtures/overview/empty.json`](fixtures/overview/empty.json) | `GET /api/overview` | `empty` | response | 200 | accept | — |
| [`fixtures/overview/error-invalid-request.json`](fixtures/overview/error-invalid-request.json) | `GET /api/overview` | `error-invalid-request` | error | 400 | accept | — |
| [`fixtures/overview/error-not-ready.json`](fixtures/overview/error-not-ready.json) | `GET /api/overview` | `error-not-ready` | error | 503 | accept | — |
| [`fixtures/overview/max-size.json`](fixtures/overview/max-size.json) | `GET /api/overview` | `max-size` | response | 200 | accept | — |
| [`fixtures/overview/typical.json`](fixtures/overview/typical.json) | `GET /api/overview` | `typical` | response | 200 | accept | — |
| [`fixtures/overview/unknown-enum-overview-severity.json`](fixtures/overview/unknown-enum-overview-severity.json) | `GET /api/overview` | `unknown-enum-overview-severity` | response | 200 | accept | — |
| [`fixtures/overview/unknown-enum-target-status.json`](fixtures/overview/unknown-enum-target-status.json) | `GET /api/overview` | `unknown-enum-target-status` | response | 200 | accept | — |
| [`fixtures/overview/unknown-fields.json`](fixtures/overview/unknown-fields.json) | `GET /api/overview` | `unknown-fields` | response | 200 | accept | — |
| [`fixtures/push-device/all-muted.json`](fixtures/push-device/all-muted.json) | `PUT /api/push/device` | `all-muted` | request | — | accept | — |
| [`fixtures/push-device/reject-missing-preferences.json`](fixtures/push-device/reject-missing-preferences.json) | `PUT /api/push/device` | `reject-missing-preferences` | request | — | reject | rejection `INVALID_REQUEST` |
| [`fixtures/push-device/reject-token-format.json`](fixtures/push-device/reject-token-format.json) | `PUT /api/push/device` | `reject-token-format` | request | — | reject | rejection `INVALID_REQUEST` |
| [`fixtures/push-device/reject-unknown-environment.json`](fixtures/push-device/reject-unknown-environment.json) | `PUT /api/push/device` | `reject-unknown-environment` | request | — | reject | rejection `INVALID_REQUEST` |
| [`fixtures/push-device/sandbox.json`](fixtures/push-device/sandbox.json) | `PUT /api/push/device` | `sandbox` | request | — | accept | — |
| [`fixtures/push-device/typical.json`](fixtures/push-device/typical.json) | `PUT /api/push/device` | `typical` | request | — | accept | — |
| [`fixtures/push-device/unknown-enum-push-environment.json`](fixtures/push-device/unknown-enum-push-environment.json) | `PUT /api/push/device` | `unknown-enum-push-environment` | request | — | reject | rejection `INVALID_REQUEST` |
| [`fixtures/push-pairing/max-length-name.json`](fixtures/push-pairing/max-length-name.json) | `POST /api/push/pairings/redeem` | `max-length-name` | request | — | accept | — |
| [`fixtures/push-pairing/reject-name-charset.json`](fixtures/push-pairing/reject-name-charset.json) | `POST /api/push/pairings/redeem` | `reject-name-charset` | request | — | reject | rejection `INVALID_REQUEST` |
| [`fixtures/push-pairing/reject-name-too-long.json`](fixtures/push-pairing/reject-name-too-long.json) | `POST /api/push/pairings/redeem` | `reject-name-too-long` | request | — | reject | rejection `INVALID_REQUEST` |
| [`fixtures/push-pairing/reject-unknown-field.json`](fixtures/push-pairing/reject-unknown-field.json) | `POST /api/push/pairings/redeem` | `reject-unknown-field` | request | — | reject | rejection `INVALID_REQUEST` |
| [`fixtures/push-pairing/typical.json`](fixtures/push-pairing/typical.json) | `POST /api/push/pairings/redeem` | `typical` | request | — | accept | — |
| [`fixtures/push-payload/firing-critical.json`](fixtures/push-payload/firing-critical.json) | `push-payload` | `firing-critical` | payload | — | accept | — |
| [`fixtures/push-payload/firing-info.json`](fixtures/push-payload/firing-info.json) | `push-payload` | `firing-info` | payload | — | accept | — |
| [`fixtures/push-payload/firing-unknown-severity.json`](fixtures/push-payload/firing-unknown-severity.json) | `push-payload` | `firing-unknown-severity` | payload | — | accept | — |
| [`fixtures/push-payload/firing-warning.json`](fixtures/push-payload/firing-warning.json) | `push-payload` | `firing-warning` | payload | — | accept | — |
| [`fixtures/push-payload/no-badge.json`](fixtures/push-payload/no-badge.json) | `push-payload` | `no-badge` | payload | — | accept | — |
| [`fixtures/push-payload/repeat.json`](fixtures/push-payload/repeat.json) | `push-payload` | `repeat` | payload | — | accept | — |
| [`fixtures/push-payload/resolved.json`](fixtures/push-payload/resolved.json) | `push-payload` | `resolved` | payload | — | accept | — |
| [`fixtures/push-payload/summary-mixed.json`](fixtures/push-payload/summary-mixed.json) | `push-payload` | `summary-mixed` | payload | — | accept | — |
| [`fixtures/push-payload/summary-resolved-only.json`](fixtures/push-payload/summary-resolved-only.json) | `push-payload` | `summary-resolved-only` | payload | — | accept | — |
| [`fixtures/push-payload/test.json`](fixtures/push-payload/test.json) | `push-payload` | `test` | payload | — | accept | — |
| [`fixtures/push-payload/truncated-max-length.json`](fixtures/push-payload/truncated-max-length.json) | `push-payload` | `truncated-max-length` | payload | — | accept | — |
| [`fixtures/push-payload/unknown-enum-push-alert-status.json`](fixtures/push-payload/unknown-enum-push-alert-status.json) | `push-payload` | `unknown-enum-push-alert-status` | payload | — | accept | — |
| [`fixtures/push-payload/unknown-enum-push-category.json`](fixtures/push-payload/unknown-enum-push-category.json) | `push-payload` | `unknown-enum-push-category` | payload | — | accept | — |
| [`fixtures/push-payload/unknown-enum-push-interruption-level.json`](fixtures/push-payload/unknown-enum-push-interruption-level.json) | `push-payload` | `unknown-enum-push-interruption-level` | payload | — | accept | — |
| [`fixtures/push-payload/unknown-enum-push-kind.json`](fixtures/push-payload/unknown-enum-push-kind.json) | `push-payload` | `unknown-enum-push-kind` | payload | — | accept | — |
| [`fixtures/push-payload/unknown-enum-push-severity.json`](fixtures/push-payload/unknown-enum-push-severity.json) | `push-payload` | `unknown-enum-push-severity` | payload | — | accept | — |
| [`fixtures/push-payload/unknown-enum-push-target-screen.json`](fixtures/push-payload/unknown-enum-push-target-screen.json) | `push-payload` | `unknown-enum-push-target-screen` | payload | — | accept | — |
| [`fixtures/push-payload/unknown-field.json`](fixtures/push-payload/unknown-field.json) | `push-payload` | `unknown-field` | payload | — | accept | — |
| [`fixtures/session/all-optional.json`](fixtures/session/all-optional.json) | `GET /api/session` | `all-optional` | response | 200 | accept | — |
| [`fixtures/session/empty.json`](fixtures/session/empty.json) | `GET /api/session` | `empty` | response | 200 | accept | — |
| [`fixtures/session/error-invalid-request.json`](fixtures/session/error-invalid-request.json) | `GET /api/session` | `error-invalid-request` | error | 400 | accept | — |
| [`fixtures/session/max-size.json`](fixtures/session/max-size.json) | `GET /api/session` | `max-size` | response | 200 | accept | — |
| [`fixtures/session/typical.json`](fixtures/session/typical.json) | `GET /api/session` | `typical` | response | 200 | accept | — |
| [`fixtures/session/unknown-capability.json`](fixtures/session/unknown-capability.json) | `GET /api/session` | `unknown-capability` | response | 200 | accept | — |
| [`fixtures/session/unknown-enum-auth-mode.json`](fixtures/session/unknown-enum-auth-mode.json) | `GET /api/session` | `unknown-enum-auth-mode` | response | 200 | accept | — |
| [`fixtures/timeline/all-optional.json`](fixtures/timeline/all-optional.json) | `GET /api/timeline` | `all-optional` | response | 200 | accept | — |
| [`fixtures/timeline/bundle-error.json`](fixtures/timeline/bundle-error.json) | `GET /api/timeline` | `bundle-error` | error | 503 | accept | — |
| [`fixtures/timeline/empty.json`](fixtures/timeline/empty.json) | `GET /api/timeline` | `empty` | response | 200 | accept | — |
| [`fixtures/timeline/error-invalid-request.json`](fixtures/timeline/error-invalid-request.json) | `GET /api/timeline` | `error-invalid-request` | error | 400 | accept | — |
| [`fixtures/timeline/error-not-ready.json`](fixtures/timeline/error-not-ready.json) | `GET /api/timeline` | `error-not-ready` | error | 503 | accept | — |
| [`fixtures/timeline/max-size.json`](fixtures/timeline/max-size.json) | `GET /api/timeline` | `max-size` | response | 200 | accept | — |
| [`fixtures/timeline/typical.json`](fixtures/timeline/typical.json) | `GET /api/timeline` | `typical` | response | 200 | accept | — |
<!-- /generated:fixtures -->

<a id="extending"></a>

## Extending the contract

Every checklist below ends the same way: run `bun run contract:gen`, commit everything under `contract/`, and make
sure `bun test` passes.

1. **Endpoint.** Add the wire type to `packages/web-data` and its root to `SHAPE_ROOTS`. Add the route (GET only). Add
   a `ContractOperation` to `OPERATIONS`, with its error rows. Add a scenario module (typical, empty, all-optional,
   max-size and each error) to `scenarios/index.ts`. Add any caps to `CONTRACT_LIMITS` and any enum entries to
   `ENUM_FALLBACKS`. Bump `minor`.
2. **Capability.** Append the name to `KNOWN_SERVER_CAPABILITIES`. Call `registerCapabilityProvider` with a synchronous
   in-process predicate that is true only while the feature works. Add a session fixture with the capability present.
   Describe the feature it gates under [Handshake](#handshake). Bump `minor`.
3. **Event type.** Add the event name and its data type (a new `SHAPE_ROOTS` member). Frame it with the same encoder
   as `tick`. Add a fixture and an `.sse` transcript. Document it under [Live events](#events). Bump `minor`. Old
   clients ignore it under the [tolerance rules](#tolerance).
4. **Fixture.** Add a scenario to the group's module. Never write fixture JSON by hand. Use only the allowlisted
   placeholders (`pulse.example.com`, `192.0.2.x`, `2001:db8::`). Keep max-size fixtures small: put every collection
   exactly at its cap with minimal items (shortest valid strings, optional fields omitted, nested arrays empty); write
   one max-size fixture per operation and never combine it with all-optional; fill only capped collections (estate
   fills only `liveTargets`, `findings` and `declaredVersusScraped`). Stay within the budget enforced by
   `apps/web/tests/contract/perf-budget.test.ts`.
5. **Connect-link parameter.** Append the name to `KNOWN_LINK_PARAMS` (it must match `LINK_PARAM_NAME_PATTERN` and
   must not be `v` or `url`). Add valid and invalid connect-link fixtures. Document it under
   [Connect link](#connect-link). The link format version does not change. Bump the contract `minor`.
