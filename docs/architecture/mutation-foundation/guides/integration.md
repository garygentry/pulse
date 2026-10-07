# Integration Guide

This guide covers the changes you are most likely to make to the write path:
- adding a mutation;
- gating a new UI affordance;
- showing pending state;
- extending proposals;
- running the proposal workflow end to end;
- testing each layer.

For deployment and operations, see the operator guide [Write path](../../../operator/write-path.md).

## Add a Mutation

A new write is one `MutationDefinition` plus registration. The dispatcher already enforces identity, origin, capability, body bounds, idempotency and audit for you. Do not repeat those checks in the handler.

### 1. Declare the wire types

Add body and result types to `apps/web/src/shared/mutations.ts`. This file is bundled into the browser, so it may import packages as types only.

```typescript
export interface SnoozeBody {
  readonly fingerprint: string;
  readonly minutes: number;
}
export interface SnoozeResult {
  readonly fingerprint: string;
  readonly until: string;
}
```

If the handler can fail in a new way, add the reason to `MutationReason` and `MUTATION_REASONS`, give it a `FAILED_POLICY` entry in `apps/web/src/server/mutations/refusal.ts`, and add client copy to `REASON_TEXT` in `apps/web/src/client/mutations/client.ts`.

### 2. Write the definition

```typescript
// apps/web/src/server/mutations/handlers/snooze.ts
import { z } from "zod";
import type { MutationDefinition } from "../registry.js";
import type { SnoozeBody, SnoozeResult } from "../../../shared/mutations.js";

const snoozeBodySchema = z
  .object({
    fingerprint: z.string().min(1).max(128),
    minutes: z.number().int().min(5).max(240),
  })
  .strict(); // unknown keys must be refused

export function snoozeMutation(deps: { now: () => Date }): MutationDefinition<SnoozeBody, SnoozeResult> {
  return {
    method: "POST",
    path: "/api/mutations/snoozes",
    capability: "ack",           // reuse an existing capability, or add one (see below)
    action: "ack.set",           // audit action; add a new MutationAction for a new verb
    body: snoozeBodySchema,
    auditTarget: (b) => `alert:${b.fingerprint}`,
    auditDetails: (b) => ({ minutes: b.minutes }),
    async handler(body, ctx, _actor, meta) {
      const firing = (ctx.cycle?.alerts.value.alerts ?? []).some((a) => a.fingerprint === body.fingerprint);
      if (!firing) {
        return { outcome: "failed", status: 404, code: "TARGET_NOT_FOUND", reason: "alert-not-firing" };
      }
      const until = new Date(meta.now.getTime() + body.minutes * 60_000).toISOString();
      return { outcome: "succeeded", status: 200, result: { fingerprint: body.fingerprint, until } };
    },
  };
}
```

Rules the dispatcher relies on:

- **Pure `validate`.** Put clock- or context-dependent checks that zod cannot express in `validate`. It runs before the audit record, and a failure is an unaudited `invalid-body`. Keep it free of side effects.
- **Target checks in the handler.** Report "target missing" and "target stale" from `handler` as `failed` outcomes, so that they are audited and replayable.
- **Use `meta`.** Take the time from `meta.now` and the request id from `meta.requestId`.
- **Never throw on purpose.** A throw becomes a `failed internal`.
- **Wrap store writes.** Use `writeFileAtomic`, and call `writePath.markFailed(store, "write-failed")` when a real write fails, so the capability goes dark until a later probe passes.
- **Small audit details.** They must be scalars. Free-text keys other than `rationale`, `note`, `matchers` and `silenceId` are held to the writer's 256-byte value limit. To chunk a new free-text key, add it to `CHUNKED_DETAIL_KEYS` in `audit.ts`.

### 3. Register it

Append the definition in `createMutations` in `apps/web/src/server/mutations/definitions.ts`. Registration throws on a duplicate path, a method other than `POST`, or a path outside `/api/mutations/`.

### 4. Add a capability (only if needed)

A new capability touches every layer:

