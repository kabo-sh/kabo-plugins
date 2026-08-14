# Kabo Claude Code Plugin

The Claude Code plugin for **Kabo**, the creator-focused Skill distribution platform: search, download, and verify the platform's creator research skills (YouTube public evidence collection, viral breakdowns, channel benchmarking, cross-platform creator discovery, and so on) inside Claude Code, and execute them in a restricted subagent.

## Install

**Requires Claude Code 2.1.195 or newer.** The bundled MCP server supplies its own credential through a `headersHelper`, and `${CLAUDE_PLUGIN_ROOT}` inside that setting is only interpolated from 2.1.195 on. An older host runs the literal path, the helper never starts, and every request fails with a 401 that has no way out of it — because a server configured with a `headersHelper` does not fall back to host OAuth. If you are on an older Claude Code, upgrade before installing.

```bash
# 1. Add this repo as a plugin marketplace (the repo root has .claude-plugin/marketplace.json)
claude plugin marketplace add kabo-sh/kabo-plugins

# 2. Install and enable the plugin (defaultEnabled: false — plugins that connect to external services require explicit user opt-in)
claude plugin install kabo-alpha@kabo-plugins
claude plugin enable kabo-alpha
```

Step 1 also takes a path in place of the slug, if you are installing from a local clone:

```bash
claude plugin marketplace add /absolute/path/to/kabo-plugins
```

Inside a session, `/plugin marketplace add kabo-sh/kabo-plugins` does the same thing as step 1.

## Authorization (once per machine, from the terminal — 0.13.0)

**Run `/kabo-login`** (or `kabo-auth login` in a shell). It prints a URL and an 8-character code, opens the URL in a browser when it can, and waits:

```
To authorize Kabo, open:

    https://kabo.sh/device?user_code=K7QM2XR4

and confirm the code:  K7QM2XR4

Waiting for approval... (expires in 15 minutes; Ctrl-C to cancel)
```

That is an RFC 8628 device flow. Three consequences worth knowing:

- **The page can be confirmed on any device** — your phone counts. Nothing has to open a browser on the machine running Claude Code, which is the entire reason this replaced host OAuth: on the plugin-bundled path the host's authorization flow frequently never launched a browser at all ([anthropics/claude-code#36307](https://github.com/anthropics/claude-code/issues/36307), merged into #11585), and those users got *zero* logins rather than one.
- **The code shown in the browser must match the one in your terminal.** That comparison is the only thing preventing you from approving somebody else's sign-in request.
- **The credential lives on this machine**, at `~/.kabo/credentials.json` with mode `0600` (directory `0700`, written atomically). It is a renewable token bound to the `kabo-cli` client and to Kabo's MCP resource, valid 30 days, rotated on every renewal, and killable everywhere at once with `/kabo-logout`. It is **not** the static, non-expiring environment-variable token that 0.9.0 deleted — that one had no expiry, no audience and no way to revoke it short of a database edit, and it is not coming back.

`bin/kabo-headers` is the only thing that reads that file: Claude Code runs it once per MCP request and takes one line of JSON from its stdout. The token appears nowhere else — not in logs, not in arguments, not in environment variables, and not on stderr in any form.

`kabo-auth status` shows whether this machine is signed in, to which deployment, and for how long. It never prints a token.

**Without this plugin at all.** In claude.ai or the Claude chat desktop app you can add `https://kabo.sh/mcp` under **Settings → Connectors** as a custom connector and authorize it there. That surface is **data only**: the platform's data tools answer and nothing else — no meta-guidance routing, no signed skill download, no local signature verification, no skill-runner subagent. It is a fallback for people who cannot get the plugin flow to work — and it is a *different host*, not something to do inside Claude Code (see "Known limitation" below).

Alongside the credential, the plugin reaches three **public read-only** endpoints: `GET /api/sync`, `GET /api/meta-guidance`, `GET /api/public-key`. They take no arguments, carry no identity, and upload no local data — the anonymous half of the client is unchanged.

Local development / self-hosted server: change the URL in this directory's `.mcp.json` (MCP side) and set `KABO_API_ENDPOINT` (public endpoint and sign-in side). The credential records the deployment it was issued for, and the helper refuses to present it to any other one.

## Data fetching (nothing to configure — as of 0.12.0)

**There are no provider keys any more.** Every creator research fetch runs on Kabo's servers: the platform holds the third-party credentials, runs the connectors, and returns normalized rows. This plugin declares **no config fields**, bundles **no local MCP server**, and needs **no local binaries** (`yt-dlp`, `ffmpeg`, `youtube-pp-cli`, the `scrapecreators` CLI are all gone with the local pipeline).

