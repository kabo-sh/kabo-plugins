# kabo-plugins

The official **Kabo** plugin marketplace — the client for the creator-focused Skill distribution platform.

Kabo lets you search, download, and execute creator research skills inside Claude Code and Codex: YouTube and Instagram public-evidence collection, outlier and viral breakdowns, channel benchmarking, and emerging-creator discovery. Every skill is signed and distributed by the platform, and the client verifies the signature locally before executing it.

Creator research data is fetched by Kabo's servers, so there are no provider keys to configure. Usage telemetry is limited to event-level metadata — which skill ran and whether it succeeded; no prompt, tool, or skill-output content is collected.

## Install

One command, either host:

```bash
curl -fsSL https://raw.githubusercontent.com/kabo-sh/kabo-plugins/main/install.sh | bash
```

It reports which hosts it found on this machine and lets you pick **one or both** — Claude Code and Codex install in the same run. It never installs a host for you, never uses `sudo`, and never touches a credential: signing in is a separate step it prints at the end.

If you would rather not pipe a script into a shell unseen:

```bash
curl -fsSL https://raw.githubusercontent.com/kabo-sh/kabo-plugins/main/install.sh | bash -s -- --dry-run
curl -fsSL https://raw.githubusercontent.com/kabo-sh/kabo-plugins/main/install.sh | bash -s -- --client claude,codex
```

Already cloned this repo? Skip the network: `./install.sh --repo /path/to/kabo-plugins`.

The rest of this section is the same thing by hand.

### Claude Code

**Requires Claude Code 2.1.195 or newer.** The bundled MCP server supplies its own credential through a `headersHelper`, and `${CLAUDE_PLUGIN_ROOT}` inside that setting is only interpolated from 2.1.195 on. An older host runs the literal path, the helper never starts, and every request fails with a 401 that has no way out of it — a server configured with a `headersHelper` does not fall back to host OAuth. Upgrade before installing.

```bash
claude plugin marketplace add kabo-sh/kabo-plugins
claude plugin install kabo-alpha@kabo-plugins
claude plugin enable kabo-alpha
```

The `enable` step is not optional: `claude plugin install` leaves the plugin **disabled by default**, and a disabled plugin looks exactly like one that installed cleanly and does nothing.

Inside a session, `/plugin marketplace add kabo-sh/kabo-plugins` does the same thing as the first line.

### Codex

Requires Node.js 20 or later, and a Codex build that has the `codex plugin` subcommand (`codex plugin --help` answers). If that subcommand is missing, the host has no plugin install surface at all.

```bash
codex plugin marketplace add kabo-sh/kabo-plugins
codex plugin add kabo-alpha@kabo-plugins-codex
```

Two things differ from the Claude side, and neither is cosmetic:

- **The marketplace name is `kabo-plugins-codex`, not `kabo-plugins`.** The two hosts read two different manifests (`.agents/plugins/marketplace.json` and `.claude-plugin/marketplace.json`), so the names have to be distinct even though both publish the same plugin name, `kabo-alpha`.
- **There is no `enable` step, but there is a trust step.** Installing a plugin does not trust its hooks. Review [`plugins/codex/kabo-alpha/hooks/hooks.json`](plugins/codex/kabo-alpha/hooks/hooks.json) and the `scripts/hooks/` files it invokes — they are what reports usage — then trust them explicitly in the host and restart Codex.

### From a local clone

Either host takes a path in place of the slug:

```bash
claude plugin marketplace add /absolute/path/to/kabo-plugins
codex plugin marketplace add /absolute/path/to/kabo-plugins
```

## Signing in

Authorization is a separate step, and the two hosts do it differently.

- **Claude Code** — run `/kabo-login` in a session. It prints a URL and an 8-character code; confirming that code in a browser, **on any device**, completes an RFC 8628 device flow. The renewable credential is written to `~/.kabo/credentials.json` with mode `0600`, and `bin/kabo-headers` is the only thing that reads it. `/kabo-logout` revokes it on every device at once.
- **Codex** — run `codex mcp login kabo` and complete the OAuth authorization in the browser. The host holds and renews the token; no Kabo credential is stored on your machine.

For the authorization model in full, the data path, and the privacy boundary, see the plugin READMEs: [Claude Code](plugins/claude/kabo-alpha/README.md) · [Codex](plugins/codex/kabo-alpha/README.md).

## Contents

| Plugin | Host | Marketplace | Description |
|---|---|---|---|
| [`kabo-alpha`](plugins/claude/kabo-alpha/) | Claude Code | `kabo-plugins` | The Kabo client: skill search/download/signature verification, restricted subagent execution, dynamic routing guidance |
| [`kabo-alpha`](plugins/codex/kabo-alpha/) | Codex | `kabo-plugins-codex` | The same client for Codex: bundled skills, host OAuth for the MCP server, allowlisted hook telemetry |

> The `-alpha` suffix is meant literally: this is an early release, and interfaces may still change between versions.
