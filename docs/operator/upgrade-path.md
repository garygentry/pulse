---
title: Upgrade path
description: Adopting a new Pulse stack revision — re-render, diff-review in git, re-apply idempotently.
slug: upgrade-path
---

# Upgrade path

Adopting a new Pulse revision is the **same three moves every time** — there is no bespoke
per-version migration tool. Because the renderer is pure and deterministic, an upgrade is a
reviewable git change, not a mystery migration: you re-render against your unchanged estate,
read the diff, and re-apply idempotently.

## 1. Re-render

Pull the new Pulse version, then re-run the render against your existing, unchanged estate:

```bash
pulse render            # overwrites rendered/ deterministically
```

The renderer takes no clock, PID, hostname, or random input and emits keys in a canonical
order, so re-rendering the same estate with the same Pulse version reproduces the same tree
byte-for-byte. When the tree *does* change, the only changes are the ones the new version
intends — nothing incidental.

## 2. Diff-review in git

The re-rendered tree is a normal, reviewable change. Inspect every managed file before you
apply anything:

```bash
git diff -- rendered/    # inspect every changed managed file
```

Read the diff the way you would read any code change: a new scrape target, a changed alert
threshold, a reworked routing tree should each be explicable by the version bump. If a
change is surprising, stop and understand it before applying.

### The `formatVersion` signal

Watch `rendered/.rendered-manifest.json` in that diff. Its `formatVersion` field is the
render tree's structural contract — it is `2` today. **If `formatVersion` changed, the
stack's mount wiring may need re-checking**: a bumped format can move, rename, or add files
the compose stack mounts, so re-read the bootstrap runbook's mount step and confirm the
override wiring still points at the right paths before you re-apply. A `formatVersion` that
is unchanged means the mount contract is stable and step 3 is a plain re-apply.

## 3. Re-apply via the idempotent runbook

Adopt the reviewed tree with the same idempotent bring-up the bootstrap runbook documents:

```bash
cd stack/compose && docker compose up --wait    # re-apply; safe on re-run
```

This is safe to re-run. The idempotency rests on two properties:

- **Atomic-replace deterministic render.** Each re-render replaces `rendered/` as a whole,
  so the stack always mounts a complete, self-consistent tree — never a half-written one.
- **Durable named volumes.** The VictoriaMetrics and Grafana data volumes survive
  `docker compose up` re-runs and `docker compose down`, so re-applying never touches your
  metric history or dashboards.

**Never `down -v`.** That flag destroys the durable volumes and with them all metric
history and Grafana state. A plain `docker compose up --wait` is the only re-apply an
upgrade needs — see [runtime posture](/runtime-posture/) for why the volumes are durable.

> **Boundary:** the *mechanics* of the idempotent re-apply — the exact commands, per-step
> content-verification, and rollback — live in the [bootstrap runbook](/bootstrap/). This
> page is the narrative; it links there and never restates those steps.

## Upgrading to 0.2.0

0.2.0 is the first tagged public release. If you run a deployment built from an earlier
checkout, follow the three moves above, then work through the items below. The first item is
**breaking**: skip it and Gatus checks stop paging. The full list of changes is in the
repository's `CHANGELOG.md`.

The rendered estate model (`web-estate-model.json`) and the render tree's `formatVersion` are
unchanged in 0.2.0, so the existing rendered files keep their mounts. One rendered file is new
(`synthetic.yml`, below), and it needs a new mount.

### 1. BREAKING: mount the rendered `synthetic.yml` into vmalert

