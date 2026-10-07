# Source client fixtures

Checked-in, sanitized upstream response fixtures for the `@pulse/web-data/sources` clients
(03-source-clients-and-validation.md §4). Every fixture is hand-sanitized: estate is the
synthetic `reference-estate`, hosts are `harbor-*`, and no fixture contains real hostnames,
credentials, authorization headers, tokens, or secret values.

Pinned upstream versions (§4):

| Source | Version | Fixtures |
|---|---|---|
| VictoriaMetrics | 1.102.1 | `vm/**` — `/api/v1/query` (vector), `/api/v1/query_range` (matrix), `/api/v1/targets`, `/api/v1/status/buildinfo` |
| vmalert | 1.102.1 | `vmalert/**` — `/api/v1/rules` (groups, alerting + recording rules, deadman canary) |
| Alertmanager | 0.27.0 | `alertmanager/**` — `/api/v2/alerts`, `/api/v2/silences`, `/api/v2/status`, `/api/v2/receivers`, and the dark `POST /api/v2/silences` success |
| Gatus | 5.13.1 | `gatus/**` — `/api/v1/endpoints/statuses?page=1&pageSize=512` and the pinned per-endpoint history `/api/v1/endpoints/{key}/statuses` |
| Grafana | 11.4.0 | `grafana/**` — `/api/health` (database/version envelope) |

For each operation the matrix retains: a success envelope, an additive-unknown-field
success (extra upstream keys that must pass and be stripped), a malformed top-level body,
and a malformed consumed nested-field case (must fail the whole operation). The VM instant
vector fixture exercises the status selectors plus all seven engine projections, including a
`NaN`/`+Inf` sample retained as unavailable and two engine aliases whose non-name labels
collide (both must survive parsing).

`vm/instant-unavailable.json` and `vm/range-unavailable.json` isolate the full
unavailability matrix — an empty-string value (insufficient-window/insufficient-rate),
`NaN`, `+Inf`, and `-Inf` — every one of which must parse to `null` (never `0`), alongside a
genuine `"0"` sample proving unavailable never masquerades as zero.

The `vmalert/**` fixtures exercise the `/api/v1/rules` matrix — multiple rule groups, alerting
rules across firing/pending/inactive states, an unhealthy rule (`health:"err"`) with a bounded
`lastError`, a recording rule (no `state`), and the always-firing `DeadMansSwitch` canary whose
`deadman` marker derives from the configured rule identity rather than its firing status.
`rules-additive.json` carries additive unknown fields at the top, group, and rule levels (all
stripped); `rules-malformed-top.json` makes `data.groups` a non-array; `rules-malformed-nested.json`
omits a required consumed rule field (`health`); and `rules-unsupported-type.json` carries an
unsupported rule discriminator — each of the last three fails the whole operation with no subset
published. Non-allowlisted labels/annotations (`estate`, `team_owner`, `internal_note`) prove
safe-map stripping.

The `alertmanager/**` fixtures exercise the read matrix — firing/silenced/inhibited alerts
with their suppression relationships, receivers, and group; complete silences across
active/pending/expired states with regex/equality matchers; the safe status/receiver
summaries (`alertmanager/status-success.json` carries a `config`/`configYAML` body that must
never surface in a result); additive unknown fields; malformed top-level and consumed nested
fields; and the over-bound triage-map case (`alerts-overbound.json`, a >256-byte annotation
value that fails the whole operation with `incompatible`). `create-silence-success.json`
is the dark `POST /api/v2/silences` success body; the DELETE `expireSilence` success carries
an empty body.

The `gatus/**` fixtures exercise the completeness/history matrix for the one fixed
`page=1&pageSize=512` statuses request and the pinned per-endpoint history endpoint.
`statuses-success.json` covers all three endpoint-identity kinds — a service endpoint
(`harbor-web-01/portal-web`), a probe-only host (`host:harbor-edge-01`), and a domain probe
(`dns:nimbus.example`) — each retaining its `name`/`group`/`key` and every recent result with
condition results. `statuses-additive.json` carries additive unknown fields at the endpoint,
result, and condition-result levels (all stripped). `statuses-malformed-top.json` is a
non-array body; `statuses-malformed-endpoint.json` omits the required `key`;
`statuses-malformed-nested.json` carries an unparseable result `timestamp` — each of the last
three fails the whole operation with `invalid-shape`. `statuses-duplicate.json` repeats one
identity (`name`) under two keys, proving duplicate-identity `overflow` with no subset salvage.
The 511-success and 512-overflow boundary pages, the missing-expected-identity case, and the
`expected` estate-size bound are generated deterministically in the test rather than committed
as a 512-element fixture. `endpoint-history-success.json` is the pinned per-endpoint history
body (a single endpoint object with a multi-result history including a slow 5 s failure).

The `grafana/**` fixtures exercise the optional `/api/health` envelope. `health-success.json`
is the pinned success body (`database: "ok"`, `version: "11.4.0"`, plus an additive `commit`
that must be stripped); `health-additive.json` carries extra additive upstream fields
(`enterpriseCommit`, `hasUpdate`, `unknownHealthField`) that all pass and are stripped;
`health-malformed-top.json` is a non-object (bare array) body; `health-malformed-nested.json`
carries a wrong-typed consumed `version` field — both malformed cases fail the whole operation
with `invalid-shape`. `health-recovery.json` is a valid degraded envelope (`database:
"failing"`) proving the client preserves a non-`ok` database token verbatim and serves as the
recovered success after a transient failure. No fixture carries credentials or real estate values.
