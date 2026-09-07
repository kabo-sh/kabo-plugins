# Kabo Claude Code Plugin

The Claude Code plugin for **Kabo**, the creator-focused Skill distribution platform: search, download, and verify the platform's creator research skills (YouTube public evidence collection, viral breakdowns, channel benchmarking, cross-platform creator discovery, and so on) inside Claude Code, and execute them — deterministic skills as one `kabo-run-pipeline` command run by the main agent, skills with a semantic pass in a restricted subagent.

## Install

**Requires Claude Code 2.1.195 or newer.** The bundled MCP server supplies its own credential through a `headersHelper`, and `${CLAUDE_PLUGIN_ROOT}` inside that setting is only interpolated from 2.1.195 on. An older host runs the literal path, the helper never starts, and every request 401s; the host then falls back to its own OAuth discovery, and once the server publishes the metadata that chain needs, it can even complete — but it leaves a host-held token that this plugin's sign-in, logout, and telemetry model does not manage. The supported path is the `/kabo-login` device flow, and that needs 2.1.195. If you are on an older Claude Code, upgrade before installing.

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

`bin/kabo-headers` is the only thing that reads that file: Claude Code runs it once per MCP request (through `bin/kabo-headers.sh`, a POSIX sh shim whose only job is to find a `node` binary — see "About `.mcp.json`" below) and takes one line of JSON from its stdout. The token appears nowhere else — not in logs, not in arguments, not in environment variables, and not on stderr in any form.

`kabo-auth status` shows whether this machine is signed in, to which deployment, and for how long. It never prints a token.

**Signed in from inside a running session?** That session does not pick the credential up — start a new one. The host asks the plugin's credential helper for the header once, when it connects the `kabo` server at session start; a session that connected before the sign-in was told there is none, the host marked the server as needing authentication, and it does not ask the helper again for the life of that session (a 401 sends it into its own OAuth discovery, not back to the helper). A new session runs the helper afresh, on every host (terminal, IDE extension, and the desktop app, where a new session is the whole step). In a Claude Code **CLI** session that is already open, `/mcp reconnect plugin:kabo-alpha:kabo` (Claude Code CLI 2.1.205 or newer; on an older CLI `/reload-plugins` also reconnects plugin servers) does the same without a restart. The full name matters — the host registers the bundled server as `plugin:kabo-alpha:kabo`, and a reconnect naming only `kabo` is answered with "There's no MCP server named ...". That same answer to the **full** name means the session predates the plugin itself and holds no such server at all — `/reload-plugins` loads a just-installed plugin in place on the CLI, and a new session picks it up everywhere. Never answer the host's own OAuth "Authenticate" prompt for `kabo` — it appears in the old session precisely because that discovery found the server's OAuth metadata: the plugin's helper is the sign-in path, and a host-held token is one `/kabo-logout` cannot revoke.

The installer offers to start this same sign-in right after installing and then probes the MCP endpoint with the new credential (`bin/kabo-headers.sh --probe`, the same shim the host runs), so a credential the server would reject is reported in the installer rather than by a 401 in the first session. That makes the shortest onboarding: install → confirm the code in the installer → endpoint accepted → start a session, tools ready. The older path — install → new session → `/kabo-login` → one more new session — still works, but that last step is not optional: the session the login ran in never picks the credential up (CLI: `/mcp reconnect plugin:kabo-alpha:kabo` stands in for the new session).

**Without this plugin at all.** In claude.ai or the Claude chat desktop app you can add `https://kabo.sh/mcp` under **Settings → Connectors** as a custom connector and authorize it there. That surface is **data only**: the platform's data tools answer and nothing else — no meta-guidance routing, no signed skill download, no local signature verification, no skill-runner subagent. It is a fallback for people who cannot get the plugin flow to work — and it is a *different host*, not something to do inside Claude Code (see "Known limitation" below).

Alongside the credential, the plugin reaches three **public read-only** endpoints: `GET /api/sync`, `GET /api/meta-guidance`, `GET /api/public-key`. They take no arguments, carry no identity, and upload no local data — the anonymous half of the client is unchanged.

