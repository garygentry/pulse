---
title: Generated estate + overlay
description: Machine-generate an estate skeleton deterministically, own the monitoring policy by hand in an overlay layer, and let the loader deep-merge the two — with pulse render --check as the drift gate.
slug: generated-estate
---

# Generated estate + overlay

Some estates are big enough that you want a machine to enumerate the hosts and services —
from an inventory API, a hypervisor, a Terraform state — rather than hand-typing every one.
But the *monitoring policy* (which host gets cAdvisor, the scrape cadence, deep-health
probes, backup thresholds, channels) is a human judgement you want to own and review.

Pulse supports exactly this split with **layers**. A source file declares an optional
top-level `layer:` and the loader merges the layers by identity:

- **`layer: base`** — the machine-generated skeleton. Regenerate it deterministically as
  often as you like; it carries only the intrinsic facts a generator can know.
- **`layer: overlay`** — the hand-authored refinements. It *refines the base by identity*:
  where a base and an overlay declare the same host/service/channel `name` (or the `estate`
  block), the two are **deep-merged with the overlay winning**.

`layer:` is optional. **A repo with no markers behaves exactly as before** — every source is
implicitly `base`, and a duplicate identity is still a hard error. Layers are opt-in.

## The workflow

```text
1. generate  →  estate/00-skeleton.base.yaml     (layer: base — machine-written, regenerable)
2. own       →  estate/10-monitoring.overlay.yaml (layer: overlay — hand-authored policy)
3. merge     →  the loader deep-merges base + overlay by identity
4. gate      →  pulse render --check  (exit 0 = the committed tree still equals a fresh render)
```

Both files live in the **same estate directory** — the loader scans the directory, reads
each file's `layer:`, and merges. Filenames still carry no meaning; the `layer:` key inside
the file is what selects the layer (a `.base`/`.overlay` suffix is just a helpful convention).

## Worked example

**`estate/00-skeleton.base.yaml`** — regenerate this file from your source of truth. It is
deterministic output: same inputs → byte-identical file, so it never spuriously drifts.

```yaml
layer: base
estate:
  schema_version: 1
  name: overlay-ref
  domains: [overlay.example]
  dns_resolver: 10.0.0.53    # optional; internal resolver for split-horizon domains
  timezone: America/Chicago
  deadman_hook: ${DEADMAN_URL}
hosts:
  - name: app-01
    collection_class: managed-linux
    delivery_form: compose
    addresses: [10.0.0.4]      # intrinsic facts the generator knows
    exporter_ports: [9100]
```

When `dns_resolver` is set, every generated `dns:<domain>` Gatus check queries that server.
Omit it to retain the public `1.1.1.1` default. This is especially important for internal or
split-horizon domains that are intentionally unavailable through public DNS.

**`estate/10-monitoring.overlay.yaml`** — you own this by hand. It refines `app-01` by
identity and adds monitoring-only inventory the generator does not know about:

```yaml
layer: overlay
hosts:
  - name: app-01               # same identity → deep-merged onto the base host
    collection_class: managed-linux
    cadvisor: true             # overlay scalar wins
    exporter_ports: [9100, 9256]   # overlay array REPLACES the base array whole
    scrape_interval_class: fast    # overlay-only field is added
channels:                      # overlay adds inventory absent from the base
  - name: ops-chat
    kind: chat
    credential: ${CHAT_WEBHOOK_URL}
```

The merged `app-01` the model sees:

```yaml
name: app-01
collection_class: managed-linux
delivery_form: compose         # base-only fact — retained
addresses: [10.0.0.4]          # base-only fact — retained
cadvisor: true                 # overlay won
exporter_ports: [9100, 9256]   # overlay array won whole
scrape_interval_class: fast    # overlay added
```

## Merge rules

| Situation | Result |
|-----------|--------|
| Same identity in **base** and **overlay** | Deep-merge; **overlay wins** every conflict |
| A conflicting **scalar** (`cadvisor`, `delivery_form`, …) | Overlay value wins |
| A conflicting **nested object** (e.g. `deep_health`) | Merged recursively, overlay leaves win |
| A conflicting **array** (`addresses`, `exporter_ports`) | **Overlay array replaces the base array whole** — never element-merged |
| A field only one layer sets | Kept as-is |
| An identity only the overlay declares | Added (overlays may introduce new inventory) |
| The `estate` block in both layers | Deep-merged the same way (overlay wins) |
| **Two `base`** (or two `overlay`) files, same identity | Still a hard `duplicate_identity` (or `duplicate_estate`) error naming both — overlays refine, they do not silence a genuine same-layer duplicate |
| An unrecognized `layer:` value | An `invalid_layer` error — use `base`, `overlay`, or omit it |

**Overlays refine; they do not re-class.** Changing a host's `collection_class` in the
overlay leaves the base arm's now-foreign fields in place, which strict shape validation
rejects — declare a host's class in exactly one layer.

**Arrays replace, so the overlay fully owns any array it restates.** To *add* an exporter
port you must list the full set you want (`[9100, 9256]`), not just the new one — this is
what lets an overlay also *remove* a base entry.

## Determinism and the drift gate

The merge is deterministic: the overlay always wins regardless of file read order, and
merged elements keep first-appearance (sorted-read) order. So a regenerated base + an
unchanged overlay always produce the same model, and the same rendered tree.

That makes [`pulse render --check`](/bootstrap/) your gate. The recommended loop:

```bash
# after regenerating the base skeleton and/or editing the overlay:
pulse render                 # write the rendered tree
git diff rendered/           # review what actually changed
pulse render --check         # exit 0 = the committed tree equals a fresh render (no drift)
```

Commit the base, the overlay, and the rendered tree together. A reviewer reads the overlay
diff to see the *policy* change and the `rendered/` diff to see its *effect* — the generated
base is regenerable noise they can trust the `--check` gate to police.

## Where to go next

- **Secrets in a channel/credential** → [secret recipes](/secret-recipes/).
- **Render + commit the tree** → the [bootstrap runbook](/bootstrap/).
- **Back to onboarding** → [getting started](/getting-started/).
