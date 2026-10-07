import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

export const AGENT_ROOT = resolve(import.meta.dir, "..");
/** Repo root: agent/tests → up two. */
export const REPO_ROOT = resolve(AGENT_ROOT, "..");

/** The published static contract artifacts under `agent/contract/`. */
export const CONTRACT_DIR = resolve(AGENT_ROOT, "contract");
export const CONFIG_SCHEMA_PATH = resolve(CONTRACT_DIR, "config.schema.json");
export const METRICS_JSON_PATH = resolve(CONTRACT_DIR, "metrics.json");
export const METRICS_CONTRACT_MD_PATH = resolve(CONTRACT_DIR, "metrics-contract.md");

/* ===========================================================================================
 * Delivery-form bundle artifacts (03 §6/§7) — the daemon-free structural suite (06 §4).
 *
 * The per-host bundle ships in two forms consuming the ONE rendered config: the compose
 * fragment and the three systemd units. The central deep-health prober is NOT a per-host
 * member — it fills stack-core's reserved slot (05 §5.2) and is asserted against the shipped
 * stack files, not the agent bundle.
 * ========================================================================================= */

/** The per-host compose bundle fragment (03 §6). */
export const COMPOSE_FRAGMENT = resolve(AGENT_ROOT, "compose", "agent.fragment.yml");
/** The per-host systemd delivery form (03 §7). */
export const SYSTEMD_DIR = resolve(AGENT_ROOT, "systemd");
/** Exactly the three per-host units — there is deliberately NO prober unit (03 §1, §8). */
export const SYSTEMD_UNITS = [
  "pulse-node-exporter.service",
  "pulse-cadvisor.service",
  "pulse-heartbeat.service",
  "pulse-command-exporter.service",
  "pulse-prober.service",
] as const;

/** The always-on + non-prober per-host units. The per-host prober (issue #8) is separate because
 *  it — unlike every other unit — legitimately references the prober image and PROBER_PORT. */
export const NON_PROBER_SYSTEMD_UNITS = SYSTEMD_UNITS.filter(
  (u) => u !== "pulse-prober.service",
);

/** Shipped stack-core files the central prober lives in (05 §5.2b). */
export const STACK_COMPOSE_FILE = resolve(REPO_ROOT, "stack", "compose", "docker-compose.yml");
export const STACK_SCRAPE_FILE = resolve(
  REPO_ROOT,
  "stack",
  "compose",
  "config",
  "victoriametrics",
  "scrape.yml",
);

/** Concrete pinned bundle images (03 §6, REQ-BUNDLE-06). node_exporter/cAdvisor mirror the
 *  shared `PINNED.*` tags (00 §3); the two Bun-built images carry their own concrete patch
 *  tags. None is `latest`/floating/placeholder. */
export const HEARTBEAT_IMAGE = "pulse/agent-heartbeat:1.0.0" as const;
export const PROBER_IMAGE = "pulse/prober:1.0.0" as const;
/** Per-host command-exporter image (issue #3/#1) — profile-gated, present only on a host with
 *  ≥1 command signal. Its own concrete patch tag; not `latest`/floating/placeholder. */
export const COMMAND_EXPORTER_IMAGE = "pulse/command-exporter:1.0.0" as const;

/** Compose profile that gates cAdvisor in the per-host fragment (03 §6.2, REQ-CONT-01). */
export const CADVISOR_PROFILE = "cadvisor" as const;
/** Compose profile that gates the heartbeat exporter in the per-host fragment (issue #33). Unlike
 *  cAdvisor, heartbeat defaults ON in the estate — deploy-toolkit activates this for every bundle
 *  host except a node-exporter-only one (heartbeat: false). */
export const HEARTBEAT_PROFILE = "heartbeat" as const;
/** Compose profile that gates the per-host command-exporter (issue #3/#1). */
export const COMMAND_EXPORTER_PROFILE = "command-exporter" as const;
/** Compose profile that gates the central prober slot in stack-core (05 §5.2, OQ-A6). */
export const DEEP_HEALTH_PROFILE = "deep-health" as const;

/* ===========================================================================================
 * Renderer agent goldens (05 §6) — host-agent's schema-validation-of-goldens contribution.
 *
 * `pulse-cli`'s `emitAgent()` renders `rendered/agent/<host>.yaml` VALUES; host-agent authors
 * `config.schema.json`. The two features align only by this shared schema (CON-06, no dep edge).
 * The determinism/idempotence witness for these files is `pulse-cli`'s own golden suite
 * (`packages/renderer/tests/golden.test.ts`); host-agent validates the committed goldens against
 * the schema it authored (06 §6), reading them on disk (never importing the renderer package).
 * ========================================================================================= */

