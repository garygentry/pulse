# Pulse example estates

This directory ships **two** self-contained Pulse estate fixtures. Each is a complete
CLI workspace — a `pulse.config.yaml`, an `estate/estate.yaml` declaration, and a
committed `rendered/` golden tree — with no `package.json` (these are *data*, not a
workspace).

| Fixture | What it is | Highlights |
|---------|------------|------------|
| [`minimal/`](./minimal/) | The smallest valid estate — the quickstart/onboarding path. | One `managed-linux` host, a plain-URL `deadman_hook`, no services/channels/suppressions. Renders 5 files (no `prober/`). |
| [`reference/`](./reference/) | The completeness estate — exercises every schema surface. | All five collection classes, a `deep_health` service, a `backup_freshness` service, all channel kinds, all three suppression classes, ≥2 domains, an internal `dns_resolver`, retention, and both `${ENV}` / `op://` secret grammars. |

Both fixtures use **fictional** names and RFC1918 addresses only (`harbor-*`,
`nimbus.example`, `aurora.example`, `lab.example`, `10.x`). Every credential is a
`${ENV}` or `op://` reference — no secret value appears in any fixture or rendered file.

## Using a fixture (cwd-per-fixture CLI loop)

The CLI resolves `estateDir` and `outputRoot` **relative to its working directory**
(`apps/cli/src/config.ts`), and `estateDir` is *not* flag-overridable. So always run the
CLI **with the fixture directory as the current working directory** — the fixture's own
`pulse.config.yaml` is then auto-discovered from cwd. Never pass `--config` from the repo
root.

```sh
# Pick a fixture and run every verb from inside it:
cd examples/reference               # or examples/minimal

bun run ../../apps/cli/src/index.ts validate       # schema-validate the estate (exit 0 = clean)
bun run ../../apps/cli/src/index.ts coverage       # every host monitored or suppressed (no gaps)
bun run ../../apps/cli/src/index.ts render         # (re)write rendered/ in place
bun run ../../apps/cli/src/index.ts render --check  # byte-for-byte diff vs the committed rendered/
```

The CLI is invoked **from source** (`bun run ../../apps/cli/src/index.ts …`), never a
released binary. Verbs branch on the `0` / `1` / `2` exit contract: `0` = success, `1` =
findings/drift, `2` = tool fault.

## The committed `rendered/` trees are the canonical golden corpus (D7)

Each fixture's `rendered/` directory is the **committed golden tree** — the exact output
`pulse render` produces from that fixture's `estate.yaml`. The `reference/` fixture's tree
is the single canonical golden target for the whole deploy-toolkit epic: downstream
packages, tests, and runbooks assert against it.

- These files are **generated, never hand-edited.** The renderer is pure and
  deterministic (no clock/pid/hostname/random, canonical key order, single trailing
  newline), so a fresh render reproduces the committed tree byte-for-byte.
- `render --check` is the byte-for-byte gate: it re-renders in memory and diffs against
  the on-disk set enumerated in `.rendered-manifest.json`. Any drift exits `1`.
- To **intentionally** regenerate the goldens (after editing an `estate.yaml` or absorbing
  an upstream renderer change), run `bun run golden:update` from the repo root, then review
  `git diff examples/**/rendered/` before committing. Regenerating a golden is a
  deliberate, reviewed act — never automatic.

If `render --check` reports drift you did not intend, someone hand-edited a rendered file
or an upstream renderer change landed without a golden refresh — fix it by re-running
`bun run golden:update`.
