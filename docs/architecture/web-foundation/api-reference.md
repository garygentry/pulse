# API Reference

`@pulse/web` is private and has no package export map. The APIs below are repository-internal source-module contracts used by later web features, tests, build scripts, and the development composition. Import them by their source paths only inside this repository.

## Client API Helpers

Source: `apps/web/src/client/api/client.ts`.

### `readShellMeta(name, doc?): string | null`

Reads a named shell `<meta>` value. It returns `null` when the element or content is absent.

```typescript
import { readShellMeta, SHELL_MARKERS } from "./src/client/api/client.js";

const buildId = readShellMeta(SHELL_MARKERS.buildIdMeta);
const devMode = readShellMeta(SHELL_MARKERS.devMeta) === "1";
```

### `fetchDevBuildId(fetchImpl?): Promise<string | null>`

Fetches `GET /__dev/build-id`. Network, status, JSON, and shape failures return `null` rather than throwing.

```typescript
import { fetchDevBuildId } from "./src/client/api/client.js";

const currentBuild = await fetchDevBuildId();
if (currentBuild !== null) console.log(currentBuild);
```

### `apiFetch<T>(path, init?, fetchImpl?): Promise<T>`

Performs a same-origin JSON request with `Accept: application/json` and `cache: "no-store"` defaults. A non-2xx response throws `Error`; invalid JSON propagates `SyntaxError`.

```typescript
import { apiFetch } from "./src/client/api/client.js";
import type { OverviewSnapshot } from "./src/shared/snapshot.js";

const snapshot = await apiFetch<OverviewSnapshot>("/api/overview");
console.log(snapshot.generatedAt);
```

## Path Router

Source: `apps/web/src/client/router.ts`.

### Types

```typescript
interface RouteDef { pattern: string; view: string }
interface RouteMatch {
  path: string;
  view: string;
  params: Readonly<Record<string, string>>;
  query: Readonly<Record<string, string>>;
}
interface PathRouter {
  current(): RouteMatch;
  navigate(path: string, opts?: { replace?: boolean }): void;
  subscribe(listener: (match: RouteMatch) => void): () => void;
  stop(): void;
}
interface PathRouterOptions {
  routes: readonly RouteDef[];
  fallback: string;
  win?: Window;
}
```

`RESERVED_PREFIXES` contains `/api/`, `/assets/`, `/healthz`, and `/metrics`. `CARRIED_QUERY_KEYS` contains `kiosk` and `rotate`.

### `createPathRouter(opts): PathRouter`

Creates the History API router and installs `popstate` and document-click listeners. It throws when no browser window is available or the fallback matches no route.

```typescript
import { createPathRouter } from "./src/client/router.js";

const router = createPathRouter({
  routes: [
    { pattern: "/overview", view: "overview" },
    { pattern: "/hosts/:name", view: "host" },
  ],
  fallback: "/overview",
});

const unsubscribe = router.subscribe((route) => console.log(route));
router.navigate("/hosts/web-01?kiosk=1");
unsubscribe();
router.stop();
```

### Pure router helpers

```typescript
import {
  matchRoute,
  normalizePath,
  parseLegacyHash,
  routesFromViews,
} from "./src/client/router.js";

normalizePath("overview//"); // "/overview"
parseLegacyHash("#/overview?kiosk=1");
matchRoute([{ pattern: "/hosts/:name", view: "host" }], "/HOSTS/Web-01");
routesFromViews([{ id: "overview" }, { id: "alerts", routes: ["/alerts/:id"] }]);
```

- `normalizePath(pathname): string` collapses repeated slashes, adds a leading slash, and removes a trailing slash except at root.
- `parseLegacyHash(hash): { path; query } | null` accepts only `#/…` locations.
- `matchRoute(routes, pathname)` returns the first match with decoded parameters.
- `routesFromViews(views): RouteDef[]` creates `/<id>` plus each view’s additional patterns.

## Application Store

Sources: `apps/web/src/client/store/index.ts`, `types.ts`, and `preferences.ts`.

### `createAppStore(opts?): AppStore`

Creates all signals eagerly. `storage: null` disables persistence; `initialQuery` can be injected for tests.

```typescript
import { createAppStore } from "./src/client/store/index.js";

const store = createAppStore({ initialQuery: { kiosk: "1" } });
store.theme.value = "dark";
store.selection.value = { kind: "host", host: "web-01" };
console.log(store.density.value); // "wallboard"
```

`AppStore` contains `snapshot`, `alerts`, `engine`, `estate`, `timeline`, `connection`, `route`, `theme`, `density`, `selection`, and `session` signals. The four per-view payload signals remain generic extension slots until their owning features narrow them.

### `createHostSelectors(store): HostSelectors`