/** The checked-in renderer whole-tree golden (the mixed-collection-class estate, 05 §6). */
export const RENDERER_GOLDEN_DIR = resolve(
  REPO_ROOT,
  "packages",
  "renderer",
  "tests",
  "golden",
  "multiclass.golden",
);
/** The rendered per-host agent configs within that golden tree — the schema-validation targets. */
export const RENDERER_AGENT_GOLDEN_DIR = resolve(RENDERER_GOLDEN_DIR, "agent");
/** The rendered manifest ledger — lists every emitted file, including the agent configs. */
export const RENDERER_MANIFEST_PATH = resolve(RENDERER_GOLDEN_DIR, ".rendered-manifest.json");

/* ===========================================================================================
 * Tier-2 bring-up smoke (06 §5) — a SEEDED bundle fixture + a LOCAL dev-build heartbeat image.
 *
 * The smoke never uses a published/released image (00 §3 has no released heartbeat tag): it
 * builds `agent/heartbeat/Dockerfile` locally into a dev tag and runs the same PINNED
 * node_exporter/cAdvisor images. The fixture (below) runs them on a bridge network so an in-stack
 * curl sidecar can prove — daemon-free CI self-skips — that node/heartbeat answer /metrics.
 * ========================================================================================= */

/** The seeded bring-up fixture — a bundle-derived compose that runs on a bridge network (not the
 *  host-networked/privileged shipped fragment, whose deploy posture deploy-toolkit owns). */
export const SMOKE_COMPOSE_FIXTURE = resolve(
  AGENT_ROOT,
  "tests",
  "fixtures",
  "bringup",
  "agent.smoke.compose.yml",
);
/** The heartbeat image Dockerfile the smoke dev-builds locally (build context = `agent/`). */
export const HEARTBEAT_DOCKERFILE = resolve(AGENT_ROOT, "heartbeat", "Dockerfile");
/** One unique identity shared by this process's project, network, and local image. */
const SMOKE_RUN_ID = `${process.pid}-${randomUUID()}`;
/** LOCAL dev-build tag — unique so concurrent smoke processes cannot overwrite one another. */
export const SMOKE_HEARTBEAT_IMAGE = `pulse/agent-heartbeat:smoke-${SMOKE_RUN_ID}`;
/** The dev version baked into the smoke heartbeat build — a non-release, obviously-dev string. */
export const SMOKE_HEARTBEAT_VERSION = "0.0.0-smoke" as const;
/** Ephemeral Compose project for this smoke lifecycle. */
export const SMOKE_PROJECT = `pulse-test-agent-${SMOKE_RUN_ID}`;
/** Compose-derived fixture network joined by the in-stack curl sidecar. */
export const SMOKE_NETWORK = `${SMOKE_PROJECT}_bundle`;
/** Pinned in-stack probe vehicle — a one-shot curl container on the fixture network (REQ per §5). */
export const CURL_IMAGE = "curlimages/curl:8.11.1" as const;

/* ===========================================================================================
 * `docker compose config` mirror types (06 §9) — the subset the structural suite asserts.
 * ========================================================================================= */

/** One rendered `ports:` entry from `config --format json`. */
export interface ComposePort {
  mode?: string;
  target: number;
  published?: string;
  protocol?: string;
}

export interface ComposeService {
  image?: string;
  profiles?: string[];
  ports?: ComposePort[];
  expose?: string[];
  restart?: string;
  network_mode?: string;
  privileged?: boolean;
  healthcheck?: Record<string, unknown>;
  volumes?: (string | Record<string, unknown>)[];
  environment?: Record<string, string> | string[];
}

export interface ComposeConfig {
  name: string;
  services: Record<string, ComposeService>;
}

/* ===========================================================================================
 * Spawn helper (06 §2) — Bun built-in (`Bun.spawnSync`, declared in bun-runtime.d.ts); no dep.
 * ========================================================================================= */

