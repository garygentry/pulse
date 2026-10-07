---
title: Runtime posture
description: The single-host Docker Compose posture the bootstrap runbook produces, its operational caveats, and host-port exposure without editing the committed tree.
slug: runtime-posture
---

# Runtime posture

This page documents what the [bootstrap runbook](/bootstrap/) actually produces: the
single-host Docker Compose posture defined by stack-core. It is here so you understand the
running system and its caveats. stack-core owns the posture; this page documents it.

## The posture and its operational caveats

- **One compose project — `pulse`.** Every service lives in a single project (`name:
  pulse`); manage the whole stack with one `docker compose` invocation run from
  `stack/compose/`.
- **One bridge network — `pulse`.** Services reach each other by in-stack DNS name
  (`victoriametrics:8428`, `alertmanager:9093`, `grafana:3000`, `gatus:8080`). This network
  is internal to the host.
- **Durable named volumes.** `victoria-metrics-data` (the VictoriaMetrics TSDB) and
  `grafana-data` (Grafana's dashboards + sqlite state) **survive `docker compose down` and
  host restarts.** Only `docker compose down -v` destroys them.

  > **Warning:** never `down -v` a running stack. That flag deletes the durable volumes and
  > with them all metric history and Grafana state. A plain `down` (no `-v`) stops the stack
  > while preserving both.

- **Single-instance scope, no locking.** This is a single-host posture: exactly one stack
  per host, no clustering, no cross-host coordination or lock. Running two copies against
  the same volumes is unsupported. Multi-host fleets are out of scope.
- **`cadvisor` runs `privileged: true` with host mounts.** It bind-mounts `/:/rootfs:ro`,
  `/var/run`, `/sys`, `/var/lib/docker`, and `/dev/disk`, and reads `/dev/kmsg`. This is the
  one broad-privilege service in the stack — container introspection needs host visibility.
  Operators who cannot grant that can leave the cadvisor scrape opted out at the host level.
- **Restart policy — `restart: unless-stopped`.** Every service self-heals across host
  reboots without an external supervisor; a service only stays down if you explicitly
  stopped it.

## Host-port exposure — without editing the committed tree

stack-core deliberately publishes **no host ports**: services carry only `expose:`
(in-network) or nothing at all — there is **no `ports:` key anywhere** in the committed
`docker-compose.yml`. A fresh bootstrap therefore yields a stack reachable only from inside
the `pulse` network.

Publish a port by dropping a git-ignored `docker-compose.override.yml` beside the base file.
Compose auto-merges it on `up`, so the committed stack tree is **never edited**:

```yaml
# stack/compose/docker-compose.override.yml
# Operator-owned, git-ignored. Compose auto-merges this over docker-compose.yml on
# `docker compose up` — the committed stack tree is never edited.
services:
  grafana:
    ports:
      # Bind to loopback only; front with a reverse proxy for anything non-local.
      - "127.0.0.1:3000:3000"
  web:
    # `web` is profile-gated (profiles: ["web"]); it runs only under `--profile web`.
    # Re-declaring the profile here keeps the override in step with the base service.
    profiles: ["web"]
    ports:
      - "127.0.0.1:8080:8080"
```

Two exposure paths:

- **Direct loopback publish** (above): bind to `127.0.0.1` so the port is host-local, then
  reach Grafana at `http://127.0.0.1:3000` — for example over an SSH tunnel. Never bind
  `0.0.0.0` on an untrusted network.
- **Reverse proxy.** For real access, run a TLS-terminating reverse proxy (Caddy, nginx,
  Traefik) that either joins the `pulse` network and proxies to `grafana:3000` / `web:8080`
  by in-stack DNS, or sits in front of the loopback-published ports. The proxy owns auth and
  TLS; the stack services themselves stay unpublished. The full recipe — which services are
  safe to expose plus copy-paste Caddy and Traefik configs — is the
  [exposure recipe](/exposure/).

### Verify the exposure

Content-verify the publish rather than trusting the exit code of `up`:

```bash
# The port mapping should now appear against grafana:
docker compose ps
# ...and the service should answer on loopback:
curl -sf http://127.0.0.1:3000/api/health

# Confirm the override is git-ignored (this MUST print the path — i.e. it IS ignored):
git check-ignore stack/compose/docker-compose.override.yml
```

The override is your file, kept out of git; the committed compose tree is left untouched.

## Where to go next

- **Stand the stack up** → the [bootstrap runbook](/bootstrap/).
- **Reach the UIs behind TLS** → the [exposure recipe](/exposure/).
- **Adopt a new revision** → [upgrade path](/upgrade-path/).
- **Wire real credentials** → [secret recipes](/secret-recipes/).
- **Full runbook index** → [runbooks](/runbooks/).
