// src/client/target-ref.ts — the one display/URL form of a `TargetIdentity` (GitHub #10).
//
// The wire already carries canonical, kind-prefixed ids for declared targets: hosts are
// `host:<name>` and services `svc:<host>/<name>` (web-data `toTargetIdentity`, the overview
// `drilldownId`). Composing `${kind}:${id}` over them doubles the prefix (`host:host:web01`), so every
// operator-facing string and every alerts `hs` value goes through `targetRef` instead.
//
// Endpoint ids are raw Gatus endpoint names (`web01/grafana`, `host:web01`, `dns:example.org`): they
// carry no kind prefix of their own and can collide with a host id, so they keep an explicit
// `endpoint:` prefix. Internal map/cache keys (timeline `targetKey`, history request keys) are not
// shown to anyone and keep their own `${kind}:${id}` form.
import type { TargetIdentity } from "@pulse/web-data/wire";

/**
 * The canonical reference for a target, with its kind shown exactly once:
 * `{host, "host:web01"}` → `"host:web01"`, `{service, "svc:web01/nginx"}` → `"svc:web01/nginx"`,
 * `{endpoint, "web01/grafana"}` → `"endpoint:web01/grafana"`.
 *
 * @param target - The wire target identity.
 * @returns The single-prefixed reference string.
 */
export function targetRef(target: TargetIdentity): string {
  return target.kind === "endpoint" ? `endpoint:${target.id}` : target.id;
}

/** Pre-#10 alerts `hs` values composed `${kind}:${id}` over the canonical id. */
const LEGACY_REF_PREFIXES = [
  ["host:host:", "host:"],
  ["service:svc:", "svc:"],
] as const;

/**
 * Map a pre-#10 double-prefixed reference (`host:host:web01`, `service:svc:web01/nginx`) to its
 * canonical form, so links shared before the fix keep filtering. Any other value is returned unchanged.
 *
 * @param ref - A reference string read from a URL.
 * @returns The canonical reference.
 */
export function normalizeTargetRef(ref: string): string {
  for (const [legacy, canonical] of LEGACY_REF_PREFIXES) {
    if (ref.startsWith(legacy)) return canonical + ref.slice(legacy.length);
  }
  return ref;
}
