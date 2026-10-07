# Web Foundation

`web-foundation` is the implementation substrate for the Pulse operator web app. It gives `@pulse/web` a deterministic client build, manifest-driven asset delivery, a signals-based client store, History API routing, lazy view loading, a production-shaped development loop, fixture-backed engine mocks, and reusable DOM/browser test infrastructure.

The package remains a private application and compose service, not a published TypeScript library. Its source-module exports are extension seams for code inside this repository.

## Quick Start

From the repository root:

```bash
bun install
bun run dev:web --mock
```

Open `http://127.0.0.1:8080`. The default `all-green` scenario uses committed fixtures, so VictoriaMetrics, Alertmanager, Gatus, and the compose stack are not required.

Run against real engines instead:

```bash
bun run dev:web --engine \
  http://localhost:8428,http://localhost:9093,http://localhost:8081
```

Build and validate the production artifacts:

```bash
bun run --filter @pulse/web build
bun run typecheck
bun test
bun run smoke:web
```

## Key Concepts

### One client build contract

`apps/web/scripts/build-client.ts` is the only client bundler. Production builds, development rebuilds, and bundle tests all call `buildClient()`. It emits hashed entries and chunks, separate sourcemaps, and an atomic `dist/client/manifest.json`.

The server reads that manifest and injects only entry CSS and JavaScript into the shell. Lazy chunks remain fetch-on-demand. A JSON island maps lazy modules to their CSS, allowing the browser to await a view component and its styles together before rendering.

### One application store

`createAppStore()` creates independently subscribable signals (`@preact/signals-core`) for the overview snapshot, connection state, route, preferences, selection, session, and future view payloads. React components read them through `@preact/signals-react`, calling `useSignals()` before reading any `.value` during render. Views receive only `{ store, router }`, which keeps transport and shell concerns out of view modules.

### Path-owned views

`createPathRouter()` uses browser history rather than hash navigation. It supports typed `:param` segments, legacy `#/…` redirects, carried kiosk/rotation query parameters, scroll restoration, and SPA link interception. A view owns its primary `/<id>` path and may declare additional patterns.

### Production-shaped development

`bun run dev:web` supervises the real server composition, client rebuilds, and server restarts. Mock mode replaces only the source-fetch dependency; request routing, snapshot construction, asset loading, and the React application remain production code.

### Failure containment

A failed client rebuild keeps the previous bundle available. A missing or malformed client manifest falls back to directory scanning. Source outages become degraded snapshot data rather than process failures. Client preferences fall back to in-memory defaults when browser storage is unavailable.

## Module Map

| Area | Location | Responsibility |
|---|---|---|
| Client build | `apps/web/scripts/build-client.ts` | Bundle, classify outputs, enforce manifest invariants, publish atomically |
| Production build | `apps/web/scripts/build.ts` | Stamp version, build client, bundle Bun server |
| Dev supervisor | `apps/web/scripts/dev.ts` | Parse CLI, watch sources, rebuild client, restart server child |
| Asset loader | `apps/web/src/server/assets.ts` | Validate manifest, inject shell tags, serve assets, fallback safely |
| Client bootstrap | `apps/web/src/client/main.tsx` | Compose store, router, live state, and React root |
| Store | `apps/web/src/client/store/` | Signals, preferences, polling adapter, lazy chunk CSS |
| Router | `apps/web/src/client/router.ts` | History API routing and view-derived route definitions |
| View seam | `apps/web/src/shared/registry.ts` | Read-only server route and lazy client view contracts |
| Mock engine | `apps/web/src/server/dev/` | Scenario loading, timeline folding, fetch-shaped source mocks |
| Test kit | `apps/web/tests/dom.ts`, `apps/web/tests/rtl.ts`, `apps/web/tests/browser/_harness.ts` | DOM lifecycle, store-aware rendering, React Testing Library wrapper, browser fixture pages |

## Configuration

Production listens on fixed port `8080`. It requires engine URLs in `PULSE_VM_URL`, `PULSE_ALERTMANAGER_URL`, and `PULSE_GATUS_URL`. The estate model, timezone, Grafana URL, and Gatus freshness threshold remain optional.

Development accepts `--mock`, `--engine`, `--port`, `--host`, and `--clock`. See the [Integration Guide](./guides/integration.md) for complete workflows and the [API Reference](./api-reference.md) for exact contracts.

## When to Use

Use this foundation when you:

- add a client view or deep-link route;
- add shared client state without coupling it to a component tree;
- need deterministic source data for UI development or screenshots;
- change client bundling, lazy loading, or server shell injection;
- write DOM or browser acceptance tests for `apps/web`.

## When Not to Use

Do not treat `@pulse/web` as an importable library; it has no package export map and is private. Do not use the mock engine in production, bypass the source clients from browser code, inject lazy chunks into the shell, or add mutating HTTP routes—the registered server seam is intentionally GET-only.

The application also provides no authentication. Run production or LAN-bound development only on a trusted network or behind an authenticating reverse proxy.

## Further Reading

- [Architecture](./architecture.md) — build, runtime, client, and development data flows
- [API Reference](./api-reference.md) — source-module seams and runtime configuration
- [Integration Guide](./guides/integration.md) — add views, routes, scenarios, tests, and deployment wiring
- [Web App](../web-app/README.md) — operator-facing service and snapshot behavior
- [Web UI](../ui.md) — React 19, Tailwind v4, and the `@/ui` component library