Gatus checks no longer page through a Gatus alerting provider that posted to Alertmanager. That
provider never resolved alerts correctly and has been removed (PR #21). Each service with an
`alerts:` binding now gets a critical **`GatusCheckFailed`** vmalert rule, rendered into
`rendered/vmalert/rules/synthetic.yml`.

- **Re-run the alerting transform** (`bun run alerting:render`) and **add the `synthetic.yml`
  mount** to vmalert in your compose override, next to `deep-health.yml` and `backup.yml`. The
  [rollout session](/rollout-session/) shows the exact mount line. Mount it **even when no service
  has a binding**.
- **Expect the re-render diff** to drop every `endpoints[].alerts` block from
  `rendered/gatus/config.yaml`. `stack/gatus/alerting-provider.yaml` now holds only
  `metrics: true` (same file name and mount), and Gatus no longer depends on Alertmanager. If you
  keep your own copy of that provider file, remove its `alerting:` block.
- **The file always holds a recording rule.** Since PR #53, `synthetic.yml` always ends with a
  `synthetic-checks-loaded` group whose recording rule, `pulse:synthetic_checks_bound`, counts the
  file's `GatusCheckFailed` rules. vmalert refuses to start when it loads a recording rule
  without `-remoteWrite.url` ("config contains recording rules but `-remoteWrite.url` isn't
  set"). The committed compose file sets it. If your override replaces vmalert's `command:`,
  check that the flag is still there.
- **Carry the other new vmalert flags** if your override replaces vmalert's `command:`. The
  committed compose file now also sets `-remoteRead.url`, `-datasource.queryStep=5m` and
  `-rule.resendDelay=1m`, and the rule behaviour described in [alerting](/alerting/) relies on
  them.
- **A missing mount is loud.** The always-loaded `pipeline-health` rule family now includes the
  **`SyntheticRulesNotLoaded`** warning (`absent(pulse:synthetic_checks_bound)`, `for: 10m`). It
  fires about 15 minutes after the mount is dropped from a running stack. On a fresh stack that
  has never mounted the file, it fires about 10–11 minutes after vmalert starts and keeps firing
  until you add the mount. See
  [detecting a missing `synthetic.yml` mount](/alerting/#detecting-a-missing-syntheticyml-mount)
  and the [pipeline-health runbook](/pipeline-health/).
- **Alert identity changes at cutover.** `GatusCheckFailed` alerts carry new labels (`estate`,
  `name`, `alertgroup: synthetic-checks`), so their fingerprints differ from the old provider's.
  Update any silence that matches on the full old label set. Routing does not depend on
  `source="gatus"`.
- **Estate fields.** No estate change is needed: the same `alerts:` bindings drive the rules.
  `type` and `send_on_resolved` are kept for compatibility but have no effect. Each Alertmanager
  receiver's `send_resolved` decides whether resolves are sent. `failure_threshold` and
  `success_threshold` are now capped at 60. Validation now rejects a host name, service name or
  estate domain that contains `"`, `\` or a line break (`gatus_unsafe_name`), because Gatus fails
  to start on them. Run `pulse validate` before you re-render.

### 2. Write path: still dark unless you opt in

The write path (silences, acknowledgements and estate-edit proposals from the web app) stays
**off** unless you set `PULSE_WEB_AUTH_MODE=proxy-header` and put the app behind a forward-auth
proxy that is the only way to reach it. In the default mode, `none`, no mutation route exists.
Nothing changes for a deployment that does not opt in. See [write path](/write-path/) for the
prerequisites.

If you do run `proxy-header`, the web app now recognises an expired proxy session (PR #66): the
proxy's login redirect, its login page, or a 401/403 from the proxy. It keeps the last data on
screen, marks it stale, and shows "Your session has expired. Reload the page to sign in again."
with a **Reload page** button. A write attempted in that state changes nothing. See
[when the proxy session expires](/write-path/#when-the-proxy-session-expires).

### 3. Host history, liveness and coverage in the web app

These items fix what the web app reads. No query, alert rule, scrape config or model format
changes, and nothing needs to be re-rendered for them.

- **Host history now matches real data** (PR #71). The host drawer's liveness line and the
  timeline's CPU, memory, disk and load charts select on the post-relabel `job` and `instance`
  labels that VictoriaMetrics stores (`instance` is the host name for the managed-linux and
  nas-api jobs). Before, they matched nothing in a real deployment and showed "No liveness
  samples".
- **Host liveness means the host's main scrape job everywhere** (PRs #71 and #73). The overview
  grid, kiosk tiles, estate inventory and liveness history treat a host as live only when `up` of
  its main job (`managed-linux`, `nas-api` or `hypervisor-api`) is 1. A down auxiliary exporter
  (cAdvisor, process-exporter, the heartbeat) no longer marks a host down, and an up auxiliary
  exporter no longer hides a down host. `pulse_agent_up` is the agent heartbeat's own health,
  not host liveness. On the overview, a host whose node_exporter is down now shows as `unknown`,
  and as `critical` once `HostDown` reaches Alertmanager, instead of live.
- **Hypervisor hosts show "Capacity metrics not collected for this host"** in the timeline detail
  instead of four empty charts. Those metrics come from node_exporter, which a hypervisor-api host
  does not run. A probe-only host's drawer shows "Not collected" for liveness history.
- **Coverage has a new `engine` state.** In the estate Coverage tab's declared-versus-scraped
  table, targets of the stack's own static scrape jobs (VictoriaMetrics, vmalert, Alertmanager
  and so on) are counted as "N engine (expected)" instead of being listed as unexpected. Rows now
  name their job.
- **Static scrape jobs you add show as `unexpected`.** A scrape job you add downstream (for
  example a UPS exporter, or the TrueNAS override from the [NAS collector](/nas-collector/)
  recipe) is not in the estate model and is not a stack job, so its targets are listed as
  `unexpected`. That is accurate, and needs no action if you intended the job.

### 4. New host-down alerting for NAS and hypervisor hosts

> **TODO (release coordinator): confirm when PR #76 (issue #74) merges, or delete this section if
> it ships after 0.2.0.** Draft from the PR: `HostDown` (critical, `for: 90s`) now also fires for
> `nas-api` and `hypervisor-api` hosts, not only `managed-linux` ones. The alert name is
> unchanged and routing is by severity, so no route needs editing. A silence or inhibit rule that
> matches `alertname="HostDown"` with no `host` matcher now also mutes NAS and hypervisor hosts.
> Add `collection_class="managed-linux"` to it to keep the old scope. While pve-exporter is down,
> hypervisors do not page as down; `AncillaryDown` covers the exporter.

### 5. Web app: security headers, kiosk and timeouts

- **Security headers** (PR #38). The web app now sends its own `Content-Security-Policy`,
  `Cross-Origin-Opener-Policy`, `Permissions-Policy`, `X-Content-Type-Options` and
  `Referrer-Policy`. Do not add a second CSP at your proxy. Set HSTS on the proxy if you serve
  Pulse only over HTTPS. See [exposure: security headers](/exposure/#security-headers).
- **Kiosk redesign** (PR #65). `?kiosk=1` on the overview now shows a read-only wall of compact
  host tiles, worst status first, instead of paging the desk grid. Each page
  stays up for at least 10 seconds. Up to three pages share a 30-second cycle, and more pages
  lengthen it. Inside a rotation (`?rotate=overview:60s,…`), each overview visit shows as many
  pages as fit its dwell at 10 seconds or more each, and the next visit continues where the last
  one stopped. A rotation dwell under 10 seconds shows one page per visit. Re-check any wallboard
  whose rotation dwell was tuned for the old paging. See
  [wallboard (kiosk) mode](/web-overview/#wallboard-kiosk-mode).
- **View requests time out.** Each view request from the browser has an 8-second deadline. An
  unreachable or timed-out Pulse server is now reported as such, instead of as "An unexpected
  server error occurred" (PR #61).

### Not operator-facing

The `visual-update.yml` workflow regenerates the web app's visual-regression baselines on CI and
is for development only. The re-sync of the vendored `@/ui` component library (PR #50) is
internal. Neither needs anything from a deployment.

## Where to go next

- **The executable re-apply steps** → the [bootstrap runbook](/bootstrap/).
- **Why the volumes are durable** → [runtime posture](/runtime-posture/).
- **Full runbook index** → [runbooks](/runbooks/).