Local development / self-hosted server: change the URL in this directory's `.mcp.json` (MCP side) and set `KABO_API_ENDPOINT` (public endpoint and sign-in side). The credential records the deployment it was issued for, and the helper refuses to present it to any other one.

## Data fetching (nothing to configure — as of 0.12.0)

**There are no provider keys any more.** Every creator research fetch runs on Kabo's servers: the platform holds the third-party credentials, runs the connectors, and returns normalized rows. This plugin declares **no config fields**, bundles **no local MCP server**, and needs **no local binaries and no API keys** — the whole local fetch/transcode pipeline is gone, so there is nothing left to install, license, or keep up to date on your machine.

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

Just talk normally: when a task involves **creator research**, the `meta-guidance` skill routes it through search → user confirmation → download, write to disk and one signature verification (`skill-unpack --verify`) → execution in the mode the skill's manifest declares (see "Execution modes and the fast path" below); a skill that fails verification or has been revoked by the platform is never executed.

Nine creator research skills are currently published on the platform:

| skill | What it does |
|---|---|
| `review-creator-account` | Own-account health check: continue/stop/test decisions against a personal baseline |
| `research-content-trends` | Current trends, top content and small-account outliers, turned into creator-fit directions |
| `research-instagram-trends` | Instagram Reel trends with continuous evidence ranking |
| `research-youtube-trends` | Official-API YouTube trends with continuous evidence ranking |
| `analyze-creator-competitors` | Competitor discovery, cross-account playbooks, evidence-backed differentiation |
| `analyze-content-video` | Per-timestamp single-video diagnosis and re-edit plan; third-party teardowns included |
| `recommend-publish-timing` | Publish windows from the creator's own publish history; abstains honestly when the data is short |
| `develop-content-ideas` | Upstream evidence into selectable content ideas (pure downstream, no data fetching) |
| `create-script-and-packaging` | A selected idea into a production-ready script and packaging draft (pure downstream) |

They replace the five V1 skills (`pp-youtube`, `yt-youtube-research-agent`, `head-youtube-research`, `yt-reverse-viral-reels`, `yt-detect-creator-breakouts`), which are retired and revoked platform-side: cached copies are disabled at the next session sync, and this plugin's V1 wrapper contracts were removed with them.

Which connectors and operations are live right now is answered by `data_connector_catalog`, not by this file — readiness moves, and a table in a shipped README cannot. Nothing it reports is fixable on your machine: an unready connector or an unimplemented operation is a platform-side gap, and a skill degrades under partial semantics rather than inventing the missing half.

These skills' bodies are **used verbatim from upstream with no rewriting** — upstream treats a skill body as a read-only deliverable. A V2 package bundles its own `scripts/` (stdlib-only python3) and `references/` (frozen schemas and field maps) and resolves them relative to the skill directory; the plugin-side pieces of the pipeline are `creator-research/scripts/build_public_snapshot.py` (the assembler) and `account_analyzers.py` (the shared account analyzer), which run as the first `kabo-run-pipeline` steps before a skill's own analyzer. The `../../` path mapping into `creator-research/` that the V1 bodies needed applies only to bodies that literally contain `../../`, which no V2 body does.

`creator-research/` is nested in a subdirectory rather than spread across the plugin root because the root's `scripts/` already holds `hooks/` and `lib/` — dropping upstream's `scripts/` straight on top would delete the hook entry points.

Slash commands (five):

