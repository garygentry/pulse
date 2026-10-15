# Changelog

All notable changes to Pulse are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Pulse uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While Pulse is below 1.0, a minor
release can contain breaking changes; each one is listed under **Breaking** and explained in the
upgrade notes.

## [Unreleased]

## [0.2.0] - 2026-10-15

The first tagged public release. It covers everything merged to `main` since the public
repository's initial commit. Operators upgrading an earlier deployment should read
[Upgrading to 0.2.0](docs/operator/upgrade-path.md#upgrading-to-020) first: the Gatus paging
change below needs a new vmalert mount.

### Breaking

- **Gatus checks page from vmalert, not from a Gatus alerting provider.** The Gatus →
  Alertmanager push provider is removed because it could not resolve alerts correctly (late and
  false resolves). Each service with an `alerts:` binding now renders a critical
  `GatusCheckFailed` rule into `rendered/vmalert/rules/synthetic.yml`, built from Gatus's own
  `gatus_results_total` metrics, and a Gatus outage never resolves it. You **must** re-run
  `alerting:render` and mount `synthetic.yml` into vmalert, or Gatus paging stops. Alert labels,
  and so fingerprints, change at cutover, so silences that match the full old label set need
  updating. The committed compose file adds the vmalert flags `-remoteRead.url`,
  `-datasource.queryStep=5m` and `-rule.resendDelay=1m`. `type` and `send_on_resolved` on a
  binding no longer have any effect. (#21)
- **`synthetic.yml` must be mounted even when no service has a binding.** The file now always
  holds a `pulse:synthetic_checks_bound` recording rule, so vmalert needs `-remoteWrite.url`
  (already set in the committed compose file) or it fails at startup. (#53)
- **New validation errors.** `failure_threshold` and `success_threshold` are capped at 60, and a
  host name, service name or estate domain containing `"`, `\` or a line break is rejected
  (`gatus_unsafe_name`), because Gatus fails to start on such a name. (#21)
- **`HostDown` covers every host class.** It now pages for `nas-api` and `hypervisor-api`
  hosts as well as `managed-linux` ones. A silence or inhibit rule that matches
  `alertname="HostDown"` without a `host` matcher now also mutes NAS and hypervisor hosts; add
  `collection_class="managed-linux"` to keep the old scope. (#76)
- **`AncillaryDown` no longer covers pve-exporter.** A pve-exporter outage now raises
  `HypervisorExporterDown`; move routes and silences on `AncillaryDown{job="pve-exporter"}` to it.
  (#76)
- **Hypervisor scraping passes a bare host to pve-exporter.** The `hypervisor-api` job now sends
  the bare PVE host as `?target=` (the exporter always talks to port 8006). An endpoint on another
  port needs a downstream override of the job. (#76)
- **New validation error `invalid_hypervisor_endpoint`.** A hypervisor `api_endpoint` must be
  `[http(s)://]HOST[:PORT][/PATH]`; user info, a query, a fragment, an unbracketed IPv6 literal
  or a non-numeric port is rejected. (#76)

### Added

- **`SyntheticRulesNotLoaded`** warning in the `pipeline-health` family. It fires about 10–15
  minutes after vmalert stops loading `synthetic.yml`, so a dropped mount no longer silences
  Gatus paging without a trace. (#53)
- **Critical host-down paging for NAS and hypervisor hosts.** `HostDown` (critical, `for: 90s`)
  reads `up` of the main scrape job of every class (`managed-linux|nas-api|hypervisor-api`), and
  its `host` label comes from the rendered file_sd `host` label. (#76)
- **`HypervisorExporterDown`** warning (`up{job="pve-exporter"} == 0`, `for: 60s`,
  `keep_firing_for: 2m`), plus an Alertmanager inhibit rule (source `HypervisorExporterDown`,
  target `HostDown{job="hypervisor-api"}`, equal on `estate`) in both the bootstrap config and
  every config the alerting transform renders. A pve-exporter outage no longer pages every
  hypervisor as down. (#76)
- **Kiosk tile wall.** `?kiosk=1` on the overview shows a read-only wall of compact host tiles,
  worst status first, under a one-line stat strip and alert ribbon. Pages are sized from the real
  grid (columns × rows), each page stays up for at least 10 seconds, rotations resume where the
  last visit stopped, and a host that newly turns critical brings the wall back to page 1. (#65)
- **Content-Security-Policy and hardening headers** on every web response. See Security. (#38)
- **Virtualized estate inventory tree** for large estates, with stacked rows on mobile. (#40)
- **Session-expiry handling** behind a forward-auth proxy: an expired session shows "Session
  expired" with a Reload page button, keeps the last data on screen as stale, and refuses writes
  without changing anything. (#66)
- **Scripted drift check for the vendored `@/ui` library** (`bun run ui:drift`, plus a CI
  workflow), backed by a `VENDORED.json` manifest. (#45)
- **CI-only visual-regression baselines** for the web app (`bun run visual`, regenerated by the
  dev-only `visual-update.yml` workflow). (#46)
- **Dev mock** serves Alertmanager silences and VictoriaMetrics/Gatus history, so `--mock` no
  longer shows Alertmanager as unreachable or history as unavailable. (#60)

### Changed

- **Host liveness means the host's main scrape job everywhere.** The overview grid, kiosk tiles,
  estate inventory, liveness history and the server snapshot treat a host as live only when `up`
  of its main job (`managed-linux`, `nas-api` or `hypervisor-api`) is 1, the same series
  `HostDown` reads. Auxiliary exporters and `pulse_agent_up` no longer decide host liveness. (#71,
  #73)
- **Estate coverage** has a new `engine` state for the stack's own scrape jobs, rows name their
  job, and a target of a host-labelled job matches only on its exact `host:port`. (#71, #73)
- **Hypervisor hosts** show "Capacity metrics not collected for this host" instead of four empty
  charts, and probe-only hosts show "Not collected" for liveness history. (#71, #73)
- **Alerts triage and the timeline lane tree** use the shared `useListNavigation` keyboard, with
  a single Tab stop per list. (#70)
- **Overview desk grid keyboard** runs on `useListNavigation`, the last bespoke list keyboard
  (closes #37). The grid stays a single Tab stop with the same spatial arrow moves, Home/End go
  to the first/last host, and j/k now move like ↓/↑. (#75)
- **Keyboard and accessibility follow-ups** after the `@/ui` port: arrow-key roving in the side
  navigation, Ctrl/Cmd-B and Ctrl/Cmd-K behaviour in text fields, disclosure counts, and
  timeline range shortcuts announced to assistive technology. (#35)
- **Engine page**: unit-aware Trends axes, de-duplicated card captions, "not reported" stat
  tiles, and swimlane info bars. (#42)
- **Smaller initial load**: per-view chunks, and icons kept off the initial route. (#39)
- **Vendored `@/ui`** re-synced with deck v0.5.0, with the follow-ups from its review
  (timeline screen-reader list cost, keyboard-reachable scrollers, one clock for alert-detail
  history). (#50, #63)
- **Alert-detail firing history** is coloured by severity, not always red. (#55)
- **Entity pages** describe an endpoint alert binding as the vmalert rule it renders. (#52)

### Fixed

- **Host history matched no real data**: the host drawer's liveness line and the timeline's
  CPU, memory, disk and load charts now bind on the post-relabel `job` / `instance` labels, and
  declared-versus-scraped no longer lists every managed and NAS target as missing. (#71)
- **A host with a down node_exporter looked healthy** on the overview while `HostDown` fired,
  because any auxiliary exporter kept it live. (#73)
- **Estate badges stayed green while Pulse itself was stale**, and inventory coverage badges
  stayed green while coverage was not current. (#54, #25)
- **Unreachable or timed-out server** errors are reported as such, and view requests have an
  8-second deadline instead of hanging. (#61)
- **An empty liveness range** shows a no-samples state instead of an error with a Retry that
  could never succeed. (#68)
- **Stock hypervisor scraping was broken**: the rendered URL was passed to pve-exporter as
  `?target=`, which the pinned exporter answers with HTTP 500, so every hypervisor read as down.
  `instance` is unchanged. (#76)
- The no-target `estate.liveness` history query returns 422 `QUERY_NOT_APPLICABLE` instead of
  a query that mixed in profile-gated jobs. (#76)
- Alert targets showed their kind prefix twice (`host:host:…`). (#22)
- Virtualized tables mis-measured rows of varying height, so scrolling jumped and
  `scrollToIndex` missed. (#24)
- In-app navigation dropped the URL `#fragment`. (#27)
- Incremental dev rebuilds deleted fonts and sourcemaps. (#28)
- Mock Alertmanager, vmalert and VictoriaMetrics timestamps were not re-based onto the scenario
  clock, so alerts looked months old. (#31)
- `@/ui` port edge cases: the findings filter's "All" value collision, a silent command-palette
  chunk failure, firing info alerts shown as `unknown`, and the timeline `?sel=` prefix. (#34)
- Estate live badge read "Live Live state…". (#52)
- Kiosk wallboards for alerts and estate had no side gutter, and estate/alerts tabs overflowed
  at phone width. (#55, #62)
- Known CI and load flakes made deterministic, without retries. (#59)
- A failed production build rollback no longer loses the previous assets. (#60)

### Security

- The web app sends a strict `Content-Security-Policy` (hashed inline script, per-response style
  nonce, no `unsafe-inline`, `frame-ancestors 'none'`), plus `Cross-Origin-Opener-Policy`,
  `Permissions-Policy`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`.
  Production fails closed if the shell's inline script drifts from the build's recorded hash. Do
  not add a second CSP at your reverse proxy; set HSTS there if you serve Pulse only over HTTPS.
  (#38)
- Requests use `redirect: "manual"`, so a forward-auth proxy's login redirect is detected and
  never followed silently. (#66)

### Documentation and internal

- README: MIT license badge and section. (#20)
- `AGENTS.md` is the single source of agent instructions, and lists `ALERT_STATE` among the
  status maps. (#43, #47)
- New `@/ui` guardrail checks: token resolution, page structure, list keyboards and tabs. (#36)

[Unreleased]: https://github.com/garygentry/pulse/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/garygentry/pulse/releases/tag/v0.2.0