Creates content-sensitive per-host signals and a `dispose()` method. Use this when the owner needs explicit lifecycle control.

```typescript
import { createAppStore, createHostSelectors } from "./src/client/store/index.js";

const store = createAppStore({ storage: null });
const selectors = createHostSelectors(store);
const web01 = selectors.get("web-01");
console.log(web01.value);
selectors.dispose();
```

### `selectHost(store, name): ReadonlySignal<HostStatus | null>`

Returns a memoized signal for a host name. Repeated calls for the same store and name return the same signal.

```typescript
import { selectHost } from "./src/client/store/index.js";

const host = selectHost(store, "web-01");
console.log(host.value?.status ?? "absent");
```

### Preference helpers

```typescript
import {
  createPreferenceStorage,
  readDensity,
  readTheme,
} from "./src/client/store/preferences.js";

const storage = createPreferenceStorage(window);
const theme = readTheme(storage);
const density = readDensity(storage);
```

- `createPreferenceStorage(win?): PreferenceStorage | null` returns a guarded local-storage adapter.
- `readTheme(storage): Theme` validates `system | dark | light`, defaulting to `system`.
- `readDensity(storage): Density` validates `wallboard | desk`, defaulting to `desk`.
- `PREF_KEYS`, `DEFAULT_THEME`, and `DEFAULT_DENSITY` define the persisted contract.

## Live State

Source: `apps/web/src/client/store/live-state.ts`.

### `startLiveState(store, opts): LiveStateHandle`

```typescript
import { createAppStore } from "./src/client/store/index.js";
import { startLiveState } from "./src/client/store/live-state.js";

const store = createAppStore();
const live = startLiveState(store, {
  transport: "poll",
  intervalMs: 10_000,
  staleMs: 30_000,
  devBuildCheck: null,
});

window.addEventListener("pagehide", () => live.stop(), { once: true });
```

`LiveStateOptions` accepts `transport: "poll"`, optional `fetchImpl`, `intervalMs`, `staleMs`, `reload`, and `devBuildCheck`. The handle exposes idempotent `stop()` and shared single-fire `reloadOnce()`. `DEV_BUILD_CHECK_INTERVAL_MS` is `1000`.

## Lazy Chunk Styles

Source: `apps/web/src/client/store/chunk-css.ts`.

### `attachChunkStyles(key, doc?): Promise<void>`

Reads the `pulse-chunk-css` JSON island, appends missing stylesheets for a lazy module, and settles after each new link loads or errors.

```typescript
import { attachChunkStyles } from "./src/client/store/chunk-css.js";

await attachChunkStyles("views/overview/view");
```

`_resetChunkCssForTest(): void` clears the per-document island cache and is only for isolated tests.

## View and Route Extension Seams

Source: `apps/web/src/shared/registry.ts`.

```typescript
interface ViewDefinition {
  id: string;
  label: string;
  icon?: string;
  load: () => Promise<ComponentType<ViewProps>>;
  nav?: { order: number; kiosk?: boolean };
  routes?: readonly string[];
}
interface ViewProps { store: AppStore; router: PathRouter }
interface RouteDefinition {
  method: "GET";
  path: string;
  handler: (req: Request, ctx: ServerContext) => Response | Promise<Response>;
}
```

A client view module exports a component, while `src/client/views/registry.ts` holds the compile-time registration:

```typescript
import type { ViewDefinition } from "./src/shared/registry.js";

export const alertsView: ViewDefinition = {
  id: "alerts",
  label: "Alerts",
  load: () => import("./src/client/views/alerts/view.js").then((m) => m.AlertsView),
  nav: { order: 10, kiosk: true },
  routes: ["/alerts/:fingerprint"],
};
```

The example path is illustrative of repository layout; register the definition in `VIEWS` to activate it. Server routes are exact-path GET handlers registered in `src/server/routes/registry.ts`.

## Client Build Contract

Source: `apps/web/scripts/build-client.ts`.

### `buildClient(opts): Promise<ClientBuildResult>`

Builds the browser entry and never throws; failures return `{ ok: false, errors, durationMs }`.

```typescript
import { buildClient } from "./apps/web/scripts/build-client.js";

const result = await buildClient({
  outdir: "apps/web/dist/client",
  minify: false,
  sourcemap: "linked",
  clean: true,
});
if (!result.ok) throw new Error(result.errors.join("\n"));
console.log(result.manifest.buildId);
```

### Build helpers

```typescript
import {
  checkManifestInvariants,
  computeBuildId,
} from "./apps/web/scripts/build-client.js";

const buildId = computeBuildId(["dist/client/main-abc.js"]);
const errors = checkManifestInvariants(classified, metafile, "dist/client");
```