export interface Ran {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run a command to completion, capturing streams. Never throws on non-zero exit. */
export function run(argv: string[], env: Record<string, string> = {}): Ran {
  const p = Bun.spawnSync(argv, {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: p.exitCode,
    stdout: new TextDecoder().decode(p.stdout),
    stderr: new TextDecoder().decode(p.stderr),
  };
}

/** Placeholder env so the per-host fragment's `${VAR}`s interpolate (never real secrets). */
export const FRAGMENT_ENV: Record<string, string> = {
  PULSE_RENDERED_DIR: "/rendered",
  PULSE_AGENT_HOST: "fixture-host",
};

/** Placeholder env so the shipped stack compose file interpolates (never real secrets). */
export const STACK_ENV: Record<string, string> = {
  PULSE_RENDERED_DIR: "/rendered",
  PVE_TOKEN: "placeholder-not-a-secret",
  PULSE_VM_RETENTION: "6",
};

/**
 * A tiny, dependency-free validator for the exact draft-07 subset `config.schema.json` uses
 * (the repo installs no JSON-Schema runtime such as ajv, and `agent/` adds none — 06 §1).
 *
 * Supported keywords: `type` (object/string/integer/number/boolean), `required`,
 * `properties`, `additionalProperties: false`, `enum`, `const`, `minLength`, `minimum`,
 * `maximum`, `allOf`, `if`/`then`/`else`, and `not`. This is intentionally minimal — it
 * covers precisely what the authored schema (05 §2) exercises and nothing more.
 *
 * @returns The list of validation error strings; an empty array means the value is valid.
 */
export function validateJsonSchema(schema: unknown, data: unknown, path = "$"): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const s = schema as Record<string, unknown>;
  const errors: string[] = [];

  // --- composition: allOf, if/then/else, not -------------------------------------------
  if (Array.isArray(s.allOf)) {
    for (const sub of s.allOf) errors.push(...validateJsonSchema(sub, data, path));
  }
  if (s.if !== undefined) {
    const ifErrors = validateJsonSchema(s.if, data, path);
    const branch = ifErrors.length === 0 ? s.then : s.else;
    if (branch !== undefined) errors.push(...validateJsonSchema(branch, data, path));
  }
  if (s.not !== undefined) {
    if (validateJsonSchema(s.not, data, path).length === 0) {
      errors.push(`${path}: value must NOT match the 'not' subschema`);
    }
  }

  // --- type -----------------------------------------------------------------------------
  if (typeof s.type === "string") {
    if (!matchesType(s.type, data)) {
      errors.push(`${path}: expected type '${s.type}'`);
      return errors; // a wrong type makes further keyword checks meaningless
    }
  }

  // --- const / enum ---------------------------------------------------------------------
  if ("const" in s && !deepEqual(data, s.const)) {
    errors.push(`${path}: value must equal const ${JSON.stringify(s.const)}`);
  }
  if (Array.isArray(s.enum) && !s.enum.some((v) => deepEqual(v, data))) {
    errors.push(`${path}: value must be one of ${JSON.stringify(s.enum)}`);
  }

  // --- string constraints ---------------------------------------------------------------
  if (typeof data === "string" && typeof s.minLength === "number" && data.length < s.minLength) {
    errors.push(`${path}: string shorter than minLength ${s.minLength}`);
  }

  // --- number constraints ---------------------------------------------------------------
  if (typeof data === "number") {
    if (typeof s.minimum === "number" && data < s.minimum) {
      errors.push(`${path}: ${data} < minimum ${s.minimum}`);
    }
    if (typeof s.maximum === "number" && data > s.maximum) {
      errors.push(`${path}: ${data} > maximum ${s.maximum}`);
    }
  }

  // --- object constraints ---------------------------------------------------------------
  if (isPlainObject(data)) {
    const props = isPlainObject(s.properties) ? s.properties : {};
    if (Array.isArray(s.required)) {
      for (const key of s.required) {
        if (typeof key === "string" && !(key in data)) {
          errors.push(`${path}: missing required property '${key}'`);
        }
      }
    }
    for (const [key, value] of Object.entries(data)) {
      if (key in props) {
        errors.push(...validateJsonSchema(props[key], value, `${path}.${key}`));
      } else if (s.additionalProperties === false) {
        errors.push(`${path}: unexpected property '${key}' (additionalProperties: false)`);
      }
    }
  }

  return errors;
}

function matchesType(type: string, data: unknown): boolean {
  switch (type) {
    case "object":
      return isPlainObject(data);
    case "string":
      return typeof data === "string";
    case "boolean":
      return typeof data === "boolean";
    case "number":
      return typeof data === "number";
    case "integer":
      return typeof data === "number" && Number.isInteger(data);
    case "array":
      return Array.isArray(data);
    default:
      return true;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
