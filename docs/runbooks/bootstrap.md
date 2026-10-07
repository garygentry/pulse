---
title: Bootstrap
description: From a fresh Linux host to a healthy Pulse engine — fetch the binary, render and commit the estate, and bring the default-profile stack up, verified by content at every step.
slug: bootstrap
---

# Bootstrap

This runbook takes you from a fresh Linux host to a **running, healthy Pulse engine**. You
fetch and verify the `pulse` binary, render your estate into a committed tree, and bring the
default-profile stack up with `docker compose up --wait` — verifying each step by inspecting
host and file state, never by trusting an exit code.

The worked estate here is the committed reference fixture at `examples/reference/`; swap in
your own estate directory wherever it appears. For the shape of the running system this
produces, see [runtime posture](/runtime-posture/); to adopt a later Pulse revision
afterward, see the [upgrade path](/upgrade-path/).

> **Scope — the default profile only.** This runbook brings up the default service set:
> `victoriametrics`, `vmalert`, `alertmanager`, `gatus`, `grafana`, `cadvisor`, and
> `pve-exporter`. The `web` and `deep-health` profiles are **excluded** — they are
> profile-gated OFF and beyond the bring-up slice. A `nas-api` host needs **no** profile or
> extra service: it is scraped as a **direct `node_exporter` target** (TrueNAS Scale runs
> `node_exporter` on `:9100`), exactly like a `managed-linux` host. Enrol the NAS's
> `node_exporter` the same way you would any managed host. If you instead want pool/dataset
> health from the TrueNAS API, follow the opt-in
> [TrueNAS-API-exporter override](/nas-collector/#opt-in-truenas-api-exporter) — it is a
> hand-wired exporter you add yourself, not a shipped service.

## About the exit contract

Every `pulse` command below branches on the stable exit contract: **`0`** clean, **`1`**
findings or drift (fix the estate or re-render, then re-run), **`2`** a tool fault — an I/O
error or an unreadable config, which you fix in the environment and **never** by editing the
estate. The steps verify by content regardless, so a stray `0` never lets you proceed on a
broken state.

## Steps

#### Step 1 — Fetch and checksum-verify the `pulse` binary

The CLI ships as musl-static single binaries (`pulse-linux-x64` / `pulse-linux-arm64`) plus a
`SHA256SUMS` file, attached to your private GitHub release. Fetch the binary for your
architecture and verify its checksum before trusting it.

**Command**

```bash
ARCH="x64"   # or arm64, to match your host
# Point BASE at your private release; <git-host>/<org>/<tag> are yours to fill in.
BASE="https://<git-host>/<org>/pulse/releases/download/<tag>"
curl -fsSL -o pulse "$BASE/pulse-linux-${ARCH}"
curl -fsSL -o SHA256SUMS "$BASE/SHA256SUMS"
sha256sum --ignore-missing -c SHA256SUMS
chmod +x ./pulse
export PULSE_BIN="$(pwd)/pulse"
```

**Verify (content):** `sha256sum --ignore-missing -c SHA256SUMS` prints
`pulse-linux-x64: OK` (or `…arm64: OK`) — read the `OK` line itself, not merely the exit
code. Then `"$PULSE_BIN" --version` prints a semver and a `schemaMajors: [1]`, confirming the
binary runs and speaks schema major 1.

**Rollback:** `rm -f ./pulse ./SHA256SUMS` — nothing else on the host was mutated.

> **Release-asset names are unverified until release.** The asset filenames
> (`pulse-linux-x64`, `pulse-linux-arm64`, `SHA256SUMS`) are read from
> `apps/cli/scripts/build-bin.ts`. If the built asset names differ at release time, correct
> the download URLs above before publishing this runbook to your operators.

#### Step 2 — Render the estate into a committed tree

Run from the **estate workspace directory** — the directory holding `pulse.config.yaml`. The
CLI resolves `estateDir`/`outputRoot` against the current working directory, **not** against a
`--config` path, so `cd` into the fixture and invoke the binary by absolute path.

**Command**

```bash
cd examples/reference && "$PULSE_BIN" render
```

**Verify (content):** `rendered/.rendered-manifest.json` exists and contains
`"formatVersion": 1`; `cat rendered/.rendered-manifest.json` and confirm `files` lists
`scrape/file_sd/managed-linux.json`, `alertmanager/routing.yaml`, and `gatus/config.yaml`.
Then re-run `"$PULSE_BIN" render --check` in the same directory: **exit `0`** (no drift)
proves the on-disk tree equals a fresh render. **Exit `1`** means the committed tree drifted
— re-render and re-commit; **exit `2`** is a tool fault to resolve in the environment.

**Rollback:** `git checkout -- rendered/` restores the prior tree. Render is atomic-replace,
so a failed render never leaves a half-written tree behind.

#### Step 3 — Commit the rendered tree

The rendered tree is data you review and version; commit it so the stack mounts a reviewed,
reproducible tree.

**Command**

```bash
git add examples/reference/rendered && git commit -m "render: reference estate"
```

**Verify (content):** `git status --short examples/reference/rendered` prints **nothing** (the
tree is committed, not dirty), and `git show --stat HEAD` lists the rendered files you expect.

**Rollback:** `git revert HEAD` (or `git reset --hard HEAD~1` on an unpushed branch).

#### Step 4 — Prepare the engine environment file

The stack reads a git-ignored `stack/compose/.env`. `PULSE_ESTATE_NAME` is **required and has
no fallback** — an empty value yields a blank `estate` external label on every alert. Point
`PULSE_RENDERED_DIR` at the committed tree.

**Command**

```bash
cd stack/compose
cp -n .env.example .env
# Edit .env and set at least:
#   PULSE_ESTATE_NAME=reference-estate                       # REQUIRED — no fallback
#   PULSE_RENDERED_DIR=../../examples/reference/rendered     # the committed tree
#   PULSE_VM_RETENTION=6                                     # months (anchors sizing)
# Supply any real credentials as ${ENV}/op:// references — see /secret-recipes/.
```

**Verify (content):** `grep -E '^PULSE_ESTATE_NAME=' .env` prints a **non-empty** value, and
`git check-ignore stack/compose/.env` prints the path (confirming the file is git-ignored and
will never be committed).

**Rollback:** `rm -f stack/compose/.env` — no service has started yet.

#### Step 5 — Bring the engine up (default profile only)

**Command**

```bash
cd stack/compose && docker compose up --wait --wait-timeout 180
```

**Verify (content):** confirm each service is live by *state*, not by `up --wait`'s exit code.
The health-checked services report through compose:

```bash
docker compose ps --format '{{.Service}} {{.Health}}'
# expect `healthy` for: victoriametrics vmalert alertmanager grafana cadvisor pve-exporter
```

`gatus` has **no container healthcheck** (its image is shell-less), so probe it by HTTP body
from inside the network, and probe VictoriaMetrics and Alertmanager functionally:

```bash
# gatus serves its status API (a JSON body, not a connection error):
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- http://gatus:8080/api/v1/endpoints/statuses | head -c 80"

# VictoriaMetrics answers the `up` query with a success envelope:
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- 'http://victoriametrics:8428/api/v1/query?query=up' | grep -o '\"status\":\"success\"'"

# Alertmanager reports healthy:
docker compose run --rm --entrypoint sh alertmanager -c \
  "wget -qO- http://alertmanager:9093/-/healthy"
```

Each command returning its expected body — the JSON status list, `"status":"success"`, and
the health string — proves the stack is live. VictoriaMetrics self-scrapes on roughly a
30-second cadence, so if the `up` query is briefly empty just after bring-up, wait and re-run
it.

> **A healthy engine does not yet deliver alerts.** Alertmanager here boots from the
> **null-sink bootstrap** config, so any estate `channels` / `routing_overrides` you declared
> are rendered but **not** live — a firing alert routes to the null receiver. Turning
> declarations into real delivery is a separate, deliberate step: run the alerting-activation
> flow in the [rollout session](/rollout-session/) (transform the rendered routing into a native
> Alertmanager config, resolve its secrets, and remount it). Until then the deadman and every
> channel are inert by design.

**Rollback:** `docker compose down` — **never `docker compose down -v`.** The `-v` flag
destroys the durable named volumes `victoria-metrics-data` and `grafana-data`, taking all
metric history and Grafana state with them. A plain `down` stops the stack while preserving
both.

#### Step 6 — (Optional) Expose Grafana on the host

The committed compose tree publishes **no host ports** — every service is reachable only from
inside the `pulse` network. Expose Grafana through an **operator-authored, git-ignored
`docker-compose.override.yml`**, which Compose auto-merges on `up`. This never edits the
committed tree.

**Command**

```bash
# stack/compose/docker-compose.override.yml
cat > stack/compose/docker-compose.override.yml <<'YAML'
services:
  grafana:
    ports:
      - "127.0.0.1:3000:3000"   # loopback only; front with a reverse proxy for remote access
YAML
cd stack/compose && docker compose up --wait --wait-timeout 180
```

**Verify (content):** `curl -fsS http://127.0.0.1:3000/api/health` returns a JSON body with
`"database": "ok"`, confirming the published port serves Grafana; `docker compose config`
shows the merged `ports:` while the base tree remains untouched; and
`git check-ignore stack/compose/docker-compose.override.yml` prints the path (the override is
yours, kept out of git).

**Rollback:** `rm stack/compose/docker-compose.override.yml && docker compose up --wait` — the
stack returns to expose-only and no committed file changed.

See [runtime posture](/runtime-posture/) for the single-host caveats behind this override, and
the [exposure recipe](/exposure/) for the full reverse-proxy configs (Caddy / Traefik) and which
UIs are safe to expose.

## Building non-upstream images (optional profiles)

The **default profile is all upstream images** — Compose pulls them, nothing is built. Only the
optional profiles and the per-host bundle carry Pulse-built images; each has an explicit build
path so a clean host never fails to pull an image that lives in no registry.

| Image | Profile / where | Built by | Command |
|-------|-----------------|----------|---------|
| `apps/web` → `web` | `web` (engine compose) | Compose `build:` | `cd stack/compose && docker compose --profile web build` |
| `pulse/prober:1.0.0` | `deep-health` (engine compose) | Compose `build:` | `cd stack/compose && docker compose --profile deep-health build` |
| `pulse/agent-heartbeat:1.0.0` | per-host bundle | per-host `docker build` | `docker build agent -f agent/heartbeat/Dockerfile --build-arg AGENT_VERSION=1.0.0 -t pulse/agent-heartbeat:1.0.0` |
| `pulse/command-exporter:1.0.0` | per-host bundle, `command-exporter` profile | Compose `build:` / `docker build` | `docker build agent -f agent/command-exporter/Dockerfile -t pulse/command-exporter:1.0.0` |

**Command:** build the optional-profile images before bringing those profiles up, e.g.
`cd stack/compose && docker compose --profile web --profile deep-health build`, then add the
same `--profile` flags to your `up`.

**Verify-by-content:** `docker compose --profile deep-health config` resolves the `prober`
service to `image: pulse/prober:1.0.0` with a `build:` stanza, and
`docker image inspect pulse/prober:1.0.0` succeeds after the build.

**Rollback:** none needed — building is inert until you `up` the matching profile; a stale
local image is replaced by re-running the build.

> The per-host bundle images (heartbeat, node_exporter, cadvisor) are built/loaded by the
> [agent install](/agent-install/) flow, not by the engine compose — see that runbook for the
> per-host build-vs-pull story.

## Idempotency and re-apply

This bootstrap is written around **plain `docker compose up --wait` re-runs** and **never
`down -v`**. Re-applying a re-rendered tree cannot corrupt a running stack because:

- The renderer is **atomic-replace deterministic** — a re-render either fully replaces the
  tree or leaves the prior tree intact; there is never a partial tree.
- The **durable named volumes** persist across `down`/`up`, so history and dashboards survive.
- The rendered tree is bind-mounted **read-only**, so re-applying cannot mutate a running
  container's writable state.

To adopt a new Pulse revision later, re-render, review `git diff -- rendered/`, and re-run
Step 5 — the full narrative is in the [upgrade path](/upgrade-path/). A bumped
`formatVersion` in `.rendered-manifest.json` is the signal to re-check the compose mount
wiring before re-applying.

## Where to go next

- **Enroll agents on your monitored hosts** → [agent install](/agent-install/).
- **Wire alerting and shake it down** → [rollout session](/rollout-session/).
- **Understand the running stack** → [runtime posture](/runtime-posture/).
- **Full runbook index** → [runbooks](/runbooks/).