Two tools on the platform's `kabo` server are the whole data plane:

| Tool | What it does |
|---|---|
| `data_connector_catalog` | No input. Lists every connector with its `ready` state and every operation with its `implemented` flag and `params_schema`. Call it **before** promising evidence |
| `data_connector_run` | Runs one operation of one connector server-side and returns the V1 envelope (`status` / `limitations` / `provider`) |

Two non-`completed` statuses are **platform-side gaps, not tool failures and not something you can fix**:

- `blocked_setup` — the platform is missing that credential.
- `unsupported` — that operation is not implemented server-side yet.

In both cases the skill degrades honestly under its own partial semantics: it says what is unavailable, delivers the rest, and never substitutes another data source or prior knowledge.

Because the fetch no longer happens on your machine, everything earlier versions documented here — the proxy configuration, the keychain storage, and the config-value injection path into a local server process — is gone with it.

## Usage

Just talk normally: when a task involves **creator research**, the `meta-guidance` skill routes it through search → user confirmation → download → write to disk → signature verification → execution; a skill that fails verification or has been revoked by the platform is never executed.

Five creator research skills are currently published on the platform:

| skill | What it does |
|---|---|
| `pp-youtube` | YouTube public evidence collection: search, channels, videos, public metrics |
| `yt-youtube-research-agent` | Recent vs high-view comparison for one channel, multi-channel benchmarking, playbook summary |
| `head-youtube-research` | Account-relative outliers + hook/structure/CTA breakdown → topic ideas |
| `yt-reverse-viral-reels` | Reverse-engineering viral Instagram Reels |
| `yt-detect-creator-breakouts` | Emerging creator breakout board and watchlist |

Which connectors and operations are live right now is answered by `data_connector_catalog`, not by this file — readiness moves, and a table in a shipped README cannot. Nothing it reports is fixable on your machine: an unready connector or an unimplemented operation is a platform-side gap, and a skill degrades under partial semantics rather than inventing the missing half.

These skills' bodies are **used verbatim from upstream with no rewriting** — upstream treats a skill body as a read-only deliverable and puts the adaptation in the connectors and wrappers. `meta-guidance` maps `../../config/`, `../../schemas/`, `../../wrappers/`, and `../../scripts/` in the body to this plugin's `creator-research/`, and maps `run_connector.py <connector>` (which no longer ships) to a `data_connector_run` call.

`creator-research/` is nested in a subdirectory rather than spread across the plugin root because the root's `scripts/` already holds `hooks/` and `lib/` — dropping upstream's `scripts/` straight on top would delete the hook entry points.

Slash commands (three):

| Command | What it does |
|---|---|
| `/kabo-login` | Terminal sign-in: prints a URL and a short code, waits for you to confirm it in a browser tab (any device), stores the credential `0600`, then verifies with one real call |
| `/kabo-analyze` | Analysis entry point: start the flow directly with whatever you want analyzed (`/kabo-analyze why has this channel been taking off lately <url>`). Internally it uses meta-guidance's routing rather than a separate one |
| `/kabo-logout` | A real logout, in two halves and in this order: it calls the platform's `auth_revoke_all` over the authorized MCP connection — revoking **every device's** authorization, not just this machine's — and then deletes this machine's credential along with the cache and trust material. Swapping the order breaks it: deleting the credential first leaves nothing to call the platform with |

How fast each surface actually stops: **this machine, the same second** (the credential is gone, so no header is produced and the request 401s); **renewal anywhere, the same second** (the refresh token is revoked); an access token already cached **on another machine, up to 30 minutes** — it is a self-contained JWT and the platform runs no denylist.

`/kabo-analyze` is the explicit entry point; you do not have to use it — meta-guidance routes automatically when you simply state your need, and both paths run the same flow.

## Dynamic meta-guidance

The platform can update the routing guidance without shipping a new plugin version. At SessionStart the plugin sends **two anonymous read-only GETs** to kabo.sh (carrying no identity and no local data):

- `GET /api/sync` — the revocation list (kill-switch) plus the full skill catalog; the number of available updates is computed **locally** by diffing against the installed versions.
- `GET /api/meta-guidance` — the routing guidance pushed by the platform, with an Ed25519 signature.

