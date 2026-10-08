# Integration Guide

This guide covers the extension workflows enabled by `web-foundation`: local development, client views and routes, server GET routes, mock scenarios, tests, and production delivery.

## Run the Development Composition

Install dependencies and start the default fixture-backed estate:

```bash
bun install
bun run dev:web --mock
```

The supervisor binds `127.0.0.1:8080`, builds the client, starts the real server runtime from source, and selects `all-green`.

### Select a scenario

```bash
bun run dev:web --mock degraded-mix
bun run dev:web --mock source-outage
```

Use a deterministic timeline clock for screenshots or repeatable debugging:

```bash
bun run dev:web --mock degraded-mix --clock 2026-01-01T00:00:00Z
```

`--clock` pins the scenario start (process start without it). Alertmanager, vmalert, and VictoriaMetrics fixture timestamps are shifted onto that start, keeping their authored offsets from the fixture anchor (`2026-01-01T00:00:00Z`): an alert authored 19 minutes before the anchor is 19 minutes old when the scenario starts. Gatus results follow the live wall clock instead, so checks never go stale. A pinned `--clock` serves the same Alertmanager, vmalert, and VictoriaMetrics bytes on every run; `--clock 2026-01-01T00:00:00Z` serves the fixtures verbatim.

### Connect to real engines

Pass three comma-separated absolute URLs in VictoriaMetrics, Alertmanager, Gatus order:

```bash
bun run dev:web --engine \
  http://localhost:8428,http://localhost:9093,http://localhost:8081
```

Alternatively, set `PULSE_VM_URL`, `PULSE_ALERTMANAGER_URL`, and `PULSE_GATUS_URL` and omit both `--mock` and `--engine`.

### Change the bind address

```bash
bun run dev:web --mock --port 0
bun run dev:web --mock --host 0.0.0.0
```

Port `0` requests an OS-assigned port, printed after the child binds. Bind `0.0.0.0` only for intentional LAN access. The application has no authentication, so do not expose it to an untrusted network.

## Understand Reload Behavior

Client or shared-source changes trigger a client rebuild. On success, tabs detect the new build ID and reload once. A failed build leaves the previous bundle serving and prints the compiler diagnostics; fix the error to trigger another build.

Server, shared, or version-source changes stop and restart the child. Tabs do not reload for a server-only change; snapshot polling resumes when the child returns.

The dev supervisor watches source paths, not generated `dist/` or `.tsc-out/` files, so successful output publication does not retrigger itself.

## Add a Client View

A view consists of a module and one compile-time registry entry.

Create `apps/web/src/client/views/example/view.tsx`:

```tsx
import type { ReactElement } from "react";
import { useSignals } from "@preact/signals-react/runtime";
import { Button, PageHeader } from "@/ui";
import type { ViewProps } from "../../../shared/registry.js";

export function ExampleView({ store, router }: ViewProps): ReactElement {
  useSignals(); // required before reading any signal's .value during render
  const connection = store.connection.value;
  return (
    <div data-slot="example-page">
      <PageHeader title="Example" />
      <p>Connection: {connection.phase}</p>
      <Button type="button" onClick={() => router.navigate("/overview")}>
        Return to overview
      </Button>
    </div>
  );
}
```

