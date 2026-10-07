// packages/renderer/src/render/alertmanager.ts — Alertmanager routing + receivers ONLY
// (02 §4.3, REQ-RND-08).
//
// Emits a single `alertmanager/routing.yaml` = `{ route: <root>, receivers: AmReceiver[] }`,
// derived ONLY from `model.channels` and `model.routingOverrides`. It authors NO PromQL rules,
// NO `groups:`, NO severity-taxonomy semantics, and does NOT expand the estate `deadmanHook` —
// those belong to `alerting`'s rule-library, downstream (no backward dependency). `severity` is
// an opaque core string here. Every channel credential flows through `renderSecretRef` (02 §7):
// a reference string only, never a resolved value (REQ-SEC-02).
import type { Channel, ChannelKind, EstateModel } from "@pulse/core";

import { compareString } from "../order.js";
import { toCanonicalYaml } from "../format.js";
import type { EmitResult } from "./emit-result.js";
import { renderSecretRef } from "./secrets.js";
import type { CredentialSite } from "./secrets.js";

/** The stub receiver emitted when the estate declares no channel, so the root route is valid. */
const DEFAULT_RECEIVER = "pulse-default";

/** One Alertmanager receiver, one per declared channel (or a single stub when none). */
export interface AmReceiver {
  /** Receiver name = the channel `name` (unique across the estate). */
  name: string;
  /**
   * The channel kind mapped to Alertmanager's receiver config key
   * (`chat`→`slack_configs` / `email`→`email_configs` / `telegram`→`telegram_configs` /
   * `push`/`webhook`→`webhook_configs`). The credential slot within holds
   * `renderSecretRef(channel.credential)` — a reference string, never a resolved value
   * (02 §7, REQ-SEC-02). Refused credentials omit the field. Non-secret `channel.options`
   * (e.g. Telegram's `chat_id`) are emitted verbatim alongside the credential slot (issue #2).
   */
  config: Record<string, unknown>;
}

/** One Alertmanager route: a severity match routed to one receiver. Internal (pre-serialize). */
interface AmRoute {
  /** Severity label to match (from a `RoutingOverride.severity`); opaque to this feature. */
  severity: string;
  /** Receiver name to route to (a target channel of the override). */
  receiver: string;
  /** Alertmanager `continue`; `true` for a multi-target (fan-out) override, else `false`. */
  continue: boolean;
}

/**
 * Emit `alertmanager/routing.yaml`: `{ route: <root>, receivers: AmReceiver[] }` derived ONLY
 * from declared channels + severity routing overrides (REQ-RND-08). No PromQL rules, no severity
 * taxonomy, no `deadmanHook` expansion. Receivers are sorted by `name`; routes are sorted by
 * `severity` then `receiver` (raw code-point). Always emits exactly one file — a default receiver
 * is always present (the first channel by name, or a `"pulse-default"` stub when none).
 *
 * @param model - The validated estate.
 * @returns Exactly one `RenderedFile` (`alertmanager/routing.yaml`), plus any secret-refusal
 *          findings from channel-credential serialization (02 §7).
 */
export function emitAlertmanager(model: EstateModel): EmitResult {
  const findings: EmitResult["findings"] = [];

  // Receivers: one per channel, or a single empty-config stub when the estate declares none.
  const receivers: AmReceiver[] =
    model.channels.length === 0
      ? [{ name: DEFAULT_RECEIVER, config: {} }]
      : model.channels.map((channel) => ({
          name: channel.name,
          config: receiverConfig(channel, findings),
        }));
  receivers.sort((a, b) => compareString(a.name, b.name));

  // Default receiver: the first channel by name (deterministic), or the stub when none.
  const defaultReceiver = receivers[0]?.name ?? DEFAULT_RECEIVER;

  // Severity routes: each RoutingOverride fans out to one child route per target channel.
  const routes: AmRoute[] = [];
  for (const override of model.routingOverrides) {
    const fanOut = override.channels.length > 1;
    for (const receiver of override.channels) {
      routes.push({ severity: override.severity, receiver, continue: fanOut });
    }
  }
  routes.sort(
    (a, b) => compareString(a.severity, b.severity) || compareString(a.receiver, b.receiver),
  );

  const route = {
    receiver: defaultReceiver,
    routes: routes.map((r) => ({
      continue: r.continue,
      match: { severity: r.severity },
      receiver: r.receiver,
    })),
  };

  return {
    files: [{ path: "alertmanager/routing.yaml", contents: toCanonicalYaml({ route, receivers }) }],
    findings,
  };
}

/**
 * Build a receiver's `config` keyed by `channel.kind`, placing the channel credential (as a
 * reference string, via `renderSecretRef` — 02 §7) into the kind's credential slot. A non-`SecretRef`
 * credential (impossible post-validation) omits the slot field and appends a `SECRET_LITERAL`
 * finding — never a crash, never an embedded literal (REQ-SEC-02).
 */
function receiverConfig(channel: Channel, findings: EmitResult["findings"]): Record<string, unknown> {
  const { listKey, field } = configSlot(channel.kind);
  // Seed the entry with the channel's non-secret `options` (issue #2) — e.g. Telegram's `chat_id`.
  // These are plain scalars carried verbatim into the provider slot; the credential is placed below.
  // Only telegram declares options today, so other receivers' output is unchanged.
  const entry: Record<string, unknown> = { ...(channel.options ?? {}) };
  const site: CredentialSite = {
    file: "alertmanager/routing.yaml",
    path: `receivers.${channel.name}.credential`,
  };
  const secret = renderSecretRef(channel.credential, site);
  if (secret.ok) entry[field] = secret.ref;
  else findings.push(secret.finding); // omit the field; never emit a literal (02 §7).
  return { [listKey]: [entry] };
}

/** Map a `ChannelKind` to its Alertmanager receiver config list key and credential field. */
function configSlot(kind: ChannelKind): { listKey: string; field: string } {
  switch (kind) {
    case "chat":
      return { listKey: "slack_configs", field: "api_url" };
    case "email":
      return { listKey: "email_configs", field: "auth_password" };
    // Telegram (issue #2): bot token → `bot_token`; the non-secret `chat_id` rides in via `options`.
    case "telegram":
      return { listKey: "telegram_configs", field: "bot_token" };
    case "push":
    case "webhook":
      return { listKey: "webhook_configs", field: "url" };
    default:
      return assertNever(kind);
  }
}

/**
 * Exhaustiveness guard over `ChannelKind`. If every kind is handled, `kind` narrows to `never` and
 * this is unreachable — adding a channel kind to `@pulse/core` becomes a renderer type error.
 */
function assertNever(kind: never): never {
  throw new Error(`unhandled channel kind: ${JSON.stringify(kind)}`);
}
