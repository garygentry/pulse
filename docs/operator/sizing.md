---
title: Sizing
description: Disk-sizing model, tier table keyed to active series and retention, and a worked calculation from the reference estate.
slug: sizing
---

# Sizing

This is documentation only — no calculator tool ships. It gives you (a) a tier table keyed
to **both** estate size and retention window, (b) the disk formula anchored on
VictoriaMetrics retention, and (c) a worked calculation from the committed reference estate.
All figures are planning estimates, not guarantees.

## The disk-sizing model

Disk is dominated by the VictoriaMetrics TSDB, whose retention is set by
`PULSE_VM_RETENTION` (in months; the stack passes
`-retentionPeriod=${PULSE_VM_RETENTION:-6}`). The planning formula:

```
vm_disk_bytes ≈ active_series
              × (retention_months × 30 × 86400 / scrape_interval_seconds)   # samples/series
              × bytes_per_sample
              × overhead_factor
```

Rules of thumb (estimates, not guarantees):

| Symbol | Planning value | Basis |
|--------|----------------|-------|
| `bytes_per_sample` | **0.7 bytes** | VictoriaMetrics compressed on-disk sample size, typical steady state |
| `scrape_interval_seconds` | **15** | stack default scrape cadence |
| `overhead_factor` | **1.5×** | indexdb + in-flight parts + free-space headroom |

Because retention is a linear multiplier, **doubling `PULSE_VM_RETENTION` doubles the VM
data volume** — it is the single most important lever you control. Grafana state
(`grafana-data`) is small and effectively constant (dashboards + a small sqlite DB), so it
is budgeted flat per tier and left out of the formula.

## Sizing tiers

Tiers map estate size **and** retention window to disk / RAM / CPU. "Active series" is the
steady-state series count — observe it via VictoriaMetrics' `sum(vm_rows)` or scrape `up`
cardinality once the stack is running; host counts are only a rough proxy.

| Tier | Estate (rough) | Active series | Retention | vCPU | RAM | Disk (SSD) |
|------|----------------|---------------|-----------|------|-----|------------|
| **Small** (homelab) | ≤ ~10 hosts | ≤ ~25k | ≤ 6 mo | 2 | 4 GiB | 25–50 GiB |
| **Medium** | ~10–50 hosts | ~25k–100k | 6–12 mo | 4 | 8–16 GiB | 100–250 GiB |
| **Large** | ~50–200 hosts | ~100k–500k | 12–24 mo | 8 | 32 GiB | 500 GiB–1 TiB |

Notes:

- **Disk grows with retention.** A Small estate held for 24 months lands in the Medium
  disk band even though its series count / CPU / RAM stay Small. Recompute disk with the
  formula above whenever `PULSE_VM_RETENTION` changes — the tier's disk column assumes the
  retention shown in the same row.
- **RAM tracks active series** (VictoriaMetrics' in-memory index + caches) plus the fixed
  footprint of Grafana / Alertmanager / vmalert / gatus / exporters (~1.5–2 GiB combined at
  Small).
- **cadvisor materially inflates series** per `managed-linux` host (per-container
  cardinality) — an estate that opts many hosts into cadvisor sizes up one band.
- **Use SSD/NVMe, not spinning disk** — VictoriaMetrics' write path assumes low-latency
  random I/O.

## Worked calculation — the reference estate

This grounds the tiers in the committed **reference** fixture (`examples/reference/`).
Scenario: the reference estate at its default retention (`PULSE_VM_RETENTION=6`),
15-second scrape.

Take its steady-state active-series count as **~12,000**. This is a *representative*
figure: the number you pin for a real estate MUST be the count your render actually
produces, measured with VictoriaMetrics' `sum(vm_rows)` during the bootstrap smoke — not a
guess. The 12,000 figure is used here to demonstrate the arithmetic:

```
samples_per_series = 6 × 30 × 86400 / 15
                   = 15,552,000 / 15
                   = 1,036,800 samples/series over 6 months

raw_bytes = 12,000 × 1,036,800 × 0.7
          = 8.71 × 10^9 bytes
          ≈ 8.1 GiB

vm_disk ≈ raw_bytes × 1.5 (overhead)
        ≈ 12.2 GiB
```

**Conclusion:** at 6-month retention the reference estate needs **~12 GiB** of VM data —
comfortably inside the **Small** tier's 25–50 GiB band. The headroom absorbs cardinality
growth and the 1.5× overhead already folded into the estimate.

### The retention lever

Hold everything else constant and vary only `PULSE_VM_RETENTION`:

```
Same estate, PULSE_VM_RETENTION=6   →  ~12 GiB  (Small, low in the band)
Same estate, PULSE_VM_RETENTION=12  →  ~24 GiB  (still Small, near the top of the band)
Same estate, PULSE_VM_RETENTION=24  →  ~49 GiB  (spills into Medium disk sizing)
```

Retention is linear: each doubling of the window doubles the VM data volume. Choose the
shortest retention that satisfies your audit/troubleshooting needs, and re-run the formula
before you raise it.

## Where to go next

- **Wire credentials before bring-up** → [secret recipes](/secret-recipes/).
- **Stand up the stack** → the [bootstrap runbook](/bootstrap/).
- **Understand the running system** → [runtime posture](/runtime-posture/).
