# @pulse/web — Live Deployment Sign-off

Automated repository evidence (`bun test`, `bun run smoke`, `bun run typecheck`) cannot prove
reverse-proxy and live-source deployment behavior. This checklist is the **manual** operator
sign-off for a real deployment. It **augments** the repository gate — it never replaces it.

> **Status: NOT YET PERFORMED.** Every box below is unchecked on purpose. Checking a box records a
> human-verified observation on a real deployment. Do **not** mark an item done from CI, from the
> in-process smoke, or from the Docker compose smoke — those are separate, automated evidence. Only
> a person who ran the step against the deployment checks its box and records the result.

## How to record

Fill the **Recording** block below on each run, then check only the boxes you personally verified.
**Never** record credentials, raw request/response headers, or raw source bodies — record only
categorical outcomes, counts, durations, and status codes.

### Recording

| Field | Value |
|---|---|
| Date (UTC) | _(record on run)_ |
| Deployed revision (git SHA) | _(record on run)_ |
| Bun version | _(record on run)_ |
| Image tag / digest | _(record on run)_ |
| Reverse-proxy config reference | _(record on run — pointer/name only, no secrets)_ |
| Estate counts (hosts / services / endpoints) | _(record on run)_ |
| Commands run + results | _(record on run — categorical results only)_ |
| Residual risk / notes | _(record on run)_ |

## Evidence checklist (eight items)

- [ ] **1. SSE through the reverse proxy.** `/api/events` reaches the browser through the proxy with
      `X-Accel-Buffering: no`, a heartbeat about every five seconds, and a tick after each published
      cycle. _Record: proxy name/ref, observed heartbeat interval, tick-on-publish yes/no._

- [ ] **2. Disconnect / reconnect convergence.** Interrupting and restoring the connection converges
      the client to the latest state, and no proxy idle timeout buffers the stream indefinitely.
      _Record: reconnect converged yes/no, proxy idle-timeout behavior._

- [ ] **3. gzip / ETag / 304 on current routes.** Each of the five current routes negotiates gzip,
      emits a distinct strong ETag (plain vs gzip differ), and returns a bodyless `304 Not Modified`
      with the observation metadata header on a matching `If-None-Match`. _Record: per-route
      200→304 result and that plain/gzip validators differ._

- [ ] **4. Telemetry with bounded labels.** `pulse_web_*` on `/metrics` exposes the
      cycle/source/stream/history families with bounded, closed labels only (no host/service/
      endpoint/fingerprint/path/query/peer/identity/error values). _Record: families present,
      spot-check that labels are closed categorical values._

- [ ] **5. Per-source degradation + recovery.** Making **each** source (VictoriaMetrics,
      Alertmanager, Gatus, vmalert, and — if configured — Grafana) deliberately unreachable produces
      explicit, isolated degradation (unaffected data stays current; nothing missing is shown as
      healthy), and restoring it recovers automatically on a later cycle. _Record: per-source
      degrade + recover observed._

- [ ] **6. Real responses pass consumed-field validators.** Live, pinned-compatible upstream
      responses pass the consumed-field validators (no validation failures / dropped operations
      against the real engine versions). _Record: engine versions and validator pass/fail._

- [ ] **7. Fixed VictoriaMetrics request load.** Observed VM request load equals the fixed recurring
      cycle acquisition plus bounded on-demand history, and does **not** scale with viewer count or
      estate size. _Record: measured recurring call rate at 0 vs N viewers, tiny vs full estate._

- [ ] **8. Body budgets on a representative estate.** All five current-view bodies stay under the
      budgets (≤ 5 MiB plain, ≤ 1 MiB gzip) on a representative estate. _Record: per-route plain and
      gzip sizes._

## Sign-off

- [ ] All eight items above verified on the recorded revision.

Signed-off by: _(name)_ — Date (UTC): _(record on run)_