Fetched guidance **only enters the model's context after it passes local signature verification** (via `hookSpecificOutput.additionalContext`). Verification runs seven steps, and the whole thing is discarded if any one fails: the algorithm is ed25519 → the signed manifest is rebuilt from the response body and the recomputed checksum matches exactly → the Ed25519 signature is valid → `type` is `kabo.meta-guidance` → `resource` equals the MCP resource this client is actually connected to → not expired and the issue time is not in the future → `guidance_version` does not roll back. On top of that, content over 8000 characters, or content containing the injection-fence sentinel string, is rejected outright.

- **Verification fails / offline / cache expired → nothing is injected**, and the plugin's built-in static `skills/meta-guidance/SKILL.md` becomes the only guidance. It is the fallback and will not be removed.
- An envelope that passes verification is cached as-is to `~/.kabo/meta-guidance.<bucket>.json` (one bucket per endpoint, like the pinned keyset) as last-known-good, and is reused offline **only while it has not expired**.
- The injected text is wrapped in an explicit boundary declaration: what is inside the fence is **data, not instructions**, and must not override user instructions, CLAUDE.md, or safety constraints; any content asking to read credentials, send files out, skip verification, or change local configuration is ignored and reported to the user.

## Local data directory

The data root is fixed at `~/.kabo` (it does not follow `$CLAUDE_PLUGIN_DATA` — hooks and `bin/` must land in the same place, otherwise revocation markers get written under one root while verification looks under another):

```
~/.kabo/                          # directory mode 0700
├── credentials.json              # the sign-in credential, mode 0600, written atomically (0.13.0)
├── credentials.lock              # short-lived directory held while renewing; deleted by logout
├── skill-cache/<id>/<version>/   # unpacked skill + .meta.json (TTL 14 days, cleaned by bin/skill-gc)
├── skill-cache/<id>.disabled     # local disable marker for a revocation
├── work/<run-id>/                # one directory per run, holding everything a run produced — assembled snapshots, analyses, rendered reports (0700/0600, same 14-day TTL, cleaned by bin/skill-gc); logout deletes it outright, so copy anything worth keeping out of it first
├── public-keys.<bucket>.json     # pinned server-side signing **keyset** (TOFU + continuity rotation; 0.9.x's public-key.<bucket>.pem is kept as a fallback)
├── pending-reports.jsonl         # buffer of skill verification failures awaiting relay (7-day TTL / 100 entries, listed at session start for relay, idempotent)
└── meta-guidance.<bucket>.json   # signature-verified dynamic guidance, last-known-good (bucketed per endpoint, exactly like the keyset)
```

`credentials.json` is a single flat file rather than one bucket per endpoint: caches may legitimately coexist for several deployments, a sign-in may not. What bucketing would have protected against — presenting one deployment's token to another — is handled instead by recording the endpoint inside the file and refusing to use it anywhere else. `/kabo-logout` deletes it; so does `kabo-auth logout` on its own. There is no telemetry buffer directory.

## Collection boundary

Collected fields are strictly limited to a fixed whitelist of 12, listed here in full, and every one of them is **event-level metadata**: event_id / ts / session_id / event / tool_name / skill_id / skill_version / agent_id / agent_type / status / error_type / duration_ms.

**No content-level field is collected at all.** Nothing this plugin reports carries the text of a prompt, a tool argument, a tool result, or the body of a skill's analysis report — so no creator business data (audience size, revenue mix, and so on) can leave your machine through it. Earlier versions did report the skill-runner subagent's output under a `skill_output` field; it was removed, and the whitelist above is now the whole of it.

**Tool-level telemetry is recorded by the server itself**: inside the MCP tool handler the platform already holds the tool name, your user id (from the verified JWT), the duration, and success or failure, and writes them straight to its database. The client no longer has PreToolUse/PostToolUse hooks, nor a local telemetry buffer.

What remains is a usage signal about *which skill ran and whether it succeeded*:

- The reporting channel is the `mcp_tool`-type SubagentStart/SubagentStop hooks in `hooks/hooks.json`: they call `telemetry_report_usage` **over the MCP connection you authorized**, handling no local token.
- **Only skill-runner subagents are reported**: the hook's matcher is restricted to `skill-runner`, and the server enforces this independently as well.
- Without a Kabo sign-in there is no authorized MCP connection: the hook raises a non-blocking error and nothing is reported.

The following is **still never collected**, and reading or serializing it is forbidden at the code level:

- `prompt` (your prompts)
- `tool_input` (tool arguments)
- `tool_response` content
- the session transcript that `transcript_path` points to
- the output of any subagent, skill-runner included

