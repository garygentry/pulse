# Contributing

Run `bun run typecheck` and `bun test` before opening a pull request. The rules below apply to every change.

## Public-safe placeholders

This repository is public. Content under `contract/` and `apps/ios/` must not reveal a real deployment: no real
hostnames, no real IP addresses and no home-directory paths. The same applies to specs under `specs/ios/` before
they are copied between machines. `bun test` enforces the rule for `contract/` and `apps/ios/`, and
`bun run lint:public-safe` checks those trees plus your local `specs/ios/`.

### The allowlist, and why

| Kind | Allowed values | Reference |
|---|---|---|
| Hostnames | `example.com`, `example.net`, `example.org` and any subdomain; any name under `.example`, `.test`, `.invalid` or `.localhost`; `localhost` | RFC 2606, RFC 6761 |
| IPv4 | `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` | RFC 5737 |
| IPv6 | `2001:db8::/32` | RFC 3849 |
| Loopback and unspecified | `127.0.0.0/8`, `::1`, `0.0.0.0`, `::` | RFC 1122, RFC 4291 |

These values are reserved, so they can never belong to anyone's real deployment, and text that uses them cannot
leak one. Loopback and unspecified addresses never identify a deployment, and the connect-link rules need them.
Private ranges (RFC 1918 IPv4, unique-local and link-local IPv6) are **not** allowed: they are real addresses on
someone's network. Describe them in words ("an RFC 1918 address") instead.

### Choosing a placeholder

- The Pulse server: `pulse.example.com` (`https://pulse.example.com`). Other services: `grafana.example.net`,
  `prometheus.example.org`. Several hosts: `web-01.example.com`, `web-02.example.com`.
- Addresses: `192.0.2.10`, `198.51.100.7`, `203.0.113.9`; IPv6 `2001:db8::10`.
- Email: `operator@example.com`.
- Paths: `~/…` or `$HOME/…`. When an absolute path matters, use `/home/USER/…` or `/Users/USER/…`. The segments
  `USER`, `NAME`, `<name>` and `{name}` count as placeholders.
- Public software and services may be named as they are (see below).

### What the check recognises

- **Hostnames.** A dotted name fails unless allowlisted when it appears:
  - in a URL (`scheme://name`, also percent-encoded),
  - as `name:port`,
  - after `@`,
  - or on its own when its last label is a common public TLD (`.com`, `.net`, `.org`, `.io`, …) or a private-use
    suffix (`.lan`, `.local`, `.home`, `.internal`, `.corp`, `.intranet`, `.localdomain`, `.home.arpa`).
- **IP addresses.** Four-part decimal IPv4, and IPv6 literals including IPv4-mapped and zoned forms, fail outside
  the allowlist.
- **Home paths.** `/home/<name>/`, `/Users/<name>/`, `C:\Users\<name>\` and `~<name>/` fail. `~/` and `$HOME` are
  fine.
- **Never flagged:**
  - file names (`overview.ts`, `README.md`, `docker-compose.yml`),
  - version numbers (`1.2.3`, `v1.2.3.4`, `1.2.3.4-rc1`),
  - package and module ids (`@scope/name`, reverse-DNS bundle ids such as `com.example.pulse`),
  - code member access (`ctx.config`, `user.id`),
  - timestamps and times (`2026-01-01T10:30:00Z`, `10:30:00`) and event-stream ids,
  - the `pulse://connect` link scheme,
  - these public services: `github.com`, `apple.com`, `developer.apple.com`, `api.push.apple.com`,
    `api.sandbox.push.apple.com`, `tailscale.com`, `grafana.com`, `gcr.io`, `ghcr.io`, `docker.io`.
- **Not covered:**
  - single-word host names (`nas`),
  - unusual suffixes in plain prose,
  - values split or encoded to dodge the check,
  - non-decimal IPv4 forms,
  - files outside `contract/`, `apps/ios/` and `specs/ios/`.

  Use the local deny list below for your own names.

### Exceptions

When the check flags something that is not a real host, address or path (a false positive), add an entry to
`public-safe-exceptions.json`:

```json
{ "formatVersion": 1, "exceptions": [
  { "value": "<exact flagged text>", "path": "contract/CONTRACT.md", "reason": "why this is not deployment data" }
] }
```

- `value` must be the exact text as flagged. `path` is a repo-relative path or a glob: `*` matches within a
  directory, `**` matches any number of directories, and `?` matches one character. `reason` is required.
- An exception that no longer matches anything fails the check as `stale-exception`. Remove it.
- The exceptions file is public. Never use it to excuse a real value; replace the value with a placeholder.

### Your own names: `.public-safe.local`

Create `.public-safe.local` in the repo root (it is gitignored) with one term per line, for example your server and
domain names. Lines starting with `#` are comments. Terms of at least 3 characters fail the check wherever they
appear as a whole word, case-insensitively, including inside hostnames joined by `.`, `-` or `_`.

### Running the check and reading its output

`bun run lint:public-safe` (add `--tracked-only` to skip `specs/ios/`). Each failure prints
`path:line:col rule masked → suggestion`, for example `contract/CONTRACT.md:12:5 ip-address 10… → 192.0.2.10`. The
offending value is masked so the output does not repeat it. Exit codes: 0 pass, 1 violations, 2 configuration error.
