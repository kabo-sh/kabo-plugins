# kabo-alpha for Codex

The Codex build of the Kabo client plugin. It connects to the bundled `kabo` MCP, searches, downloads, and verifies the signature of creator research skills, then runs them in the mode the skill manifest declares — deterministic skills as one `kabo-run-pipeline` command on the main thread, skills with a semantic pass in a Codex subagent (see "Execution modes and the fast path").

Requires Node.js 20 or later. Connects to `https://kabo.sh/mcp` by default.

**Data fetching needs no local setup** (as of 0.12.0): every creator research fetch runs on Kabo's servers through the `data_connector_catalog` / `data_connector_run` tools of the bundled `kabo` MCP. There are no provider keys, no forwarded `env_vars`, no local connectors server, and no local binaries — so there is no proxy configuration to do for data fetching either.

> As of 0.12.0 both variants take exactly the same data path (the platform `kabo` MCP), and `kabo` is the only server in `.mcp.json`.
> The only remaining differences are at the host capability level (see "Usage data reporting boundary": subagent output is not collected).

## Install

The repo root's `.agents/plugins/marketplace.json` already registers this directory as `kabo-alpha`. In a Codex CLI that supports the plugin commands:

```bash
codex plugin marketplace add kabo-sh/kabo-plugins
codex plugin add kabo-alpha@kabo-plugins-codex
```

Note the marketplace name: it is `kabo-plugins-codex`, not `kabo-plugins`. The two hosts read two different manifests, so the names have to be distinct even though both publish the same plugin name. Installing from a local clone takes a path in place of the slug:

```bash
codex plugin marketplace add /absolute/path/to/kabo-plugins
```

ChatGPT desktop/Codex can also install it after a restart from the **Kabo Codex Plugins** source in the Plugins Directory. Installing or enabling a plugin does not automatically trust its hooks; review `hooks/hooks.json` and the `scripts/hooks/` scripts it invokes first, then trust them explicitly in the host.

If the current CLI has no `codex plugin` subcommand, the host version does not offer that install surface yet; you can run the in-repo validation first, but real installation, hook trust, and MCP connectivity must be signed off on a target Codex version that supports plugins.

## Authorization (only once)

```bash
codex mcp login kabo --scopes openid,offline_access,account:read,registry,telemetry,data
```