| Command | What it does |
|---|---|
| `/kabo-login` | Terminal sign-in: prints a URL and a short code, waits for you to confirm it in a browser tab (any device), stores the credential `0600`, then verifies with one real call. On a machine with no creator profile the verified sign-in flows straight into `/kabo-start` |
| `/kabo-start` | First-run onboarding, replicating the kabo mobile app's guided setup: a tap-through questionnaire (AskUserQuestion popups), one real check-up of the creator's own account, and a 90-day plan saved to `~/.kabo/onboarding-profile.json`. Discloses the run's cost before asking consent (the time and token figures live in one Estimates block in `commands/kabo-start.md`), lets the creator choose how to spend the wait, saves after every question group so an interrupted run resumes, and never re-pitches a skipped question. Runs automatically after the first sign-in; can be re-run explicitly to redo the questionnaire (the analysis is only re-run when the baseline is older than 30 days, and only after the cost is confirmed again) |
| `/kabo-analyze` | Analysis entry point: start the flow directly with whatever you want analyzed (`/kabo-analyze why has this channel been taking off lately <url>`). Internally it uses meta-guidance's routing rather than a separate one |
| `/kabo-channel` | Shows the active Skill Registry channel. Any account can select Production; an account with a server-side Internal grant can select Internal or Production and defaults to Internal. Switching does not change the grant or sign in again |
| `/kabo-logout` | A real logout, in two halves and in this order: it calls the platform's `auth_revoke_all` over the authorized MCP connection — revoking **every device's** authorization, not just this machine's — and then deletes this machine's credential along with the cache and trust material. Swapping the order breaks it: deleting the credential first leaves nothing to call the platform with |

How fast each surface actually stops: **this machine, the same second** (the credential is gone, so no header is produced and the request 401s); **renewal anywhere, the same second** (the refresh token is revoked); an access token already cached **on another machine, up to 2 hours** — it is a self-contained JWT and the platform runs no denylist.

`/kabo-analyze` is the explicit entry point; you do not have to use it — meta-guidance routes automatically when you simply state your need, and both paths run the same flow.

## Execution modes and the fast path

A skill's `manifest.json` declares how it runs, in `execution`:

| `execution` | Who runs it | How |
|---|---|---|
| `pipeline` | the main agent — no subagent | Read `SKILL.md` → `kabo-run-dir --skill <dir>` → the connector calls the SKILL.md names, in one assistant turn (the PostToolUse hook stages every envelope and prints a `kabo:` line naming the staging directory) → one `kabo-run-pipeline` call carrying every deterministic step as `--step` arguments → Read the report → reply |
| `subagent` | skill-runner | the same fixed sequence in at most three Bash calls (PRE: `kabo-run-dir --skill` + `python3 --version`; FETCH: the connector calls in one turn; POST: one `kabo-run-pipeline` with `--staging`), plus only the semantic pass the SKILL.md explicitly requires; returns a summary of about 300 tokens |
| `inline` | the main agent | reads the SKILL.md and follows it |

`execution` may also be an object — `{"default": "subagent", "operations": {"engagement-rate": "pipeline"}}` — giving one operation of a skill its own mode; the dispatcher picks the mode of the operation the user's request maps to. A deterministic skill is one with no model work between fetch and report: every step is a script its SKILL.md documents, and for it a subagent is pure overhead.

**Fetch and verify are one step.** `skill-unpack --verify <file>` writes the cache directory, prints one manifest digest line — `manifest: execution=<mode> required.tools=<list> min_plugin_version=<x.y.z> skill=<id>@<version>` — and then runs `skill-verify <dest>` with stdio inherited, exiting with its code. The digest exists so the dispatcher never opens `manifest.json` separately; the chained verify exists so verification never runs twice. A cache hit skips the download and runs `skill-verify <dir>` once instead — the revocation check still happens every run.

**Files SessionStart writes** (under `~/.kabo`, mode 0600):

- `revocation-sync.json` — `{"synced_at", "revocations", "server_api_version"}` from the `GET /api/sync` response, written only when that request answered: a session that starts offline leaves the previous file in place, or none at all. `skill-verify` consults it first and makes no network request while it is fresher than 10 minutes (`REVOCATION_SYNC_TTL_MS`); absent or older than that it queries live as before and rewrites the file — a missing snapshot makes it go live, never silent.
- `meta-guidance.current.md` — the guidance body currently in force: the signature-verified dynamic version, or the static `skills/meta-guidance/SKILL.md` body when that is unavailable. Written on every session start, offline included.
- `execution-conventions.md` — the `## C.` section of that body, written on every session start alongside it. skill-runner reads this file instead of receiving the section pasted into its dispatch, which is where 25 seconds of the measured run below went.