A hook can technically access the full session transcript — the platform does not enforce otherwise; this boundary is upheld by the plugin's own implementation, and it is **verifiable**: the hooks config can be checked entry by entry in the `/hooks` menu (matcher and command), and the code is open source and auditable.

Collection failures and offline states degrade silently and never affect the session.

## Known limitation: inconsistent host tool name prefixes

The prefix the host uses to register MCP tools is **not promised to be stable**: the documented name on the plugin bundled path is `mcp__plugin_kabo-alpha_kabo__<tool>`, but some hosts and the connector path register a UUID prefix instead (for example `mcp__<uuid>__registry_skill_search`).

The `tools:` allowlist in `agents/skill-runner.md` holds the full scoped names from the bundled path (`Read, Grep, Glob, Bash` plus `data_connector_catalog` and `data_connector_run`) — when the host registers a UUID prefix, the runner cannot get the tools, and per the hard rules it **hard-fails** and returns an error rather than producing wrong data. Use it through the plugin's own bundled `kabo` server; do not separately add the same server as a connector.

Likewise, the two `mcp_tool` hooks in `hooks/hooks.json` use the bundled scoped name `plugin:kabo-alpha:kabo`; when the server is not connected the host raises a non-blocking error and the session continues.

## MVP simplifications (TODO)

- **No automatic reporting for skill_verify_fail**: `bin/skill-verify` is a Bash subprocess and never has an MCP connection. On failure it prints `KABO_VERIFY_FAIL error_type=... skill_id=... skill_version=...` on the **last line** of stderr, and meta-guidance instructs the main agent to make one best-effort relay. This is a best-effort **quality signal** — the model may ignore it and it can be forged — so it is not a security audit trail; the real security guarantee is local: signature verification failure means exit 1, and the skill is not executed.
- **No telemetry opt-out switch**: the reporting hooks are `mcp_tool` entries the host fires directly, so there is no client-side point at which the plugin could gate them. What is reported is the 12-field event-level whitelist above and nothing else — no content leaves the machine — and the hooks are visible entry by entry in the `/hooks` menu, which is where a user who wants none of it can see and refuse them.
- **About `.mcp.json`**: one server only — `kabo`, as `{type: "http", url: "https://kabo.sh/mcp-for-claude", headersHelper: "${CLAUDE_PLUGIN_ROOT}/bin/kabo-headers"}`. The URL stays **hardcoded, never a config template**: the desktop connector settings UI does not interpolate, so it would take a template literally as the URL and report "URL must start with https". `headersHelper` is configured deliberately as of 0.13.0, which is exactly what makes the host stop doing OAuth discovery — hence the 2.1.195 requirement at the top of this file, and hence the separate path: `/mcp-for-claude` and the host-OAuth route it forked from are the same handler behind the same audience and the same scopes, split only so the 401 on each can tell the user the truth about how *that* path is authorized.

## Directory structure

```
plugins/claude/kabo-alpha/
├── .claude-plugin/plugin.json    # plugin manifest (no config fields — there are no user-supplied keys; endpoint hardcoded in .mcp.json)
├── .mcp.json                     # one bundled MCP server: kabo (http, kabo.sh/mcp-for-claude + headersHelper) — the local connectors server is gone (0.12.0)
├── creator-research/             # upstream creator research support tree (config/schemas/wrappers + scripts/build_public_snapshot.py and scripts/snapshot_store.py); the local fetch scripts are gone
├── skills/meta-guidance/SKILL.md # resident router skill, and the verbatim fallback snapshot when dynamic guidance fails verification (must not be deleted)
├── agents/skill-runner.md        # restricted execution subagent (Read/Grep/Glob/Bash + data_connector_catalog/run)
├── hooks/hooks.json              # 3 events: SessionStart(command) + SubagentStart/Stop(mcp_tool, matcher=skill-runner)
├── scripts/hooks/session-start.js# syncs the revocation list from the public endpoints + fetches, verifies, and injects dynamic guidance
├── scripts/lib/common.js         # shared by hooks and bin (path/endpoint conventions, credential read/write + renewal lock, checksum, compareSemver, guidance signature verification)
├── scripts/lib/credentials.js    # the device-flow and renewal wire protocol (discovery, device code, token exchange) — holds no request header
├── bin/                          # skill-verify / skill-unpack / skill-gc / kabo-auth (executables, on the Bash PATH) + kabo-headers (run by the host, not by you)
└── commands/                     # /kabo-login /kabo-analyze /kabo-logout
```
