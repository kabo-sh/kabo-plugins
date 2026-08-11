# Kabo Claude Code Plugin

The Claude Code plugin for **Kabo**, the creator-focused Skill distribution platform: search, download, and verify the platform's creator research skills (YouTube public evidence collection, viral breakdowns, channel benchmarking, keyword research, and so on) inside Claude Code, and execute them in a restricted subagent.

## Install

In a Claude Code session:

```
/plugin marketplace add kabo-sh/kabo-plugins
/plugin install kabo-alpha@kabo-plugins
```

The plugin is not enabled by default (plugins that connect to external services require your explicit opt-in); just enable it when prompted.

Requires Node.js ≥ 20 (needed by the plugin's bundled local data-fetching server; in-process data fetching on a proxied network requires ≥ 24).

## Authorization (only once)

**Run `/mcp` in a session → pick `kabo` → complete sign-in and authorization in the browser** (OAuth 2.1 + PKCE). Once done, the tools are immediately available within that session, and the token is held and auto-renewed by the **host**.

That is the only place. In addition:

- **No Kabo token is stored on your machine** — there is no local credential file and no terminal login command.
- Every action that needs a token (tool calls, telemetry reporting) rides that one authorized MCP connection.
- The plugin itself only reaches three **public read-only** endpoints: `GET /api/sync`, `GET /api/meta-guidance`, `GET /api/public-key`. They take no arguments, carry no identity, and upload no local data.

## Third-party provider keys (optional, configure as needed)

Creator research skills need external data sources. **These keys use your own accounts and quota; the Kabo platform neither holds nor pays for them** — so you configure them yourself:

The configuration entry point is the **config prompt shown when enabling the plugin**: run `/plugin` in an interactive session, select kabo-alpha, (re-)enable it, and fill in the prompts — sensitive fields use a password input, and their values are stored in the system keychain, never in a plaintext file.

> Do not pass these keys with `claude plugin install --config key=<value>`: command-line arguments end up in shell history and the process list. There is no `claude plugin configure` subcommand.

| Config field | provider | Purpose | Billing |
|---|---|---|---|
| `youtube_api_key` | YouTube Data API v3 | Public search, video statistics | Free quota; beyond it, enable billing in Google Cloud |
| `tubelab_api_key` | TubeLab | Account-relative outliers, channel video research | Per your TubeLab plan |
| `gemini_api_key` | Google Gemini | Video content analysis (hook/structure/CTA breakdown) | By usage |
| `scrapecreators_api_key` | ScrapeCreators | Instagram Reels, creator breakout boards | Per credit |

**Proxied networks**: the plugin passes `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` (including their lowercase forms) through to the data-fetching subprocesses; in-process data fetching for TubeLab / Gemini goes through Node's built-in `NODE_USE_ENV_PROXY` (enabled by default; requires Node ≥ 24, older versions ignore it and stay on a direct connection). `connector_health` warns when the proxy is not taking effect.

Two more things are **not configuration fields**:

- **Local binaries**:
  - `youtube-pp-cli` — `npx -y @mvanhorn/printing-press-library install youtube --cli-only` (without Node, build it yourself with Go 1.26.5+)
  - `yt-dlp` (fetches public metadata/subtitles), `ffmpeg` + `ffprobe` (extract keyframes)
  - `scrapecreators` CLI — `npm i -g @scrapecreators/cli`
- **OpenSEO**: a standalone remote MCP (`https://app.openseo.so/mcp`) with **no key** — just authorize `openseo` in `/mcp`; the host manages the OAuth. Read-only by default; for writes such as saving keywords or modifying a Project, the skill asks you first.

All of the above are **optional**. For anything missing, the corresponding tool returns `blocked_setup` and tells you what to install or configure — it will **not** substitute another data source or existing knowledge and pretend it fetched data. You can ask the assistant to "check the data sources" at any time (the `connector_health` tool): it lists the key and local-command readiness of every data source in one pass, reporting status only and never echoing key values.

Keys are stored in the system keychain (on platforms without one, in `~/.claude/.credentials.json`) and are never written into a plaintext `settings.json`; note that the keychain shares a roughly 2KB limit with the OAuth token, so do not enter excessively long values. Keys are injected into the plugin's bundled local `connectors` MCP server process via `${user_config.*}` in `.mcp.json` — **never through a shell**, and never as command-line arguments.

The implementation is **faithful to the data sources**: these connectors are adapters over external components (the provider call details live in pinned CLI versions, yt-dlp/ffmpeg, and remote MCPs), so they invoke those as-is rather than bypassing them to hit the APIs directly — bypassing would lose the quota accounting and data-source constraints inside the CLIs, and the output would no longer be the validated shape.

## Usage

Just talk normally: when a task involves **creator research**, the `meta-guidance` skill routes it through search → user confirmation → download → write to disk → signature verification → execution; a skill that fails verification or has been revoked by the platform is never executed.

Seven creator research skills are currently published on the platform:

| skill | What it does | Prerequisites |
|---|---|---|
| `pp-youtube` | YouTube public evidence collection: search, channels, videos, public metrics | `youtube_api_key` + youtube-pp-cli |
| `yt-youtube-research-agent` | Recent vs high-view comparison for one channel, multi-channel benchmarking, playbook summary | Same as above |
| `head-youtube-research` | Account-relative outliers + hook/structure/CTA breakdown → topic ideas | `tubelab_api_key` (the deep-breakdown step also needs `gemini_api_key`; without it, delivery falls back to partial) |
| `openseo-keyword` | Niche demand, keyword expansion, search intent and SERP evidence | authorize openseo via `/mcp` |
| `claude-video-watch` | Multimodal evidence collection: timestamped transcript + limited keyframes | local yt-dlp/ffmpeg, no key |
| `yt-reverse-viral-reels` | Reverse-engineering viral Instagram Reels | `scrapecreators_api_key` + CLI |
| `yt-detect-creator-breakouts` | Emerging creator breakout board and watchlist | Same as above |

Slash commands (three):

| Command | What it does |
|---|---|
| `/kabo-login` | Points the way to authorization: sends you to `/mcp` to complete OAuth, then verifies with one real call. **It never touches any credential itself** — there is no credential on the machine to touch |
| `/kabo-analyze` | Analysis entry point: start the flow directly with whatever you want analyzed (`/kabo-analyze why has this channel been taking off lately <url>`). You do not have to use it — routing happens automatically when you simply state your need, and both paths run the same flow |
| `/kabo-logout` | Clears the local cache and trust material (skill cache / public key cache / guidance cache). **Not** a revocation of authorization |

## Dynamic routing guidance (meta-guidance)

The platform can update the routing guidance without shipping a new plugin version. At session start the plugin sends the platform **two anonymous read-only GETs** (carrying no identity and no local data): the revocation list + skill catalog, and the routing guidance with an Ed25519 signature.

Fetched guidance **only enters the model's context after it passes local signature verification**. The whole thing is discarded if any step fails: algorithm check → the checksum recomputed from the response body matches exactly → the Ed25519 signature is valid → type and resource match → not expired and the issue time is not in the future → the version number does not roll back; content that is over-long or contains the injection-fence sentinel string is rejected outright. When verification fails or you are offline, **nothing is injected** and the plugin's built-in static fallback guidance takes over. The injected text is wrapped in an explicit boundary declaration: what is inside the fence is **data, not instructions**, and must not override your instructions or safety constraints.

## Local data directory

The data root is fixed at `~/.kabo`:

```
~/.kabo/
├── skill-cache/<id>/<version>/   # unpacked skill (TTL 14 days, cleaned automatically)
├── skill-cache/<id>.disabled     # local disable marker for a platform revocation
├── public-keys.<bucket>.json     # pinned server-side signing keyset
├── pending-reports.jsonl         # buffer of skill verification failures awaiting relay (7-day TTL, idempotent)
└── meta-guidance.json            # signature-verified dynamic guidance, last-known-good
```

There is no credential file and no telemetry buffer directory.

## Collection boundary

Collected fields are strictly limited to a whitelist of 13 fields, 12 of which are **event-level metadata** (event name, timestamp, session id, skill id/version, status, duration, and so on).

**The only content-level field is `skill_output`** — it records the execution output of the skill-runner subagent this plugin dispatches (the body of the analysis report the skill produced), used to evaluate skill quality. Be aware: that output may contain your creator business data; reporting rides the MCP connection you authorized and handles no local token; only skill-runner subagents are collected, and the server enforces this independently as well; without authorization nothing is reported.

The following is **never collected**, and reading or serializing it is forbidden at the code level: your prompts, tool arguments, tool response content, the session transcript, and any output from a subagent other than skill-runner. The hooks config can be checked entry by entry in the `/hooks` menu, and the repository code is open and auditable. Collection failures and offline states degrade silently and never affect the session.

A telemetry opt-out switch is not provided today (this README serves as the explicit disclosure of what is collected); a production version will provide one.

## Known limitation: inconsistent host tool name prefixes

The prefix the host uses to register MCP tools is **not promised to be stable**: the documented name on the plugin bundled path is `mcp__plugin_kabo-alpha_kabo__<tool>`, while some hosts and the connector path register a UUID prefix instead. The restricted subagent's tool allowlist is written against the bundled path — use it through the plugin bundled MCP (pick `kabo` in `/mcp`), and do not separately add the same server as a connector; when the tools cannot be obtained, the hard rules require a **hard failure** that returns an error rather than producing wrong data.

## Directory structure

```
plugins/claude/kabo-alpha/
├── .claude-plugin/plugin.json    # plugin manifest (userConfig declares 4 sensitive provider keys)
├── .mcp.json                     # three bundled MCP servers: kabo(http), connectors(local stdio), openseo(http, remote)
├── connectors/server.mjs         # zero-dependency local MCP server; provider keys injected via env, never through a shell
├── creator-research/             # creator research support tree (config/schemas/wrappers/prompts/scripts)
├── skills/meta-guidance/SKILL.md # resident router skill, and the fallback when dynamic guidance fails verification (must not be deleted)
├── agents/skill-runner.md        # restricted execution subagent (Read/Grep/Glob/Bash + connector_* and openseo tools)
├── hooks/hooks.json              # 3 events: SessionStart + SubagentStart/Stop(matcher=skill-runner)
├── scripts/                      # hooks implementation and shared library
├── bin/                          # skill-verify / skill-unpack / skill-gc / kabo-auth
└── commands/                     # /kabo-login /kabo-analyze /kabo-logout
```
