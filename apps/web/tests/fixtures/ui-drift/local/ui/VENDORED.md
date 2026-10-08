# Fixture

<!-- ui-drift:begin source (generated from VENDORED.json by `bun run ui:drift --record`; do not edit) -->
Pinned upstream: file:///unused at `f972b46` (fixture pin). Vendored files: 4, 1 of them with pulse divergences. Upstream files in scope that are deliberately not vendored: 1.
<!-- ui-drift:end source -->

<!-- ui-drift:begin mapping (generated from VENDORED.json by `bun run ui:drift --record`; do not edit) -->
| Pulse path | Deck path | Divergence notes |
|---|---|---|
| `ui/same.txt` | `lib/same.txt` | None |
| `ui/diverged.txt` | `lib/diverged.txt` | `pulse-text` |
| `ui/changed.txt` | `lib/changed.txt` | None |
| `ui/removed.txt` | `lib/removed.txt` | None |

Not vendored:

- `lib/skip.txt`: Deck only.
<!-- ui-drift:end mapping -->

<!-- ui-drift:begin notes (generated from VENDORED.json by `bun run ui:drift --record`; do not edit) -->
- **`pulse-text`** (`diverged.txt`): Pulse rewords the line.
<!-- ui-drift:end notes -->

<!-- ui-drift:begin pulse-only (generated from VENDORED.json by `bun run ui:drift --record`; do not edit) -->
| Pulse path | Source | Notes |
|---|---|---|
| `ui/extra.txt` | pulse | Pulse only. |
<!-- ui-drift:end pulse-only -->