- `computeBuildId(outputPaths): string` returns a deterministic 12-hex identifier.
- `checkManifestInvariants(classified, metafile, outdir): readonly string[]` returns every violation without throwing.
- `BUILD_ID_HEX_LEN` defines the identifier length.

## Server Asset Contract

Source: `apps/web/src/server/assets.ts`.

### `parseClientManifest(text): ClientManifest | null`

```typescript
import { parseClientManifest } from "./src/server/assets.js";

const manifest = parseClientManifest(await Bun.file("dist/client/manifest.json").text());
if (manifest === null) throw new Error("invalid client manifest");
```

### `injectEntryTags(shell, manifest, opts): string`

Purely injects entry assets and shell metadata. It is idempotent for already-present quoted paths and markers.

```typescript
import { injectEntryTags } from "./src/server/assets.js";

const html = injectEntryTags("<html><head></head><body></body></html>", manifest, {
  dev: false,
});
```

### `loadStaticAssets(dir?, opts?): StaticAssets`

```typescript
import { loadStaticAssets } from "./src/server/assets.js";

const assets = loadStaticAssets("apps/web/dist/client", { dev: false });
const shell = assets.shell();
const js = assets.get("/assets/main-example.js");
console.log(shell.length, js?.contentType, assets.buildId?.());
```

The loader never throws for missing or invalid client output. `MANIFEST_FILENAME`, `ASSET_PREFIX`, and `SHELL_MARKERS` define the shared file/HTML contract.

## Mock Scenarios and Timeline

Sources: `apps/web/src/server/dev/scenario.ts`, `timeline.ts`, and `mock-engine.ts`.

### `loadScenario(fixturesDir, name): Promise<LoadedScenario>`

Loads and validates the three source fixtures plus optional timeline. It throws `MockScenarioError` with code `MOCK_SCENARIO_UNKNOWN` or `MOCK_SCENARIO_INVALID`.

```typescript
import { loadScenario } from "./src/server/dev/scenario.js";

const scenario = await loadScenario("apps/web/tests/fixtures/engine", "all-green");
console.log(scenario.timeline.steps.length);
```

### `applyTimeline(base, timeline, elapsedMs): ScenarioState`

```typescript
import { applyTimeline } from "./src/server/dev/timeline.js";

const state = applyTimeline(scenario.base, scenario.timeline, 30_000);
console.log(state.appliedSteps, [...state.outages]);
```

### `freshenGatus(body, wallNowMs): GatusStatusesResponse`

Returns a copy with fixture timestamps rebased to the supplied wall clock while preserving their authored age.

```typescript
import { freshenGatus } from "./src/server/dev/timeline.js";

const currentChecks = freshenGatus(scenario.base.gatus, Date.now());
```

### `createMockEngine(opts): Promise<MockEngine>`

```typescript
import { createMockEngine, MOCK_BASE_URLS } from "./src/server/dev/mock-engine.js";

const engine = await createMockEngine({ scenario: "degraded-mix" });
const response = await engine.fetchImpl(`${MOCK_BASE_URLS.vmUrl}/api/v1/query`);
console.log(response.status, engine.state().appliedSteps);
```

`listScenarios(dir?): Promise<string[]>` returns sorted valid scenario-directory names and returns an empty list for an unreadable root.

## Server Configuration

### `loadServerConfig(env?): ServerConfig`

Source: `apps/web/src/server/config.ts`. The three engine URLs are required; missing values throw `ConfigError`. Other values degrade to documented defaults.

```typescript
import { loadServerConfig } from "./src/server/config.js";

const config = loadServerConfig({
  PULSE_VM_URL: "http://vm:8428",
  PULSE_ALERTMANAGER_URL: "http://alertmanager:9093",
  PULSE_GATUS_URL: "http://gatus:8080",
});
```

## Runtime Environment

| Variable | Required | Default or behavior |
|---|---:|---|
| `PULSE_VM_URL` | yes | Startup fails when absent or empty |
| `PULSE_ALERTMANAGER_URL` | yes | Startup fails when absent or empty |
| `PULSE_GATUS_URL` | yes | Startup fails when absent or empty |
| `PULSE_WEB_ESTATE_MODEL` | no | `null`; server enters recoverable error-page mode |
| `PULSE_ESTATE_TZ` | no | UTC with fallback marker |
| `PULSE_GRAFANA_URL` | no | Deep links disabled |
| `PULSE_GATUS_STALE_SECONDS` | no | `300` |
| `PULSE_BUILD_VERSION` | build only | Falls back to `WEB_APP_VERSION`, then `0.0.0-dev` |

Production listens on fixed port `8080`. `PULSE_WEB_PORT` and related `PULSE_WEB_*` protocol variables are internal communication between the dev supervisor and child, not production configuration.