Complete the OAuth authorization in the browser (`kabo` is the server name declared in this plugin's `.mcp.json`). Once done, the Kabo tools are available **in tasks started after the login** — a task already running keeps the tool list it negotiated at start, so open a new task to use them — and the **host** holds the token and renews it.

The current platform also supports bare `codex mcp login kabo`. The explicit command above is the recommended compatibility path because it pins Kabo's required permissions across host versions. If you supply `--scopes`, do not trim the list: consent can still succeed with fewer scopes, but without `offline_access` renewal silently stops (signed out after ~2 hours, no visible error) and without `registry`/`telemetry`/`data` the platform tools 403. After converting its commas to spaces, it has the same ordered scope tokens as the Claude variant's `OAUTH_SCOPE` (`scripts/lib/credentials.js`).

**If no browser opens**, copy the authorization URL the CLI prints and open it manually; the callback returns to the waiting CLI. The Claude Code build hits this as a known host bug ([anthropics/claude-code#36307](https://github.com/anthropics/claude-code/issues/36307)) and the manual-URL workaround is the same one.

**Without any plugin**, Kabo's server can also be added in claude.ai or the Claude chat desktop app under **Settings → Connectors** as a custom connector pointing at `https://kabo.sh/mcp`. That surface is **data only** — no skill routing, signed download, signature verification, or isolated execution. It is a fallback, not the supported path.

As of 0.9.0 it is aligned with the Claude Code build:

- **No Kabo token is stored on your machine** — no `credentials.json`, no `KABO_API_TOKEN`, and no second terminal login command (the 0.6.x token login flow was removed entirely).
- Every action that needs a token rides that one authorized MCP connection.
- The plugin itself only reaches the **public read-only** endpoints `GET /api/sync`, `GET /api/meta-guidance`, and `GET /api/public-key`: they take no arguments, carry no identity, and upload no local data.

To revoke authorization: run `$kabo-logout`. It calls the platform's `auth_revoke_all` over the already-connected MCP link, revoking **every device's** authorization at once, and then clears the local cache. It is not instant: the access token the host already holds is a self-contained JWT and the platform runs no denylist, so the current connection keeps working for up to **2 more hours**, after which nothing can be renewed. To cut it off in the same second, also run `codex mcp logout kabo`.

Why `bearer_token_env_var` was removed: Codex's `auth` already defaults to `oauth`, but in its configuration semantics **a bearer token takes priority over the auth flow** — as long as that field is present, OAuth is never reached, and the platform stopped issuing long-lived `kabo_` tokens long ago.

`KABO_API_ENDPOINT` only changes the HTTP endpoint used by hooks/bin; it does not rewrite the URL in the bundled `.mcp.json`. For a self-hosted server, also edit `.mcp.json` to match before installing.

## Usage

- `$analyze`: the analysis entry point. Start the flow with whatever you want analyzed (account review / engagement rate / channel / niche / specific video); internally it follows `meta-guidance`'s routing rules rather than a separate one.
- `$kabo-start`: first-run onboarding — a tap-through questionnaire (22 questions in 6 groups, popup UI via `request_user_input` in Plan Mode; in Default mode — what most sessions, including the Desktop app, run by default — the same questions fall back to numbered chat text, an upstream Codex limitation, not a bug in this plugin (see `skills/kabo-start/SKILL.md`'s Tool contract section for the tracking issues and the undocumented opt-in)), one real analysis of your own account, and a 90-day plan you commit to. `$kabo-login` hands off to it after a first successful sign-in, and `$analyze` with no arguments does too, when no profile exists yet. It is explicit-only (`allow_implicit_invocation: false`): the analysis takes real time and a meaningful share of your own quota (the figures live in one Estimates block in `skills/kabo-start/SKILL.md`), and the flow says so before asking consent. Skip or *Not now* is always honored without a second ask.
- `$kabo-login`: opens Kabo's sign-in page in your browser so the web session is warm, then sends you to `codex mcp login kabo --scopes …` (the full command is in the Authorization section) for a one-click consent, then verifies with one real call. It never touches any credential itself.
- `$kabo-channel`: shows the active Skill Registry channel. Any account can select Production; an account with a server-side Internal grant can select Internal or Production and defaults to Internal. Switching does not change the grant or sign in again.
- `$kabo-logout`: revokes every device's authorization through the platform's `auth_revoke_all` tool, then clears the Codex skill cache, the run work directories, and trust material.

`meta-guidance` is still there, but demoted to the **routing rules** that `$analyze` reads; it is no longer a user-facing command. It also triggers automatically when you simply state a creator research need.

The Codex data root is `$KABO_CODEX_DATA`, defaulting to `~/.kabo/codex`. Downloaded skills live in that directory's `skill-cache/`, and everything a run produces — assembled snapshots, analyses, rendered reports — in `work/<run-id>/`, one directory per run, created `0700` with `0600` files.

The onboarding profile `$kabo-start` writes lives at `<data root>/onboarding-profile.json` (`0600`; schema `kabo-onboarding-profile.v1`: your questionnaire answers, the diagnosis, the measured baseline with its coverage, the plan, and run provenance — no credentials). It is deliberately under the Codex data root and not `~/.kabo/` directly: the Claude variant keeps its own profile there, and both plugins can be installed on one machine. Delete the file to start onboarding over; `$kabo-logout` deletes it too, together with the run work directories.

`bin/kabo-save-envelope` ships here byte-identical to the Claude variant, but on this host it is **currently inert**. It moves connector envelopes that a `PostToolUse` hook staged into a run's `snapshot/`, and the Codex host has no `PostToolUse` counterpart — so nothing is ever staged, `kabo-run-pipeline` is called without `--staging`, and the envelope files are written by whoever executes (see "Codex caveat" under "Execution modes and the fast path"). It ships anyway so the pipeline's drain step does not name a command that is missing here, and so the day this host gains the event only the hook has to be added. Whether it even needs one is open: KPI-104's fixed-length raw/no-echo stream may already avoid the cost this solves on the Claude side, and that has not been measured (kabo#482 §9.4).

`work/` is a sibling of `skill-cache/` and never a child of it: `bin/skill-verify` recomputes the checksum of every non-dot file under a cached skill directory, so an output written there would make that skill fail `checksum_mismatch` on its next run. `bin/kabo-run-dir` atomically reserves a new private directory for every run so concurrent agents cannot share artifact paths. Run directories are reclaimed by `bin/skill-gc` on the same 14-day TTL as the cache (judged by the directory's own mtime, since there is no `.meta.json` under `work/`), and `$kabo-logout` deletes them outright — copy anything you want to keep out of `work/` first.

## Execution modes and the fast path

A skill keeps `execution: "subagent"` (or `"inline"`) for older plugins. New clients first select a non-empty signed `pipeline` array; a matching `pipeline_operations[operation]` overrides the default, including an empty array that disables it for that operation. Mixed skills declare only their deterministic operations:

```json
{
  "execution": "subagent",
  "pipeline_operations": {
    "engagement-rate": [
      {"name": "analyze", "cmd": "python3 {skill}/scripts/analyze.py --handle {param.handle} --output {analysis}/result.json"},
      {"name": "render", "cmd": "python3 {skill}/scripts/render.py {analysis}/result.json --output {report}/REPORT.md"}
    ]
  }
}
```

The main agent fetches evidence and calls `kabo-run-pipeline --operation engagement-rate` once, omitting `--step`: the bin reads the selected signed commands. With no selected array the existing subagent/inline flow remains. A semantic pass still runs in skill-runner, which batches its deterministic tail using `--step`. Placeholders in templates stand bare; values are shell-quoted by the bin.

SessionStart requests `GET /api/meta-guidance?plugin=0.21.0`. The coordinated server serves v19 from 0.21.0 and preserves v18 for older or unspecified versions. New clients store signed envelopes in `meta-guidance.fast-path.<endpoint-hash>.json`, isolated from legacy rollback floors. The signed body stays within 8000 characters and the complete injection within 10000.

Catalog calls accept `connector_ids` or `skill_id` (both intersect). Skill filtering uses the optional manifest `required.connectors` declarations, each with `connector_id` and `operations`; an empty result is not evidence of readiness. Search may return `connectors_ready` for these declared dependencies, letting the executor reuse that note; legacy skills query explicit connector IDs once.

**Fetch and verify are one step.** On this host the downloaded package never touches a file: `registry_skill_download`'s structured result is streamed once through the echo-free raw PTY bridge, whose command now ends in `'<plugin-root>/bin/skill-unpack' --verify - '<data-root>/skill-cache'` (the flag may sit anywhere in the argument list, so it goes before the `-` that means stdin). `skill-unpack --verify` writes the cache directory, prints one manifest digest line — `manifest: execution=<mode> has_pipeline=<boolean> pipeline_operations=<operations> required.tools=<list> min_plugin_version=<x.y.z> skill=<id>@<version>` — and then runs `skill-verify <dest>` with stdio inherited, exiting with its code, so the bridge command's exit status is the verification result. The digest exists so the dispatcher never opens `manifest.json` separately; the chained verify exists so verification never runs twice. A cache hit skips the download and runs `skill-verify <dir>` once instead — the revocation check still happens every run.

**Files SessionStart writes** (under the data root, `$KABO_CODEX_DATA` or `~/.kabo/codex`, mode 0600):

- `revocation-sync.json` — `{"synced_at", "revocations", "server_api_version"}` from the `GET /api/sync` response, written only when that request answered: a session that starts offline leaves the previous file in place, or none at all. `skill-verify` consults it first and makes no network request while it is fresher than 10 minutes (`REVOCATION_SYNC_TTL_MS`); absent or older than that it queries live as before and rewrites the file — a missing snapshot makes it go live, never silent.
- `meta-guidance.current.md` — the guidance body currently in force: the signature-verified dynamic version, or the static `skills/meta-guidance/SKILL.md` body (front matter stripped) when that is unavailable. Written on every session start, offline included.
- `execution-conventions.md` — the `## C.` section of that body, written on every session start alongside it. `$skill-runner` reads this file instead of receiving the section pasted into its dispatch, which is where 25 seconds of the measured run below went; `$analyze` passes the path and pastes Section C only when the file is missing.

`plugin-root` (one line: the plugin root SessionStart computed from its own location, for skills that resolve `<plugin-root>/bin/...` by absolute path) predates these three and stays.

**Two bins carry the pipeline.**

`kabo-run-dir [--skill <skill-dir>] [--request-id <id>]` — unchanged without arguments; with `--skill` it also writes `<run dir>/run-manifest.json` (per `creator-research/schemas/run-manifest.schema.json`: run id, request id, skill id, plugin version, start time, status `running`, empty artifact list). stdout is still exactly the run id.

`kabo-run-pipeline --run-id <id> --skill <skill-dir> [--staging <dir>] [--language <tag>] [--param k=v]... [--report <file-name>] (--step '<shell command>')...` — the run directory must already exist. It drains `--staging` into `<run>/snapshot/` through `kabo-save-envelope` (sha256-checked) when that flag is given, expands the placeholders below in every `--step`, runs the steps in order with `/bin/sh -c` from the run directory under `umask 077` and `PYTHONDONTWRITEBYTECODE=1`, stops at the first non-zero exit, fails if any `__pycache__` / `*.pyc` / `*.pyo` appeared under the skill (it never deletes anything there), chmods the run directory to 700/600, runs `skill-verify --local-only <skill-dir>`, finalizes `run-manifest.json` (status, duration, sha256 of every file under `analysis/` and `report/`), and prints only run-relative lines: `step n/N ok <secs>s <command>`, `drained=<n>` (only when `--staging` was given), `creator_report: <run-id> → report/<file>`, `run-manifest: <run-id> → run-manifest.json`. Exit 1 on any failure, with the reason on stderr. It never calls the network and never reads credentials. When no `--step` is given and the manifest has a `pipeline` array of `{name, cmd}` objects, those commands are the steps — the forward-compatible shape for skills that ship their own sequence.

| Placeholder | Expands to |
|---|---|
| `{run}` | the run directory |
| `{skill}` | the skill directory |
| `{plugin}` | the plugin root (resolved from the bin's own location, not from `<data root>/plugin-root`) |
| `{cr}` | `{plugin}/creator-research` — what a SKILL.md's `../../` means |
| `{snapshot}` `{analysis}` `{report}` `{owner}` | the four run subdirectories |
| `{language}` | the `--language` tag |
| `{param.<key>}` | the value of `--param <key>=<value>` |
| `{envelopes}` | `--envelope <path>` for every `<run>/snapshot/envelope-*.json` in numeric order; empty when there are none |

An unknown placeholder is an error before any step runs, and so is a placeholder inside shell quotes. Every value is single-quoted for `/bin/sh` as it is substituted, so a placeholder is written bare in a step — wrapping one in quotes hands the script the quote characters as part of the value.

**Verification policy.** Every run verifies a skill's checksum and Ed25519 signature exactly once with a revocation check (`skill-unpack --verify` inside the bridge, or `skill-verify <dir>` on a cache hit): the revocation list comes from `revocation-sync.json` while it is under 10 minutes old, from a live `GET /api/sync` otherwise, and from the local marker alone when offline — as before. The only other verification in a run is `kabo-run-pipeline`'s post-run `skill-verify --local-only`, which re-checks checksum and signature against the pinned keyset, refreshes no keys and queries no list; it exists to prove the run left the signed skill byte-identical. The local `<id>.disabled` marker is honoured unconditionally in both modes. Nothing skips checksum or signature verification, and skill code still never receives credentials.

**Codex caveat: envelopes are hand-written.** Codex has no `PostToolUse` hook — `hooks/hooks.json` is SessionStart only and must stay that way (the host parses `command` | `prompt` | `agent` handlers and an unknown variant disables the whole file) — so nothing stages a connector response and no `kabo:` line ever appears. Whoever executes writes each completed response to `work/<run-id>/snapshot/envelope-NN.json` itself before the POST step, byte-for-byte and never abridged, and calls `kabo-run-pipeline` without `--staging`: `{envelopes}` expands to those files and no `drained=` line is printed. Whether this host needs a staging hook at all is still open (kabo#482 §9.4).

**Measured motivation.** One run of the deterministic skill `diagnose-reach-drop@0.2.0` on 2026-09-07 (on the Claude variant; the control plane has the same shape here) took 280 seconds end to end; the real data fetch was 7.6 seconds of it. The rest was control plane: 34 model turns, three `skill-verify` runs (each a live `GET /api/sync`, 1–3 s), `data_connector_catalog` pulled twice (53 KB each, overflowing the host's tool-result cap and forcing a file read-back), `connectors.v1.json` parsed twice, the main agent hand-typing the ~3 KB Section C into the subagent dispatch (25 s), the subagent spending 22 turns and 8 Bash calls on a fixed deterministic sequence, and a 1,886-token subagent summary. The fast path removes each of those: deterministic skills run as one pipeline command from the main task, semantic skills keep a slimmer subagent, and verification happens once — inside the bridge on this host.

**Coordinated rollout.** Deploy the server's versioned v18/v19 guidance and optional pipeline/catalog contract before releasing plugin 0.21.0. Run the explicit cross-release E2E against both 0.20.2/v18 and 0.21.0/v19; ordinary CI uses the public conformance vector without reading the other repository.

Content authors then add signed `pipeline` / `pipeline_operations` arrays, bare placeholders and `required.connectors` dependencies, while preserving `execution: "subagent"` and the older SKILL.md path. Candidates include diagnose-reach-drop, recommend-publish-timing, plan-platform-monetization, and deterministic operations in review-creator-account, research-tiktok-trends and analyze-content-video. Until content declares a pipeline, the plugin retains the subagent path; its verification and orchestration optimizations still apply.

## Creator research support files

`creator-research/` is the plugin-side support tree (`config/`, `schemas/`, plus `scripts/build_public_snapshot.py`, `scripts/account_analyzers.py` and `scripts/snapshot_store.py`). The platform's seven creator research skills (the 2026-08-16 V2 generation) bundle their own `scripts/` and `references/` inside the signed package and resolve them relative to the skill directory; what they use from this tree is the assembler, `scripts/build_public_snapshot.py`, and the shared account analyzer, `scripts/account_analyzers.py`, which run as the first `kabo-run-pipeline` steps (`{cr}/scripts/...`) before a skill's own analyzer. The `../../xxx` path mapping into `<plugin-root>/creator-research/xxx` that `meta-guidance` describes applies only to bodies that literally contain `../../` — the retired V1 generation — and no V2 body does.

It is nested in a subdirectory rather than spread across the plugin root because the root's `scripts/` already holds `hooks/` and `lib/` — dropping upstream's `scripts/` straight on top would delete the hook entry points.

The local fetch engine is gone in 0.12.0: `run_connector.py`, `preflight.py` and `build_head_video_analyzer.py` no longer ship, because fetching moved to the platform. The V1 `wrappers/<skill>/contract.json` layer is gone too — it resolved connectors for the five V1 skills, all retired in the V2 changeover. What stays is what the shipped runner and guidance still name (`config/`, whose `connectors.v1.json` is now consulted only to relabel a `limitations` array, and `schemas/`, including `run-manifest.schema.json` for the run record `kabo-run-dir --skill` opens and `kabo-run-pipeline` finalizes) plus three local-only scripts: `build_public_snapshot.py`, which assembles the collected envelopes into the `public-content-snapshot.v1` an analyzer reads, `account_analyzers.py`, the shared account analyzer that runs over that snapshot, and `snapshot_store.py`, plain local file persistence with no network and no credentials, whose V1 consumer retired without a successor.

## Usage data reporting boundary

**Tool-level telemetry is recorded by the server itself**: inside the MCP tool handler the platform already holds the tool name, your user id (from the verified JWT), the duration, and success or failure, and writes them straight to its database. The client no longer has PreToolUse/PostToolUse hooks, nor a local telemetry buffer — that "local JSONL + REST batch upload" channel was removed entirely in 0.9.0 (the platform-side `POST /api/telemetry` is retired as well).

**The client collects no usage events at all on this variant.** Earlier builds declared two `mcp_tool` subagent hooks meant to report event-level metadata over the authorized MCP connection — but the Codex host has never parsed that hook variant (its schema is `command` | `prompt` | `agent`), and an unknown variant does not degrade gracefully: it fails the whole hooks file, which silently disabled the SessionStart hook and with it skill sync and revocations (real incident, 2026-08-18). Those hooks are gone; usage telemetry stays uncollected here until the host offers an MCP-capable hook type, and the server-side tool telemetry above already covers what matters.

**This variant does not collect subagent output** either — and never did: Codex's `SubagentStop` hook has no structured output/success field, and `agent_type` is the host profile rather than the task name, so matcher-based attribution is unreliable. Neither build collects it — the Claude variant reported it under a `skill_output` field until that was removed, so both are metadata-only at most.

The following is never collected, and reading or serializing it is forbidden at the code level: prompts, tool argument/response content, the transcript that `transcript_path` points to, `last_assistant_message`, and the output of any subagent. When hooks are untrusted or disabled, the reports are simply missing and the main skill flow is unaffected. The MVP does not implement a standalone opt-out switch yet; hook trust/disabling is the host-level control today.

### Subagent limitations

A plain Codex subagent's `agent_type` is the host profile, not the task name, and a plugin cannot force-install a project/user custom-agent profile along with the package — so even when the host one day offers an MCP-capable hook type, per-subagent attribution will stay unreliable. `SubagentStop` has no structured success field, and neither output nor the transcript may be read to infer one. This is the other half of why dropping the unparseable telemetry hooks costs so little: what they could have attributed was never trustworthy to begin with. Skills with a selected non-empty pipeline array never spawn a subagent at all — the main task issues the connector calls and one `kabo-run-pipeline` command — so for them there is nothing to attribute client-side; the platform's server-side tool telemetry covers those calls like any other.

## Development validation

The cross-repo contract (server signs / plugin verifies, server packs / plugin unpacks and checks, and the three-way compareSemver cross-check) must stay in step with the server — a cross-repo test enforces it, and this variant is in its coverage.

Automated validation is not the same as install sign-off on the target host. These three **must be tested on a real Codex**:

1. The full OAuth flow and token renewal for `codex mcp login kabo --scopes openid,offline_access,account:read,registry,telemetry,data`.
2. Plugin installation and hook trust.
