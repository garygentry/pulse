# @pulse/web — Developing

Run the real production server, from TypeScript source, against a mock or real engine. No stack
containers required.

## Quick start

```
bun install
bun run dev:web --mock             # http://127.0.0.1:8080 with the all-green fixture estate
```

## Usage

```
usage: bun run dev:web [--mock [<scenario>] | --engine <vm-url>,<alertmanager-url>,<gatus-url>,<vmalert-url>]
                       [--port <n>] [--host <addr>] [--clock <iso-8601>]
```

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--mock [<scenario>]` | `all-green` | Run against an in-process mock engine. `--mock --port 0` does NOT consume `--port` as the scenario name. Mutually exclusive with `--engine`. |
| `--engine <vm>,<am>,<gatus>,<vmalert>` | — | Talk to a real engine. Exactly four absolute `http(s)` URLs, comma-separated, in the fixed order VictoriaMetrics, Alertmanager, Gatus, vmalert. Mutually exclusive with `--mock`. |
| `--port <n>` | `8080` | Listen port. `0` = OS-assigned; the bound port is printed. |
| `--host <addr>` | `127.0.0.1` | Bind address. Loopback by default; set `0.0.0.0` to expose on the LAN (wallboard / phone). |
| `--clock <iso-8601>` | — | Pin the mock scenario clock; deterministic across restarts. Unpinned = starts from process start. |
| `-h`, `--help` | — | Print this usage and exit 0. |

## Scenarios

- `all-green` — the reference estate, everything healthy.
- `degraded-mix` — host down, warnings, a silenced alert, a failing check; all five status states; a drift timeline of ~60 s.
- `source-outage` — one source unreachable; per-source degradation and staleness.

Add a new scenario by dropping a directory (with `vm.json`, `alertmanager.json`, `gatus.json`,
`vmalert.json`, and optional `timeline.json`) under `apps/web/tests/fixtures/engine/`. The
`vmalert.json` body is a sanitized `/api/v1/rules` catalog (no real hostnames, credentials, or
secrets) and always includes the always-firing `DeadMansSwitch` canary rule.

## Wallboard / phone

```
bun run dev:web --mock --host 0.0.0.0
```

Exposes the dev server on the LAN. The default is loopback-only; set `--host 0.0.0.0` only when you
want another device to reach the box.

## Deterministic runs

```
bun run dev:web --mock --clock 2026-10-01T12:00:00Z
```

Pins the scenario start. An unpinned clock rewinds on server restart; a pinned clock does not.
Fixture timestamps (Alertmanager, vmalert, VM) are shifted onto the scenario start, so a pinned
clock serves the same bodies on every run. It does not pin the app's "now": rendered ages and Gatus
results still follow the real clock, so a clock far in the past shows large ages. For screenshots,
omit `--clock` or pick a recent one. See the integration guide for details.

## What reloads when

- A client change (`src/client/**`, `src/shared/**`) rebuilds; open tabs poll `/__dev/build-id` and
  reload themselves within ~2 s.
- A server change (`src/server/**`, `src/shared/**`, `src/version.ts`) restarts the process; tabs do
  NOT reload — they resume polling once the server is back.
- A **workspace package** change (`packages/{core,renderer,web-data}/src/**`, or a package
  `tsconfig.json` / `package.json` export map) recompiles the dependency graph with `tsc -b` first,
  then triggers exactly one client rebuild + ordered server restart. The single supervisor compiles
  the packages **before** the first client build/server spawn, so consumers always import the built
  `dist`, never source. Emitted `dist/**` / `.tsbuildinfo` outputs are ignored, so a rebuild never
  self-triggers; burst edits coalesce to one in-flight build plus one follow-up.

## Working on the UI

The client is React 19 and Tailwind CSS v4, composed from the `@/ui` library in
`src/client/ui/`. A development build serves the component workbench at
`http://127.0.0.1:8080/_ui`: every library component in its states (use the top bar's theme and
density controls to check dark mode and wallboard). It is never part of a production build. Conventions (status maps, icons,
the `useSignals()` rule, imports, tests and guardrails) are in
[docs/architecture/ui.md](../../docs/architecture/ui.md).

Every view and the workbench have committed visual baselines (`tests/visual/`), verified in CI.
They are made on CI Linux only. When a change moves pixels, regenerate them on your branch and
commit the result:

```
gh workflow run ci.yml --ref <branch> -f update_visuals=true
gh run download <run-id> -n visual-baselines -D apps/web/tests/visual
```

See "Visual baselines" in [docs/architecture/ui.md](../../docs/architecture/ui.md#visual-baselines).

## When a build fails

- **Client/server build failure** — the previous bundle keeps serving; the tab keeps working. The
  error prints with file and line; fixing it rebuilds and reloads. There is no in-page overlay.
- **Package compile failure** (`tsc -b`) — the supervisor prints the diagnostics verbatim, marks
  them with a `[dev] package build FAILED` line, and **preserves** the last valid package outputs,
  the client bundle, and the running server (zero reload/restart). Consumer rebuilds/restarts stay
  suspended until a later valid edit; a correction recompiles and releases exactly one consumer
  cycle. The supervisor itself never restarts.

## Estate model

Defaults to `examples/reference/rendered/web-estate-model.json`. Export
`PULSE_WEB_ESTATE_MODEL=/abs/path.json` to override; env wins over the built-in default.

## Real engine

```
bun run dev:web --engine http://vm:8428,http://alertmanager:9093,http://gatus:8080,http://vmalert:8880
```

Or export the four `PULSE_*_URL` variables (`PULSE_VM_URL`, `PULSE_ALERTMANAGER_URL`,
`PULSE_GATUS_URL`, `PULSE_VMALERT_URL`) and pass neither flag. A missing URL fails at startup with
the same message the production server prints.

## Reading the output

- `[dev] client build started` — a rebuild kicked off.
- `[dev] client build ok  buildId=<hex>  <ms>` — rebuild succeeded; open tabs will reload next poll.
- `[dev] client build FAILED` + Bun's messages verbatim — rebuild failed; previous bundle still served.
- `[dev] server restarting (<path> changed)` — a server-source change; SIGTERM → grace → respawn.
- `[dev] server listening on http://<host>:<port>  mock=<scenario|none>` — the child bound the port.
- `[dev] server exited code=<n>` — an unintentional child exit; next server change respawns.
- `[dev] shutting down` — signal received; watchers closed, child stopped, exit 0.

## Troubleshooting

- **Port in use** — pass `--port 0` (OS-assigned; the bound port is printed) or free the port.
- **Unknown scenario** — the available list is printed on the failure line.
- **Nothing reloading** — compare the tab's `<meta name="pulse-build-id">` with the last
  `client build ok` line; if they match, the current bundle is already the latest.
