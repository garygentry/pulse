---
title: NAS collector (nas-api)
description: How a nas-api host is monitored — a direct node_exporter scrape by default, with an opt-in TrueNAS-API-exporter override recipe for pool and dataset health.
slug: nas-collector
---

# NAS collector (`nas-api`)

A host with `collection_class: nas-api` is monitored as a **direct `node_exporter` scrape** —
the same collection path as a `managed-linux` host. TrueNAS Scale runs `node_exporter`
directly, so Pulse points VictoriaMetrics straight at it. There is **no bundled TrueNAS
exporter image and no compose profile to enable** — the class works out of the box after a
[bootstrap](/bootstrap/).

## Default — `node_exporter` on the NAS

Declare the host with just its address; Pulse renders a scrape target at `<address>:9100`.

```yaml
hosts:
  - name: harbor-nas-01
    collection_class: nas-api
    addresses:
      - 10.20.0.6        # node_exporter is scraped at :9100
```

Renders to `scrape/file_sd/nas-api.json`:

```json
[
  {
    "labels": { "collection_class": "nas-api", "host": "harbor-nas-01" },
    "targets": ["10.20.0.6:9100"]
  }
]
```

The `nas-api` scrape job in the shipped `scrape.yml` is a direct node scrape (it promotes the
rendered `host` label to `instance`), exactly like the `managed-linux` job — no relabel-through,
no credential, no exporter service.

> **Enrolling `node_exporter` on TrueNAS Scale.** Install/enable `node_exporter` on the NAS so
> it serves `/metrics` on `:9100` reachable from the `pulse` network. This is the same host-side
> enrolment you do for any managed host; it carries no Pulse secret.

## Opt-in: TrueNAS API exporter

`node_exporter` gives you the host signals (CPU, memory, filesystem fill, disk I/O). If you also
want **pool/dataset health** (ZFS scrub state, pool status, dataset usage) you can run a
TrueNAS-API exporter alongside the default scrape. This is a **hand-wired override you own** — it
is deliberately not shipped, because there is no single canonical TrueNAS-class exporter image to
pin. The pattern mirrors the [exposure override seam](/exposure/): add it through a git-ignored
`docker-compose.override.yml` beside the base file, so the committed tree is never edited.

The `nas-api` schema keeps two **optional, reserved** fields — `api_endpoint` and `credential` —
for exactly this case. They are **both-or-neither**: declare both to signal "this NAS also has an
API exporter", or neither for the default. Declaring only one is a validation error
(`incomplete_nas_api`). The shipped renderer does **not** wire these fields into a scrape target
(there is no shipped exporter to route them to) — they document intent and carry the credential
reference; you wire the actual exporter and scrape job by hand.

**1. Declare the override fields on the host** (credential is a
[secret reference](/secret-recipes/), never a literal):

```yaml
hosts:
  - name: harbor-nas-01
    collection_class: nas-api
    addresses:
      - 10.20.0.6                                   # still scraped as node_exporter :9100
    api_endpoint: https://harbor-nas-01.example/api/v2
    credential: op://infra/nas/token               # or ${NAS_API_TOKEN}
```

**2. Add your exporter service** in `docker-compose.override.yml` (pin a concrete tag for the
TrueNAS-class exporter you chose; the token reaches it via env, never the compose file):

```yaml
# docker-compose.override.yml — git-ignored; never edit the committed base file.
services:
  truenas-exporter:
    image: your-registry/truenas-exporter:1.2.3    # pin a concrete tag
    environment:
      TRUENAS_URL: "https://harbor-nas-01.example/api/v2"
      TRUENAS_TOKEN: "${NAS_API_TOKEN}"            # resolved from your .env at deploy time
    networks: [pulse]
    restart: unless-stopped
```

**3. Add a scrape job** for it (a second `docker-compose.override.yml` mount, or your VM config
overlay) — a normal static scrape of the exporter's `/metrics`:

```yaml
scrape_configs:
  - job_name: nas-api-truenas
    static_configs:
      - targets: ["truenas-exporter:9101"]         # your exporter's port
        labels:
          host: harbor-nas-01
```

The default `node_exporter` target for the same host stays in place — the two jobs are
complementary: `node_exporter` for host signals, your exporter for pool/dataset health.

## See also

- [Bootstrap](/bootstrap/) — the default-profile bring-up (no `nas` profile).
- [Exposure recipe](/exposure/) — the same git-ignored override seam for reverse proxies.
- [Secret recipes](/secret-recipes/) — how `credential` references resolve at deploy time.
