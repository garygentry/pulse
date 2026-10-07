---
title: Exposure recipe
description: How to reach the Pulse UIs safely — which services are safe to expose, a Caddy and a Traefik reverse-proxy-with-TLS recipe, and the minimal loopback override for a bare LAN.
slug: exposure
---

# Exposure recipe

By default **no Pulse service publishes a host port**. Every service carries only `expose:`
(in-network) — there is no `ports:` key anywhere in the committed `docker-compose.yml`, so a
fresh [bootstrap](/bootstrap/) yields a stack reachable only from inside the `pulse` bridge
network. That is the correct secure default. This page is the recipe for reaching the UIs
without weakening it.

For the posture this builds on (the single bridge, loopback publish, the git-ignored override
seam) see [runtime posture](/runtime-posture/); this page is the fuller reverse-proxy recipe it
points to.

## Which services are safe to expose

Only the two human-facing UIs belong on a reverse proxy. The rest are internal data planes with
no authentication of their own — they must stay on the `pulse` network.

| Service | In-stack address | Expose to humans? | Why |
|---------|------------------|-------------------|-----|
| **Grafana** | `grafana:3000` | **Yes**, behind TLS + the proxy's auth | Has its own login; the dashboards UI. |
| **Web overview** | `web:8080` (profile `web`) | **Yes**, behind TLS + the proxy's auth | Status grid; no secrets. Read-only in auth mode `none`; `proxy-header` mode adds silence/ack/proposal writes ([write path](/write-path/)). Proxy-gate it either way. |
| Alertmanager | `alertmanager:9093` | **No** — internal only | No auth; the silence/API surface is sensitive. |
| VictoriaMetrics | `victoriametrics:8428` | **No** — internal only | No auth; full read/write TSDB API. |
| vmalert | `vmalert:8880` | **No** — internal only | No auth; rule/debug surface. |
| Gatus | `gatus:8080` | **No** — internal only | Status API; the web overview already surfaces it. |
| Prober / exporters | in-network `:9120`/`:91xx` | **No** — internal only | Metric endpoints, scraped by VM only. |

> If you need to reach Alertmanager or VictoriaMetrics interactively, do it over an SSH tunnel
> to a loopback-published port (below), never through a public proxy.

## Recipe A — Reverse proxy on the `pulse` network (recommended)

Run a TLS-terminating proxy as a service that **joins the `pulse` network** and proxies to the
UIs by in-stack DNS name. The stack services stay entirely unpublished; the proxy is the only
thing that binds a host port. Add it via a git-ignored `docker-compose.override.yml` beside the
base file so the committed tree is never edited.

### Caddy

```yaml
# stack/compose/docker-compose.override.yml — operator-owned, git-ignored.
# Compose auto-merges this over docker-compose.yml on `up`.
services:
  caddy:
    image: caddy:2
    profiles: ["web"]                 # bring it up alongside the web profile
    networks: [pulse]
    ports:
      - "443:443"
      - "80:80"                       # ACME HTTP-01 challenge + redirect
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data              # persists issued certificates
    restart: unless-stopped
volumes:
  caddy-data: {}
```

```text
# stack/compose/Caddyfile — Caddy provisions and renews TLS automatically.
grafana.example.com {
    reverse_proxy grafana:3000
}
pulse.example.com {
    reverse_proxy web:8080
}
```

Caddy obtains and renews Let's Encrypt certificates on its own; point the two DNS names at the
host and open 80/443.

### Traefik

```yaml
# stack/compose/traefik.yml — Traefik static config (operator-owned, git-ignored).
entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"
providers:
  docker:
    exposedByDefault: false
certificatesResolvers:
  le:
    acme:
      email: ops@pulse.example.com    # your ACME contact address
      storage: /acme/acme.json
      tlsChallenge: {}
```

```yaml
# stack/compose/docker-compose.override.yml — operator-owned, git-ignored.
services:
  traefik:
    image: traefik:v3.1
    profiles: ["web"]
    networks: [pulse]
    ports:
      - "443:443"
      - "80:80"
    volumes:
      - ./traefik.yml:/etc/traefik/traefik.yml:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - traefik-acme:/acme
    restart: unless-stopped

  grafana:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.grafana.rule=Host(`grafana.example.com`)"
      - "traefik.http.routers.grafana.entrypoints=websecure"
      - "traefik.http.routers.grafana.tls.certresolver=le"
      - "traefik.http.services.grafana.loadbalancer.server.port=3000"

  web:
    profiles: ["web"]
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.web.rule=Host(`pulse.example.com`)"
      - "traefik.http.routers.web.entrypoints=websecure"
      - "traefik.http.routers.web.tls.certresolver=le"
      - "traefik.http.services.web.loadbalancer.server.port=8080"

volumes:
  traefik-acme: {}
```

### Encoded slashes in the path

Whichever proxy you use, it must forward `%2F` in the request path **unchanged** to `web:8080`.
The web overview's history routes carry service and check ids that contain a slash, sent
percent-encoded — for example `/api/history/checks/web%2Fapp` or
`/api/history/target/svc%3Aweb%2Fapp/…`. If the proxy decodes `%2F` into `/` (or rejects it),
those requests fail and the timeline shows "check history not available". Caddy's
`reverse_proxy` forwards encoded slashes as-is by default. Some proxies decode or reject them
and must be configured to pass them through: Traefik's encoded-character filtering, and nginx
`proxy_pass` with a URI part (which normalizes the path — use `proxy_pass` without a URI).

## Recipe B — Minimal loopback publish (bare LAN / SSH tunnel)

When you just need occasional local access and no proxy, publish the UI ports to **loopback
only** and reach them over an SSH tunnel. Never bind `0.0.0.0` on an untrusted network.

```yaml
# stack/compose/docker-compose.override.yml — operator-owned, git-ignored.
services:
  grafana:
    ports:
      - "127.0.0.1:3000:3000"
  web:
    profiles: ["web"]
    ports:
      - "127.0.0.1:8080:8080"
```

Then, from your workstation: `ssh -L 3000:127.0.0.1:3000 user@host` and open
`http://127.0.0.1:3000`.

## Verify the exposure

Content-verify the publish rather than trusting the exit code of `up`:

```bash
# The proxy (or the loopback mapping) should appear in the compose plan:
cd stack/compose && docker compose --profile web config | grep -A2 'ports:'

# Grafana answers through the mapping / proxy:
curl -sf http://127.0.0.1:3000/api/health          # loopback recipe
curl -sf https://grafana.example.com/api/health    # reverse-proxy recipe

# Confirm the override is git-ignored (this MUST print the path — i.e. it IS ignored):
git check-ignore stack/compose/docker-compose.override.yml
```

**Rollback:** `rm stack/compose/docker-compose.override.yml` (and any `Caddyfile`) then
`docker compose up --wait` — the stack returns to expose-only and no committed file changed.

## Where to go next

- **The posture this builds on** → [runtime posture](/runtime-posture/).
- **Stand the stack up first** → the [bootstrap runbook](/bootstrap/).
- **Wire real credentials for the proxy/UIs** → [secret recipes](/secret-recipes/).