**Two bins carry the pipeline.**

`kabo-run-dir [--skill <skill-dir>] [--request-id <id>]` — unchanged without arguments; with `--skill` it also writes `<run dir>/run-manifest.json` (per `creator-research/schemas/run-manifest.schema.json`: run id, request id, skill id, plugin version, start time, status `running`, empty artifact list). stdout is still exactly the run id.

`kabo-run-pipeline --run-id <id> --skill <skill-dir> [--staging <dir>] [--language <tag>] [--param k=v]... [--report <file-name>] (--step '<shell command>')...` — the run directory must already exist. It drains `--staging` into `<run>/snapshot/` through `kabo-save-envelope` (sha256-checked), expands the placeholders below in every `--step`, runs the steps in order with `/bin/sh -c` from the run directory under `umask 077` and `PYTHONDONTWRITEBYTECODE=1`, stops at the first non-zero exit, fails if any `__pycache__` / `*.pyc` / `*.pyo` appeared under the skill (it never deletes anything there), chmods the run directory to 700/600, runs `skill-verify --local-only <skill-dir>`, finalizes `run-manifest.json` (status, duration, sha256 of every file under `analysis/` and `report/`), and prints only run-relative lines: `step n/N ok <secs>s <command>`, `drained=<n>`, `creator_report: <run-id> → report/<file>`, `run-manifest: <run-id> → run-manifest.json`. Exit 1 on any failure, with the reason on stderr. It never calls the network and never reads credentials. When no `--step` is given and the manifest has a `pipeline` array of `{name, cmd}` objects, those commands are the steps — the forward-compatible shape for skills that ship their own sequence.

