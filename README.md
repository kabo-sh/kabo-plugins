# kabo-plugins

The official [**Kabo**](https://kabo.sh/?utm_source=github&utm_medium=referral&utm_campaign=202608_plugins_readme&utm_content=readme_hero) plugin marketplace — the client for the creator-focused Skill distribution platform.

Kabo lets you search, download, and execute creator research skills inside Claude Code and Codex: YouTube and Instagram public-evidence collection, outlier and viral breakdowns, channel benchmarking, and emerging-creator discovery. Every skill is signed and distributed by the platform, and the client verifies the signature locally before executing it.

Creator research data is fetched by Kabo's servers, so there are no provider keys to configure. Usage telemetry is limited to event-level metadata — which skill ran and whether it succeeded; no prompt, tool, or skill-output content is collected.

Beyond the plugin, Kabo publishes a free, no-signup toolbox for YouTube, Instagram, and TikTok creators — calculators, checkers, and generators that run without an account — at [kabo.sh/tools](https://kabo.sh/tools?utm_source=github&utm_medium=referral&utm_campaign=202608_plugins_readme&utm_content=readme_tools).

## Install

One command, either host:

```bash
curl -fsSL https://raw.githubusercontent.com/kabo-sh/kabo-plugins/main/install.sh | bash
```

It reports which hosts it found on this machine and lets you pick **one or both** — Claude Code and Codex install in the same run. It never installs a host for you, never uses `sudo`, and never reads or writes a credential. After installing the Claude plugin it offers to start the plugin's own terminal sign-in (`kabo-auth login`, the same RFC 8628 device flow `/kabo-login` runs) right there: say yes, confirm the code, and it immediately makes one real request to the MCP endpoint with the credential just written — so you learn whether it works there and then, rather than at the first 401 inside a session. Decline, and signing in stays a separate step it prints at the end. It also looks for a pre-plugin direct `claude mcp add kabo` registration of the same endpoint — a leftover that now duplicates the bundled server — and offers to remove it, never automatically. On the Codex side it offers the host's browser OAuth in the same run.

If you would rather not pipe a script into a shell unseen:

```bash
curl -fsSL https://raw.githubusercontent.com/kabo-sh/kabo-plugins/main/install.sh | bash -s -- --dry-run
curl -fsSL https://raw.githubusercontent.com/kabo-sh/kabo-plugins/main/install.sh | bash -s -- --client claude,codex
```

Already cloned this repo? Skip the network: `./install.sh --repo /path/to/kabo-plugins`.

The rest of this section is the same thing by hand.

### Claude Code

**Requires Claude Code 2.1.195 or newer.** The bundled MCP server supplies its own credential through a `headersHelper`, and `${CLAUDE_PLUGIN_ROOT}` inside that setting is only interpolated from 2.1.195 on. An older host runs the literal path, the helper never starts, and every request fails with a 401. The host then falls back to its own OAuth discovery, which can even complete — but what it leaves behind is a host-held token that this plugin's sign-in, logout, and telemetry model does not manage. The supported path is the `/kabo-login` device flow, and that needs 2.1.195. Upgrade before installing.

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

However you installed it, authorization is a separate step, and the two hosts do it differently.

**Claude Code.** The shortest path is the installer itself: it offers to start the sign-in right after installing, so the whole onboarding is install → confirm the code → start a session — done. Otherwise, open a session and run `/kabo-login`: the terminal prints a URL and an 8-character code, and confirming that code in a browser tab — **on any device** — completes an RFC 8628 device flow.

**Your first session.** A successful `/kabo-login` hands off to `/kabo-start`: a short questionnaire, one real analysis of your own account, and a 90-day plan. Run `/kabo-start` again whenever you like — it reads what is already on file and offers to pick up where you stopped or start over.

**Which skills you receive.** `/kabo-channel` (`$kabo-channel` on Codex) shows the Skill Registry channel your account is on. Every account can select Production; an account the platform has granted Internal access can select either and defaults to Internal. Switching channels does not sign you in again and does not change the grant — the server is the sole authority on who has one.

Signing in from inside a running session works too. If Kabo is still unavailable afterwards, **start a new session** — that path works on every host (terminal, IDE extension, desktop app), and on the desktop app it is the only one.

In the CLI you can skip the restart: run `/mcp reconnect plugin:kabo-alpha:kabo` (Claude Code CLI 2.1.205 or newer; on an older CLI `/reload-plugins` also reconnects plugin servers). The full name matters: the host registers the bundled server as `plugin:kabo-alpha:kabo`, and a reconnect naming only `kabo` is answered with "There's no MCP server named ...". The host re-runs the credential helper on every connection — session start, reconnect, and once more when a tool call answers 401/403 — so a reconnect is all it takes for the fresh credential to be picked up. CLIs older than 2.1.205 lack the reconnect subcommand but still have `/reload-plugins`; the desktop app has neither, which is why a new session is the advice that leads this section.

**Authorization happens once per machine.** The renewable credential is written to `~/.kabo/credentials.json` with mode `0600`, and `bin/kabo-headers` is the only thing that reads it — the host runs that helper once per MCP request (through `bin/kabo-headers.sh`, a POSIX sh shim whose only job is finding a `node` binary: `$KABO_NODE`, then the node recorded at sign-in in `~/.kabo/node-path`, then PATH and the usual install locations; on native Windows without a POSIX `sh`, node must be on the host PATH) and merges its single line of stdout into the request headers. The desktop app is launched without your shell PATH, which is why the sign-in records that node at all; if the app still reports Kabo as unavailable, set `KABO_NODE` in its environment. The credential is bound to the `kabo-cli` client and to Kabo's MCP resource, expires in 30 days, rotates on every renewal, and `/kabo-logout` revokes it on every device at once. Beyond the MCP server, the plugin only reaches three public read-only endpoints (`GET /api/sync`, `GET /api/meta-guidance`, `GET /api/public-key`), with no parameters, no identity, and no local data sent upstream.

**Codex.** Authorization uses the host's own OAuth. The recommended compatibility form is `codex mcp login kabo --scopes openid,offline_access,account:read,registry,telemetry,data`; current deployments also support bare `codex mcp login kabo`, while the explicit form pins the Kabo permissions this plugin needs across host versions. Complete the authorization in the browser. The host holds and renews the token; no Kabo credential is stored on your machine. Only the Claude variant signs in from the terminal.

For the authorization model in full, the data path, and the privacy boundary, see the plugin READMEs: [Claude Code](plugins/claude/kabo-alpha/README.md) · [Codex](plugins/codex/kabo-alpha/README.md).

## Directory layout

| Path | Description |
|---|---|
| [`plugins/claude/kabo-alpha/`](plugins/claude/kabo-alpha/) | Claude Code plugin: meta-guidance routing (static fallback + the signature-verified dynamic version served by the server), the restricted skill-runner subagent, hook telemetry, and the `bin/` verification toolchain plus the `kabo-headers` credential helper the host runs per request |
| [`plugins/codex/kabo-alpha/`](plugins/codex/kabo-alpha/) | The same client for Codex: bundled skills, host OAuth for the MCP server, allowlisted hook telemetry and degradation for host differences |
| `.claude-plugin/marketplace.json` | Claude Code marketplace manifest (marketplace name `kabo-plugins`) |
| `.agents/plugins/marketplace.json` | Codex marketplace manifest (marketplace name `kabo-plugins-codex`) |
| `install.sh` | One-command installer for both hosts |

> The `-alpha` suffix is meant literally: this is an early release, and interfaces may still change between versions.