Build the view from the `@/ui` barrel (`PageHeader` supplies the page's one `h1`). See [Web UI](../../ui.md) for the component library, the `useSignals()` rule, and the guardrail tests that enforce them.

Add its definition to `apps/web/src/client/views/registry.ts`:

```typescript
import type { ViewDefinition } from "../../shared/registry.js";

const example: ViewDefinition = {
  id: "example",
  label: "Example",
  load: () => import("./example/view.js").then((module) => module.ExampleView),
  nav: { order: 20, kiosk: false },
  routes: ["/example/:section"],
};

export const VIEWS: readonly ViewDefinition[] = [overview, example];
```

`routesFromViews()` registers `/example` and `/example/:section`. The router writes decoded parameters into `store.route.value.params`. Keep reserved server paths out of view routes.

The build places the lazy module in its own chunk. Views style with Tailwind token classes, which compile into the one global sheet, so a view normally emits no CSS of its own. If a lazy chunk does import a third-party stylesheet, the manifest associates it with the chunk's key (`views/example/view` for the view entry); `ViewHost` waits for both module and stylesheet settlement.

## Add a Read-Only Server Route

Create an exact-path handler using the shared route seam:

```typescript
import type { RouteDefinition } from "../../shared/registry.js";

export const exampleRoute: RouteDefinition = {
  method: "GET",
  path: "/api/example",
  handler(_request, context) {
    return Response.json({
      estateLoaded: context.estate !== null,
      generatedAt: context.snapshot?.generatedAt ?? null,
    });
  },
};
```

Register it in `apps/web/src/server/routes/registry.ts`. The handler receives the parsed configuration, loaded estate, current immutable snapshot, and typed source clients. Do not reread configuration or construct engine URLs in a handler.

The seam intentionally cannot register mutation methods. If a feature needs mutation, it requires a separately designed security and authorization boundary rather than widening this route type casually.

## Add a Mock Scenario

Create a directory under `apps/web/tests/fixtures/engine/`:

```text
my-scenario/
├── vm.json
├── alertmanager.json
├── gatus.json
└── timeline.json        # optional
```

The three required files must use the real upstream wire shapes because `loadScenario()` validates them with production source parsers.

Author every timestamp relative to the fixture anchor `2026-01-01T00:00:00Z` (`FIXTURE_ANCHOR` in `src/server/dev/timeline.ts`), treating it as the scenario start. An alert-fire step's `startsAt` is the anchor plus its `atMs`. The mock engine keeps each timestamp's offset from the anchor and moves it onto the real scenario start. Go's zero time `0001-01-01T00:00:00Z` is left as-is.

A timeline has ascending non-negative millisecond offsets:

```json
{
  "steps": [
    { "atMs": 5000, "step": { "op": "host-down", "host": "web01" } },
    { "atMs": 15000, "step": { "op": "host-up", "host": "web01" } },
    { "atMs": 20000, "step": { "op": "outage-begin", "source": "gatus" } },
    { "atMs": 30000, "step": { "op": "outage-end", "source": "gatus" } }
  ]
}
```

Supported operations are:

- `host-down`, `host-up` with `host`;
- `alert-fire` with a raw Alertmanager alert;
- `alert-resolve` with `alertname` and `instance`;
- `check-fail`, `check-pass` with `endpoint`;
- `outage-begin`, `outage-end` with `source` equal to `vm`, `alertmanager`, or `gatus`.

Validate the scenario by starting it:

```bash
bun run dev:web --mock my-scenario --clock 2026-01-01T00:00:00Z
```

An unknown name fails at startup and lists available scenarios. Invalid fixture or timeline content fails once at scenario construction rather than degrading silently at request time.

## Write Component Tests

Use the per-file DOM harness instead of installing a global DOM preload:

```tsx
import { expect, test } from "bun:test";
import { describeUi } from "./rtl.js";
import { renderWithStore } from "./dom.js";
import { ExampleView } from "../src/client/views/example/view.js";

describeUi("ExampleView", () => {
  test("shows connection state", async () => {
    const mounted = await renderWithStore(ExampleView);
    expect(mounted.container.textContent).toContain("Connection: initial");
    mounted.unmount();
  });
});
```

`describeUi` (from `apps/web/tests/rtl.ts`) is `describeDom` plus the Radix stubs and per-test unmount; import React Testing Library helpers (`screen`, `userEvent`, …) from `tests/rtl.ts`, never from `@testing-library/*`. Use the exact helper signature present in `apps/web/tests/dom.ts` when integrating a real component; it can accept caller-supplied store/router state. The `dom-guard` test detects DOM-using test files that bypass the harness.

## Run Browser Acceptance Tests

Provision the browser associated with the pinned `playwright-core` version:

```bash
bunx playwright-core install chromium
PULSE_REQUIRE_BROWSER=1 bun test apps/web/tests/browser
```

Without `PULSE_REQUIRE_BROWSER=1`, local browser cases may skip when Chromium is absent. CI sets the variable, so missing browser provisioning fails closed.

## Validate Build and Runtime Boundaries

Run the normal gate from the repository root:

```bash
bun run typecheck
bun test
bun run smoke:web
```

Useful focused checks include:

```bash
bun test apps/web/tests/client-build.test.ts
bun test apps/web/tests/assets.test.ts apps/web/tests/chunk-css.test.ts
bun test apps/web/tests/router.test.ts apps/web/tests/store.test.ts
bun test apps/web/tests/dev-cli.test.ts apps/web/tests/dev-loop.test.ts
bun test apps/web/tests/prod-isolation.test.ts
```

The production-isolation test protects both directions: development/mock modules cannot enter the production server graph, and server modules cannot enter the client bundle.

## Build and Deploy

Build from the repository workspace:

```bash
bun run --filter @pulse/web build
docker build -f apps/web/Dockerfile .
```

The Docker build requires the repository root as context because the workspace dependencies live outside `apps/web`.

Production configuration:

```bash
PULSE_VM_URL=http://victoriametrics:8428 \
PULSE_ALERTMANAGER_URL=http://alertmanager:9093 \
PULSE_GATUS_URL=http://gatus:8080 \
PULSE_WEB_ESTATE_MODEL=/rendered/web-estate-model.json \
bun apps/web/dist/server/index.js
```

The server listens on fixed port `8080`. Mount the rendered model read-only and place the service on a trusted network or behind an authenticating reverse proxy. See [Web App Integration](../../web-app/guides/integration.md) for compose-slot wiring.

## Troubleshooting

### A rebuild succeeds but the tab does not reload

Compare the latest `client build ok buildId=…` line with `<meta name="pulse-build-id">` in the current page. If they match, the tab already has the latest bundle. If the shell is in manifest fallback mode, no build ID is available; inspect `dist/client/manifest.json` and the server fallback log.

### The server starts in error-page mode

Check `PULSE_WEB_ESTATE_MODEL` and verify the file exists, is readable, and has the supported rendered-model format. Development defaults to `examples/reference/rendered/web-estate-model.json`; production does not.

### A mock scenario is rejected

Confirm all three required files exist and contain valid VictoriaMetrics, Alertmanager, and Gatus response shapes. Ensure timeline steps are sorted by `atMs` and use only the closed operation vocabulary.

### A deep link falls back to overview

Ensure the route pattern is present in a registered `ViewDefinition`, has the same number of path segments, and does not begin with a reserved prefix. Parameters decode once; malformed percent escapes remain literal rather than crashing.

### Browser tests skip locally

Install Chromium with `bunx playwright-core install chromium`. To reproduce CI behavior, set `PULSE_REQUIRE_BROWSER=1`; the suite will then fail rather than skip if the browser is unavailable.