- **Session.** Add it to `SessionCapabilities` in `packages/web-data/src/wire/session.ts`. Additive fields are allowed there.
- **Server.** Add it to `CAPABILITY_NAMES` and `CAPABILITY_STORES` in `capabilities.ts`, listing every store whose failure should turn it off. `audit` should always be one of them.
- **Health.** Extend the `/healthz` `writePath` block in `capabilitiesForHealth` and in `apps/web/src/shared/snapshot.ts`.
- **Client.** `ClientCapability` derives from the wire type, so `canAct(store, "newCap")` type-checks once the wire type changes.

## Gate a UI Affordance

The client rule is: **no capability, no control**. Apply `canAct` in a hook-free gate, then render the stateful inner component only when it returns true. Because `canAct` reads store signals, the component that calls the gate must call `useSignals()` first (see [Web UI](../../ui.md#pulse-deltas-from-deck)); otherwise it never re-renders when the session changes.

```tsx
import { useState, type ReactElement } from "react";
import { useSignals } from "@preact/signals-react/runtime";
import { canAct } from "../../mutations/gating.js";
import { ActionButton, useLazyDialog } from "../../mutations/ActionButton.js";
import { PendingMarker } from "../../mutations/StateBadge.js";
import { REASON_TEXT } from "../../mutations/client.js";
import type { SnoozeDialogProps } from "../../mutations/dialogs/SnoozeDialog.js"; // type-only: keeps the chunk lazy
import type { AppStore } from "../../store/types.js";

const snoozeActionGate = (p: { store: AppStore; fingerprint: string }): ReactElement | null =>
  canAct(p.store, "ack") ? <SnoozeActionInner {...p} /> : null;

export function SnoozeAction(p: { store: AppStore; fingerprint: string }): ReactElement | null {
  useSignals(); // canAct reads signals
  return snoozeActionGate(p);
}

function SnoozeActionInner(p: { store: AppStore; fingerprint: string }): ReactElement {
  const [open, setOpen] = useState(false);
  const lazy = useLazyDialog<SnoozeDialogProps>(() =>
    import("../../mutations/dialogs/SnoozeDialog.js").then((m) => m.default));
  const D = lazy.Comp;
  return (
    <div className="inline-flex flex-wrap items-center gap-2">
      <ActionButton icon="clock" loading={lazy.loading} onClick={() => { lazy.open(); setOpen(true); }}>
        Snooze…
      </ActionButton>
      <PendingMarker target={{ kind: "alert", fingerprint: p.fingerprint }} />
      {lazy.error ? <p className="font-medium text-foreground">{REASON_TEXT.network}</p> : null}
      {D !== null && open ? (
        <D store={p.store} fingerprint={p.fingerprint} open={open} onClose={() => setOpen(false)} onDone={() => undefined} />
      ) : null}
    </div>
  );
}
```

- **Session loading.** Make sure something on the page calls `ensureSession(store)` in a mount effect. `ActionSlots`, `ExpireButton` and the estate declared-facts panel already do this.
- **Lazy dialogs.** Put dialogs under `apps/web/src/client/mutations/dialogs/` and load them with `useLazyDialog`; `mutations-client-imports.test.ts` keeps them behind `import()`. Build each dialog on `MutationDialogFrame` (`mutations/dialog-frame.tsx`, over the `@/ui` `Dialog`), which restores focus to the trigger on close. Style with Tailwind token classes; there is no mutations stylesheet.
- **Type-only core imports.** Import `@pulse/core/proposals` or zod-backed modules into client code **as types only**. If you need a validator on the client, mirror it locally and add a test that pins the mirror to the core original, following `ProposeDialog.tsx`. `mutations-client-imports.test.ts` and the build budget will fail otherwise.
- **Read-only displays stay ungated.** Displays such as `AckInfo` and the acked badges must render in wallboard density too. Only gate controls that act.

## Submit from a Dialog

Follow the existing dialogs:
- one idempotency key per logical action, held in a `useRef`;
- an `inFlight` guard against double submission;
- refresh the session after refusals that suggest the capability has changed.

```typescript
import {
  postMutation, newIdempotencyKey, MutationClientError, STORED_FAILURE_REASONS, failureText,
} from "../client.js";
import { SESSION_REFRESH_REASONS, refreshSession } from "../session.js";
import { pendingTracker, predicates } from "../pending.js";
import type { SetAckResult } from "../../../shared/mutations.js";

const key = useRef(newIdempotencyKey());
const inFlight = useRef(false);

async function submit(fingerprint: string, note: string) {
  if (inFlight.current) return;
  inFlight.current = true;
  try {
    const res = await postMutation<SetAckResult>("/api/mutations/acks", { fingerprint, note }, key.current);
    pendingTracker.add({
      target: { kind: "alert", fingerprint },
      reflected: predicates.ackSet(fingerprint, res.result.at),
      since: performance.now(),
    });
    onDone(res.result);
  } catch (err) {
    if (!(err instanceof MutationClientError)) throw err;
    if (STORED_FAILURE_REASONS.has(err.reason)) key.current = newIdempotencyKey(); // new attempt, new key
    if (SESSION_REFRESH_REASONS.has(err.reason)) void refreshSession(store);
    setError(failureText(err));
  } finally {
    inFlight.current = false;
  }
}
```

After a `network` error, keep the key. If the first request actually landed, the retry replays it instead of acting twice.

## Show Pending State

Register a predicate that becomes true once live data reflects the change, and render `<PendingMarker target={...} />` next to the affected row:

- Use the existing `predicates`, or write your own `(payload: AlertsPayload) => boolean`.
- Make sure `installPendingObserver(store)` has run. `ActionSlots` and `ExpireButton` install it.
- After 30 s the marker shows a dismissable "not yet reflected" badge. Never mutate `store.alerts` optimistically.

## Extend Proposable Fields

Adding a field is a cross-cutting change. The field must be declared in the estate schema and must be settable from an overlay.

1. **Core.** Add the field to `ProposableField` and `PROPOSABLE_FIELDS` in `packages/core/src/proposals/`, with `yamlKey`, `kinds`, `hostClasses`, `nullable` and `valueKind`. Teach `readCoreValue` how to read it.
2. **Web.** Teach `readProposableValue` in `apps/web/src/server/mutations/estate-values.ts` to read the same value from the rendered model. `proposals-parity.test.ts` must stay green.
3. **Client.** Add it to `CLIENT_PROPOSABLE_FIELDS` and to the client validators in `ProposeDialog.tsx`, and extend the mirror tests.
4. **CLI.** No changes are needed unless the value kind is new. `applyChangesToOverlay` writes through `yamlKey`.

## Run the Proposal Workflow

In the web app, with `proposeEstateEdit` true, open an estate host or service page and choose **Propose edit…**. The proposal lands in the proposals directory, and the entity's **Proposals** list shows it as pending.

In the estate repository:

```bash
export PULSE_PROPOSAL_SECRET=...                    # same value the web app uses
export PULSE_PROPOSALS_DIR=/srv/pulse/data/proposals # or --proposals-dir / pulse.config.yaml

pulse proposals list --state pending
pulse proposals show p-20260930T120000Z-1a2b3c4d
pulse proposals apply p-20260930T120000Z-1a2b3c4d    # commits locally, never pushes
git show HEAD
git push

pulse proposals reject p-20260930T121500Z-9f8e7d6c --reason "Heartbeat stays on for this host"
```

What `apply` needs:

- **The estate repo.** The current directory, or the one given by the estate option, must be inside a git repository.
- **A clean tree.** Nothing staged, and no dirty tracked files under the estate or output directories.
- **Output inside the repo.** The rendered output directory must be inside the same repository, because the commit includes the re-rendered files.
- **An unambiguous overlay.** If the entity is not already in an overlay and more than one overlay file exists, pass `--overlay <file>`.

Proposals directory access and secret handling:
- If the web app's data volume is not mounted where you run the CLI, copy the proposals directory back and forth.
- Only the CLI writes the result sidecar. Copy it back for the web app to show the decision.
- Anyone who can write the proposals directory can decide proposals. Keep its permissions tight.
- Only the CLI's verification protects against forged files, so keep the secret out of the proposals directory and out of the repository.

## Testing

| Layer | Where | Notes |
|---|---|---|
| Registry, dispatcher, guards, refusals | `apps/web/tests/mutations-{registry,dispatch,guards,envelope}.test.ts` | Build a dispatcher with fakes from `mutations-fixtures.ts` |
| Idempotency, audit encoding | `mutations-idempotency.test.ts`, `mutations-audit-details.test.ts` | Inject `now` |
| Write path and bootstrap | `mutations-write-path.test.ts`, `mutations-bootstrap.test.ts`, `mutations-config.test.ts` | The `fs` seam in `WritePathDeps` injects failures |
| Handlers and stores | `mutations-{silences,acks,ack-store,proposals,atomic-file}.test.ts` | Fake `AlertmanagerWriteClient`, temp directories |
| Darkness | `mutation-darkness.test.ts`, `session.test.ts` | `none` mode means no write path and all capabilities false |
| Client | `mutations-{client,session,gating,pending}.test.ts` and `mutations-*-dialog.test.ts` | Outer action wrappers have no hooks and can be called as plain functions |
| Bundle rules | `mutations-client-imports.test.ts`, the build budget tests | No core or zod code in client chunks |
| Core proposals | `packages/core/tests/proposals-{schema,canonical,sign}.test.ts` | |
| Web and core parity | `apps/web/tests/proposals-parity.test.ts` | `readProposableValue` against `readCoreValue` |
| CLI | `apps/cli/tests/proposals.test.ts` | Builds a git estate in a temp directory |
| End to end | `apps/web/tests/mutations-dev-loop.test.ts` | Opt-in: `PULSE_DEV_LOOP=1` plus a real `PULSE_ALERTMANAGER_URL` |

Run the standard gates:

```bash
bun run typecheck
bun test
bun run smoke
```

When you test a dispatcher-level behavior, assert on `details.reason`, the status code and the audit records written. Do not assert on `message`, which is catalog text.

## Troubleshooting

### No action buttons appear

Check each of these in turn:
- `GET /api/session` should show `authMode: "proxy-header"` and the capability `true`.
- If the capability is `false`, `/healthz` → `writePath.<cap>.reason` names the cause. `auth-mode-none` means the server runs in `none` mode.
- Wallboard density and `?kiosk=1` hide every action by design.

### Every mutation returns `403 untrusted-identity`

The request did not arrive from a peer in `PULSE_WEB_TRUSTED_PROXIES`, or the proxy did not set `PULSE_WEB_AUTH_HEADER`. Requests that bypass the proxy are anonymous.

### Every mutation returns `403 cross-origin`

The browser sent `Sec-Fetch-Site` with a value other than `same-origin`, which happens when the UI is served from a different origin than the API. Or `Sec-Fetch-Site` was absent and the proxy rewrote `Host`. Serve the UI and API from one origin and preserve `Host`.

### `503 write-path-degraded` or `audit-unavailable`

A store is failing. `/healthz` and `pulse_web_write_path_status` show which one. A `write-failed` mark clears once a probe that started after the failure passes; probes run on the 60 s slow cycle. A `corrupt` or `unwritable` ack store at startup is sticky: fix `acks.json` and restart.

### `409 idempotency-conflict`

The client reused a key with a different body. Mint a new key per logical action and after any stored failure.

### An ack disappeared

The alert stopped being listed by Alertmanager during a successful fetch, so auto-clear removed the ack. `pulse_web_ack_auto_clears_total` and the `ack_auto_cleared` log confirm it. Silenced and inhibited alerts keep their acks.

### `pulse proposals apply` refuses with `PROPOSAL_STALE`

The estate changed after the proposal was made: some `seen` value no longer matches. Reject the proposal with a reason and ask for a fresh one.

### `apply` exits 2 after committing

The sidecar write failed after the commit. Re-run the same `apply`: crash recovery finds the `Proposal-Id:` trailer and completes the sidecar without committing again.

### Proposals list shows "could not be verified"

One or more files in the proposals directory failed verification: a bad signature, a symlink, an oversize file or an id mismatch. The usual cause is a secret mismatch between the web app and the file's author. Run `pulse proposals list`, which names each invalid file and its reason.
