# Pulse client contract

This document is the contract between the Pulse web server and separately installed Pulse clients. Sections between
`generated:` comment markers are produced by `bun run contract:gen`. Everything else is written by hand.

Contents: [About](#about) · [Versioning](#versioning) · [Handshake](#handshake) ·
[Announcing the client](#announcing) · [Tolerance rules](#tolerance) · [Operations](#operations) ·
[Response fields](#fields) · [Limits](#limits) · [Enum fallbacks](#enum-fallbacks) · [Caching](#caching) ·
[Live events](#events) · [Request limits](#request-limits) · [Authentication](#auth) ·
[Not in the contract](#not-in-contract) · [Connect link](#connect-link) · [Fixtures](#fixtures) ·
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

The current contract version is `1.0` (`CONTRACT_VERSION`). The [Fixtures](#fixtures) section repeats the version the
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
is listed only while the feature is available. Contract 1.0 defines no capability, so the list is `[]`. A client must
hide any feature whose capability is absent, and must ignore capability names it does not know.

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
<!-- /generated:fields:SessionPayload -->

<a id="fields-overviewsnapshotv2"></a>

### OverviewSnapshotV2

<!-- generated:fields:OverviewSnapshotV2 -->
<!-- /generated:fields:OverviewSnapshotV2 -->

<a id="fields-alertspayload"></a>

### AlertsPayload

<!-- generated:fields:AlertsPayload -->
<!-- /generated:fields:AlertsPayload -->

<a id="fields-estatepayload"></a>

### EstatePayload

<!-- generated:fields:EstatePayload -->
<!-- /generated:fields:EstatePayload -->

<a id="fields-timelinepayload"></a>

### TimelinePayload

<!-- generated:fields:TimelinePayload -->
<!-- /generated:fields:TimelinePayload -->

<a id="fields-historypayload"></a>

### HistoryPayload

<!-- generated:fields:HistoryPayload -->
<!-- /generated:fields:HistoryPayload -->

<a id="fields-intervalhistorypayload"></a>

### IntervalHistoryPayload

<!-- generated:fields:IntervalHistoryPayload -->
<!-- /generated:fields:IntervalHistoryPayload -->

<a id="fields-endpointhistorypayload"></a>

### EndpointHistoryPayload

<!-- generated:fields:EndpointHistoryPayload -->
<!-- /generated:fields:EndpointHistoryPayload -->

<a id="fields-livetick"></a>

### LiveTick

<!-- generated:fields:LiveTick -->
<!-- /generated:fields:LiveTick -->

<a id="fields-errorenvelope"></a>

### ErrorEnvelope

<!-- generated:fields:ErrorEnvelope -->
<!-- /generated:fields:ErrorEnvelope -->

<a id="fields-bundleerrorbody"></a>

### BundleErrorBody

<!-- generated:fields:BundleErrorBody -->
<!-- /generated:fields:BundleErrorBody -->

<a id="limits"></a>

## Limits

<!-- generated:limits -->
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
  does not know. Adding one needs no format version bump. Contract 1.0 defines no extra parameter, and a link carries
  no secret.
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
