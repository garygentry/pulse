// apps/web/tests/prod-build.test.ts — the production build driver + Docker gate (item 052).
//
// Evidence for 02-architecture-layout-and-package-build.md §8 (build/Docker) and §12 (error rows):
//   - runBuild compiles the @pulse/web-data package graph FIRST, before any client/server bundle;
//   - a package compile failure throws and publishes no version stamp, client manifest, or server
//     bundle (AC3 "a compile failure leaves no newly published client/server bundle or manifest");
//   - a client bundle failure likewise never reaches the server bundle;
//   - the real compileWorkspacePackages default runs `tsc -b packages/web-data` at the repo root;
//   - the Dockerfile frozen build copies only declared workspace inputs and .dockerignore excludes
//     host dist/.tsbuildinfo (AC4), and the runtime stage ships the required app outputs.
//
// The ordering/failure tests inject spies for the heavy steps, so they are fast and deterministic;
// the real client/server bundle is exercised by client-build.test.ts and the Docker smoke tier.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  REPO_ROOT,
  bundleServer,
  compileWorkspacePackages,
  runBuild,
} from "../scripts/build.js";
import type { RunBuildDeps } from "../scripts/build.js";
import type { BuildMetafile, ClientBuildOptions, ClientBuildResult } from "../scripts/build-client.js";
import type { ClientManifest } from "../src/server/assets.js";

/** A minimal successful client-bundle result — runBuild only inspects `.ok`. */
const OK_CLIENT: ClientBuildResult = {
  ok: true,
  manifest: {} as ClientManifest,
  metafile: {} as BuildMetafile,
  durationMs: 0,
};

// ── AC3: web-data compiles first; failure publishes nothing ──────────────────────────────────────

describe("runBuild step ordering (02 §8)", () => {
  test("compiles the package graph before stamping version or bundling client/server", async () => {
    const order: string[] = [];
    let compileRepoRoot = "";
    let clientOutdir = "";
    const deps: RunBuildDeps = {
      compilePackages: async (repoRoot) => {
        compileRepoRoot = repoRoot;
        order.push("compile");
      },
      writeVersion: () => order.push("writeVersion"),
      buildClientImpl: async (opts: ClientBuildOptions) => {
        clientOutdir = opts.outdir;
        order.push("client");
        return OK_CLIENT;
      },
      bundleServerImpl: async () => {
        order.push("server");
      },
      repoRoot: "/fake/repo",
      distDir: "/fake/dist",
    };

    await runBuild("9.9.9", deps);

    expect(order).toEqual(["compile", "writeVersion", "client", "server"]);
    expect(compileRepoRoot).toBe("/fake/repo");
    expect(clientOutdir).toBe(resolve("/fake/dist", "client"));
  });

  test("a package compile failure throws before any version/client/server publication", async () => {
    let versionStamped = false;
    let clientBuilt = false;
    let serverBuilt = false;
    const deps: RunBuildDeps = {
      compilePackages: async () => {
        throw new Error("tsc -b exited 2");
      },
      writeVersion: () => {
        versionStamped = true;
      },
      buildClientImpl: async () => {
        clientBuilt = true;
        return OK_CLIENT;
      },
      bundleServerImpl: async () => {
        serverBuilt = true;
      },
    };

    await expect(runBuild("1.0.0", deps)).rejects.toThrow(/tsc -b exited 2/);
    // Nothing downstream ran: no version stamp, no client manifest, no server bundle.
    expect(versionStamped).toBe(false);
    expect(clientBuilt).toBe(false);
    expect(serverBuilt).toBe(false);
  });

  test("a client bundle failure never reaches the server bundle", async () => {
    let serverBuilt = false;
    const deps: RunBuildDeps = {
      compilePackages: async () => {},
      writeVersion: () => {},
      buildClientImpl: async () => ({ ok: false, errors: ["boom"], durationMs: 0 }),
      bundleServerImpl: async () => {
        serverBuilt = true;
      },
    };
    await expect(runBuild("1.0.0", deps)).rejects.toThrow(/client bundle failed/);
    expect(serverBuilt).toBe(false);
  });
});

describe("compileWorkspacePackages default", () => {
  test("runs `tsc -b packages/web-data` at the repo root and resolves on success", async () => {
    // Incremental: the shared dist is already built, so this is a fast no-op compile that proves the
    // real command/cwd wiring. REPO_ROOT is two levels up from apps/web.
    expect(REPO_ROOT).toBe(resolve(import.meta.dir, "../../.."));
    await compileWorkspacePackages();
  }, 120_000);

  test("bundleServer is exported for injection/reuse", () => {
    expect(typeof bundleServer).toBe("function");
  });
});

// ── AC4: frozen Docker build uses declared workspace inputs only, no host outputs ────────────────