| Placeholder | Expands to |
|---|---|
| `{run}` | the run directory |
| `{skill}` | the skill directory |
| `{plugin}` | the plugin root (resolved from the bin's own location, not from `~/.kabo/plugin-root`) |
| `{cr}` | `{plugin}/creator-research` — what a SKILL.md's `../../` means |
| `{snapshot}` `{analysis}` `{report}` `{owner}` | the four run subdirectories |
| `{language}` | the `--language` tag |
| `{param.<key>}` | the value of `--param <key>=<value>` |
| `{envelopes}` | `--envelope <path>` for every `<run>/snapshot/envelope-*.json` in numeric order; empty when there are none |

An unknown placeholder is an error before any step runs. Every value is single-quoted for `/bin/sh` as it is substituted, so a placeholder is written bare in a step — wrapping one in quotes hands the script the quote characters as part of the value.

**Verification policy.** Every run verifies a skill's checksum and Ed25519 signature exactly once with a revocation check (`skill-unpack --verify`, or `skill-verify <dir>` on a cache hit): the revocation list comes from `revocation-sync.json` while it is under 10 minutes old, from a live `GET /api/sync` otherwise, and from the local marker alone when offline — as before. The only other verification in a run is `kabo-run-pipeline`'s post-run `skill-verify --local-only`, which re-checks checksum and signature against the pinned keyset, refreshes no keys and queries no list; it exists to prove the run left the signed skill byte-identical. The local `<id>.disabled` marker is honoured unconditionally in both modes. Nothing skips checksum or signature verification, and skill code still never receives credentials.

**Measured motivation.** One run of the deterministic skill `diagnose-reach-drop@0.2.0` on 2026-09-07 took 280 seconds end to end; the real data fetch was 7.6 seconds of it. The rest was control plane: 34 model turns, three `skill-verify` runs (each a live `GET /api/sync`, 1–3 s), `data_connector_catalog` pulled twice (53 KB each, overflowing the host's tool-result cap and forcing a file read-back), `connectors.v1.json` parsed twice, the main agent hand-typing the ~3 KB Section C into the subagent dispatch (25 s), the subagent spending 22 turns and 8 Bash calls on a fixed deterministic sequence, and a 1,886-token subagent summary. The fast path removes each of those: deterministic skills run as one pipeline command from the main agent, semantic skills keep a slimmer subagent, and verification happens once.

**Server-side follow-ups this branch depends on.**

- Publish guidance body v19 — the body of `skills/meta-guidance/SKILL.md` on this branch; the cross-repo snapshot test is red until the two match.
- Declare `execution: "pipeline"` (or the object form) in the manifests of deterministic skills and operations. Candidates: `diagnose-reach-drop`, `recommend-publish-timing`, `plan-platform-monetization`, `review-creator-account`'s engagement-rate operation, `research-tiktok-trends`' trending-sounds operation, `analyze-content-video`'s transcript and cover operations. Until a manifest says so, a skill keeps running through skill-runner.
- Optional: a filter parameter on `data_connector_catalog`, so a dispatcher can ask for the one or two connectors a SKILL.md names instead of the 53 KB whole.

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
├── node-path                     # the absolute node binary `kabo-auth login` ran under (one line, mode 0600); read by the sh shims when the host has no node on PATH; deleted by logout
├── onboarding-profile.json       # schema kabo-onboarding-profile.v1: the creator's onboarding answers, diagnosis, baseline (with coverage + provenance), 90-day plan and resume state (written by /kabo-start after every group, mode 0600); holds no secrets, but it is the account's own diagnosis and plan, so logout deletes it along with `work/`
├── skill-cache/<id>/<version>/   # unpacked skill + .meta.json (TTL 14 days, cleaned by bin/skill-gc)
├── skill-cache/<id>.disabled     # local disable marker for a revocation
├── envelope-staging/<session>/   # connector envelopes the PostToolUse hook wrote verbatim (NN.json + NN.meta, 0600), waiting to be moved into a run's snapshot/ by bin/kabo-save-envelope; normally emptied within the same run
├── work/<run-id>/                # one directory atomically reserved by bin/kabo-run-dir per run, holding assembled snapshots, analyses, and reports (0700/0600, 14-day TTL via bin/skill-gc); logout deletes it outright
├── work/<run-id>/run-manifest.json # the run record: written by kabo-run-dir --skill (status running), finalized by kabo-run-pipeline (status, duration, sha256 of every analysis/ and report/ file)
├── revocation-sync.json          # {synced_at, revocations, server_api_version} from the last GET /api/sync (SessionStart, or skill-verify when it had to go live); skill-verify reuses it for 10 minutes instead of querying
├── meta-guidance.current.md      # the guidance body in force after the last SessionStart (dynamic when it verified, otherwise the static SKILL.md body)
├── execution-conventions.md      # Section C of that body — the file skill-runner reads instead of having it pasted into its dispatch
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

The following is **still never collected** — never sent anywhere — and reading or serializing it for reporting is forbidden at the code level:

- `prompt` (your prompts)
- `tool_input` (tool arguments)
- `tool_response` content
- the session transcript that `transcript_path` points to
- the output of any subagent, skill-runner included

**One hook does read tool results, and it never sends them anywhere (0.19.0).** `scripts/hooks/persist-envelope.js` runs on `PostToolUse` and `PostToolUseFailure` for the three `data_connector_*` tools (the failure event matters because one failed envelope inside a batch flags the whole call, and the envelopes that did succeed are in that same payload) and writes each connector envelope to `~/.kabo/envelope-staging/` so a skill can archive it without the model retyping it. Reading and *reporting* are different acts, and only the second one is what the list above forbids. This hook:

- writes to your disk only, under `~/.kabo`, mode 0600 — the same place your run outputs already live;
- opens no socket and starts no subprocess, and imports nothing that could (no `node:child_process`, `node:http`, `node:https`, `node:net`, no `fetch` — the plugin's regression suite asserts this against the source);
- is a plain `command` hook, deliberately not the `mcp_tool` kind the telemetry hooks use, so it has no authorized connection to send anything over;
- hands the host back only a one-line summary: connector id, operation, status, byte count, a sha256 prefix and the staging path — never envelope content.

Why it has to exist: a skill is required to archive the exact response it drew its numbers from, and before this the only way to get those bytes onto disk was to have the model retype the whole envelope. That was slow (measured: 836 seconds across seven runs) and it did not even work — the model shortened what it retyped and wrote itself a note admitting which fields it had dropped. Nothing leaves your machine either way; what changed is that the archived copy is now the real one.

A hook can technically access the full session transcript — the platform does not enforce otherwise; this boundary is upheld by the plugin's own implementation, and it is **verifiable**: the hooks config can be checked entry by entry in the `/hooks` menu (matcher and command), and the code is open source and auditable.

Collection failures and offline states degrade silently and never affect the session.

## Known limitation: inconsistent host tool name prefixes

The prefix the host uses to register MCP tools is **not promised to be stable**: the documented name on the plugin bundled path is `mcp__plugin_kabo-alpha_kabo__<tool>`, but some hosts and the connector path register a UUID prefix instead (for example `mcp__<uuid>__registry_skill_search`).

The `tools:` allowlist in `agents/skill-runner.md` holds the full scoped names from the bundled path (`Read, Grep, Glob, Bash` plus `data_connector_catalog` and `data_connector_run`) — when the host registers a UUID prefix, the runner cannot get the tools, and per the hard rules it **hard-fails** and returns an error rather than producing wrong data. Use it through the plugin's own bundled `kabo` server; do not separately add the same server as a connector.

Likewise, the two `mcp_tool` hooks in `hooks/hooks.json` use the bundled scoped name `plugin:kabo-alpha:kabo`; when the server is not connected the host raises a non-blocking error and the session continues.

## MVP simplifications (TODO)

- **No automatic reporting for skill_verify_fail**: `bin/skill-verify` is a Bash subprocess and never has an MCP connection. On failure it prints `KABO_VERIFY_FAIL error_type=... skill_id=... skill_version=...` on the **last line** of stderr, and meta-guidance instructs the main agent to make one best-effort relay. This is a best-effort **quality signal** — the model may ignore it and it can be forged — so it is not a security audit trail; the real security guarantee is local: signature verification failure means exit 1, and the skill is not executed.
- **No telemetry opt-out switch**: the reporting hooks are `mcp_tool` entries the host fires directly, so there is no client-side point at which the plugin could gate them. What is reported is the 12-field event-level whitelist above and nothing else — no content leaves the machine — and the hooks are visible entry by entry in the `/hooks` menu, which is where a user who wants none of it can see and refuse them.
- **About `.mcp.json`**: one server only — `kabo`, as `{type: "http", url: "https://kabo.sh/mcp-for-claude", headersHelper: "${CLAUDE_PLUGIN_ROOT}/bin/kabo-headers.sh"}`. The URL stays **hardcoded, never a config template**: the desktop connector settings UI does not interpolate, so it would take a template literally as the URL and report "URL must start with https". `headersHelper` is configured deliberately as of 0.13.0: the host runs the helper for this server's headers — at session start, on every reconnect, and once more as a retry when a call answers 401/403 — instead of opening its own OAuth flow up front. (When the helper produces nothing the host does still fall back to OAuth discovery, and once the server publishes the metadata that chain needs, it can complete — but it produces a host-held token that this plugin's sign-in, logout, and telemetry model does not manage, so it is not a supported way in and does not substitute for `/kabo-login` on an old host.) Hence the 2.1.195 requirement at the top of this file, and hence the separate path: `/mcp-for-claude` and the host-OAuth route it forked from are the same handler behind the same audience and the same scopes, split only so the 401 on each can tell the user the truth about how *that* path is authorized.
- **Why `headersHelper` is a shell script, and what it needs (2026-08-23)**: the host spawns the helper path itself, and a GUI-launched host — the desktop app above all — does not inherit your shell PATH, so an nvm/volta/fnm/Homebrew `node` is invisible to it. With the helper's old `#!/usr/bin/env node` shebang that meant: helper never starts, 0 bytes on stdout, 401, and the host's own sign-in prompt every session. `bin/kabo-headers.sh` (and the SessionStart command, `scripts/hooks/session-start.sh`) therefore resolve `node` first, via `scripts/lib/node-resolve.sh`, in this order: `$KABO_NODE` → `~/.kabo/node-path` (the node that ran `kabo-auth login`; `kabo-auth status` prints it) → `command -v node` → `/usr/local/bin`, Homebrew, nvm (newest version), volta, fnm (newest), `/usr/bin`, snap, `~/.local/bin` — then `exec` the real helper with it. The shim uses shell builtins only, never opens the credential file, and on failure writes nothing to stdout: exit 2 and one stderr line that names the fix (set `KABO_NODE`, or install node system-wide / symlink it into `/usr/local/bin`, then relaunch the app and start a new session). The SessionStart hook runs `bin/kabo-headers.sh --which` in the host's own environment and reports that same sentence as its own line when no node can be found. **Windows limitation**: a `.sh` shim needs a POSIX `sh`; where the host spawns `headersHelper` without one (native Windows outside Git-Bash/WSL), the shim cannot start, and `node` must be on the host's PATH as before. The hook command is written as `sh "${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-start.sh"`, which works wherever hook commands run through a shell.

## Directory structure

```
plugins/claude/kabo-alpha/
├── .claude-plugin/plugin.json    # plugin manifest (no config fields — there are no user-supplied keys; endpoint hardcoded in .mcp.json)
├── .mcp.json                     # one bundled MCP server: kabo (http, kabo.sh/mcp-for-claude + headersHelper) — the local connectors server is gone (0.12.0)
├── creator-research/             # creator research support tree (config/schemas + scripts/build_public_snapshot.py and scripts/snapshot_store.py); the local fetch scripts and the V1 wrappers/ are gone
├── skills/meta-guidance/SKILL.md # resident router skill, and the verbatim fallback snapshot when dynamic guidance fails verification (must not be deleted)
├── agents/skill-runner.md        # restricted execution subagent for `execution: subagent` skills (Read/Grep/Glob/Bash/Write + data_connector_*); `pipeline` skills never use it
├── hooks/hooks.json              # 5 events: SessionStart(command) + PostToolUse/PostToolUseFailure(command, matcher=data_connector_*) + SubagentStart/Stop(mcp_tool, matcher=skill-runner)
├── scripts/hooks/session-start.sh# the SessionStart command: resolves node (node-resolve.sh) and execs session-start.js
├── scripts/hooks/persist-envelope.js # PostToolUse + PostToolUseFailure: writes each connector envelope to envelope-staging/ verbatim so the model never has to retype one (0.19.0); local-only, see "Collection boundary"
├── scripts/hooks/session-start.js# syncs the revocation list from the public endpoints + fetches, verifies, and injects dynamic guidance; writes revocation-sync.json, meta-guidance.current.md and execution-conventions.md; also checks the host can run the credential helper
├── scripts/lib/common.js         # shared by hooks and bin (path/endpoint conventions, credential read/write + renewal lock, checksum, compareSemver, guidance signature verification)
├── scripts/lib/credentials.js    # the device-flow and renewal wire protocol (discovery, device code, token exchange) — holds no request header
├── scripts/lib/node-resolve.sh   # shared node lookup for the two sh shims ($KABO_NODE → ~/.kabo/node-path → PATH → usual install locations); builtins only
├── bin/                          # skill-verify / skill-unpack / skill-gc / kabo-run-dir / kabo-run-pipeline / kabo-save-envelope / kabo-auth (executables) + kabo-headers and its POSIX sh launcher
└── commands/                     # /kabo-login /kabo-start /kabo-analyze /kabo-channel /kabo-logout
```