describe("Dockerfile frozen build (02 §8, AC4)", () => {
  const dockerfile = readFileSync(resolve(REPO_ROOT, "apps/web/Dockerfile"), "utf8");
  const dockerignore = readFileSync(resolve(REPO_ROOT, ".dockerignore"), "utf8");

  test("copies root manifests + lockfile and every declared workspace input", () => {
    expect(dockerfile).toContain("COPY package.json bun.lock");
    expect(dockerfile).toContain("COPY packages/core packages/core");
    expect(dockerfile).toContain("COPY packages/renderer packages/renderer");
    expect(dockerfile).toContain("COPY packages/web-data packages/web-data");
    expect(dockerfile).toContain("COPY apps/web apps/web");
  });

  test("performs a frozen install then builds the package graph and app bundle", () => {
    expect(dockerfile).toContain("bun install --frozen-lockfile");
    expect(dockerfile).toContain("tsc -b packages/web-data");
    expect(dockerfile).toContain("bun run scripts/build.ts");
    // web-data graph must be compiled before the app bundle.
    expect(dockerfile.indexOf("tsc -b packages/web-data")).toBeLessThan(
      dockerfile.indexOf("bun run scripts/build.ts"),
    );
  });

  test("never copies host dist/ or .tsbuildinfo from the build context", () => {
    // A context COPY (no `--from=`) must not pull a host dist or tsbuildinfo. A `--from=build` COPY
    // is a stage-to-stage copy of freshly built output (the runtime dist), which is required.
    for (const line of dockerfile.split("\n")) {
      if (!line.startsWith("COPY") || line.includes("--from=")) continue;
      expect(line.includes("dist"), `unexpected host dist COPY: ${line}`).toBe(false);
      expect(line.includes(".tsbuildinfo"), `unexpected host tsbuildinfo COPY: ${line}`).toBe(false);
    }
    // …and the build context excludes them so a `COPY apps/web apps/web` cannot smuggle host output.
    expect(dockerignore).toMatch(/^\*\*\/dist$/m);
    expect(dockerignore).toMatch(/^\*\*\/\.tsbuildinfo$/m);
  });

  test("the runtime stage ships the required app outputs", () => {
    expect(dockerfile).toContain("COPY --from=build /app/apps/web/dist ./dist");
    expect(dockerfile).toContain('CMD ["bun", "dist/server/index.js"]');
  });

  test("copies every workspace member manifest a frozen install must resolve", () => {
    // The root package.json globs `packages/*` + `apps/*` + `agent-kit`, so `--frozen-lockfile`
    // resolves the WHOLE workspace graph; a member whose manifest is absent from the context
    // makes the frozen install fail with lockfile drift. Beyond the core/renderer/web-data/web
    // sources copied above, the manifest-only members must also be present (AC4 "declared
    // workspace inputs only"): dropping one silently breaks the frozen Docker build.
    for (const manifest of [
      "apps/cli/package.json",
      "apps/docs/package.json",
      "agent-kit/package.json",
    ]) {
      expect(dockerfile).toContain(`COPY ${manifest} ${manifest}`);
    }
    // …and the frozen install ignores lifecycle scripts (the root postinstall links into a
    // stack/ path irrelevant to this image), so scripts/ need not enter the context.
    expect(dockerfile).toContain("bun install --frozen-lockfile --ignore-scripts");
  });
});

// ── AC4: the image is built with the repository root as context ──────────────────────────────────

describe("compose builds @pulse/web with repository context (02 §8, AC4)", () => {
  const compose = readFileSync(
    resolve(REPO_ROOT, "stack/compose/docker-compose.yml"),
    "utf8",
  );

  /** Slice the `web:` service block out of the 2-space-indented service map. */
  function webServiceBlock(): string {
    const lines = compose.split("\n");
    const start = lines.findIndex((l) => l === "  web:");
    expect(start, "compose must declare a `web:` service").toBeGreaterThanOrEqual(0);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]!;
      // The next top-level (2-space) service key ends the block; deeper indent / comments / blanks stay.
      if (/^ {2}[A-Za-z0-9_-]+:/.test(line)) {
        end = i;
        break;
      }
    }
    return lines.slice(start, end).join("\n");
  }

  test("the web service build stanza uses the repo-root context and apps/web/Dockerfile", () => {
    const block = webServiceBlock();
    // A single-dir `apps/web` context cannot reach the sibling @pulse/core/renderer/web-data the
    // Dockerfile COPYs, so the context must be the repository root (`../../` from stack/compose/).
    expect(block).toMatch(/^\s*context:\s*\.\.\/\.\.\/?\s*(#.*)?$/m);
    expect(block).toMatch(/^\s*dockerfile:\s*apps\/web\/Dockerfile\s*(#.*)?$/m);
  });
});
