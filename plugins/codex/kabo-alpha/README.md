# kabo-alpha for Codex

The Codex build of the Kabo client plugin. It connects to the bundled `kabo` MCP, searches, downloads, and verifies the signature of creator research skills, then runs them on the main thread or in a Codex subagent per the skill manifest.

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
codex mcp login kabo
```

Complete the OAuth authorization in the browser (`kabo` is the server name declared in this plugin's `.mcp.json`). Once done, the Kabo tools are available, and the **host** holds the token and renews it.

**If no browser opens**, copy the authorization URL the CLI prints and open it manually; the callback returns to the waiting CLI. The Claude Code build hits this as a known host bug ([anthropics/claude-code#36307](https://github.com/anthropics/claude-code/issues/36307)) and the manual-URL workaround is the same one.

**Without any plugin**, Kabo's server can also be added in claude.ai or the Claude chat desktop app under **Settings → Connectors** as a custom connector pointing at `https://kabo.sh/mcp`. That surface is **data only** — no skill routing, signed download, signature verification, or isolated execution. It is a fallback, not the supported path.

As of 0.9.0 it is aligned with the Claude Code build:

- **No Kabo token is stored on your machine** — no `credentials.json`, no `KABO_API_TOKEN`, and no second terminal login command (the 0.6.x token login flow was removed entirely).
- Every action that needs a token rides that one authorized MCP connection.
- The plugin itself only reaches the **public read-only** endpoints `GET /api/sync`, `GET /api/meta-guidance`, and `GET /api/public-key`: they take no arguments, carry no identity, and upload no local data.

To revoke authorization: run `$kabo-logout`. It calls the platform's `auth_revoke_all` over the already-connected MCP link, revoking **every device's** authorization at once, and then clears the local cache. It is not instant: the access token the host already holds is a self-contained JWT and the platform runs no denylist, so the current connection keeps working for up to **30 more minutes**, after which nothing can be renewed. To cut it off in the same second, also run `codex mcp logout kabo`.

Why `bearer_token_env_var` was removed: Codex's `auth` already defaults to `oauth`, but in its configuration semantics **a bearer token takes priority over the auth flow** — as long as that field is present, OAuth is never reached, and the platform stopped issuing long-lived `kabo_` tokens long ago.

`KABO_API_ENDPOINT` only changes the HTTP endpoint used by hooks/bin; it does not rewrite the URL in the bundled `.mcp.json`. For a self-hosted server, also edit `.mcp.json` to match before installing.

## Usage

- `$analyze`: the analysis entry point. Start the flow with whatever you want analyzed (channel / niche / specific video); internally it follows `meta-guidance`'s routing rules rather than a separate one.
- `$kabo-login`: opens Kabo's sign-in page in your browser so the web session is warm, then sends you to `codex mcp login kabo` for a one-click consent, then verifies with one real call. It never touches any credential itself.
- `$kabo-logout`: revokes every device's authorization through the platform's `auth_revoke_all` tool, then clears the Codex skill cache, the run work directories, and trust material.

`meta-guidance` is still there, but demoted to the **routing rules** that `$analyze` reads; it is no longer a user-facing command. It also triggers automatically when you simply state a creator research need.

The Codex data root is `$KABO_CODEX_DATA`, defaulting to `~/.kabo/codex`. Downloaded skills live in that directory's `skill-cache/`, and everything a run produces — assembled snapshots, analyses, rendered reports — in `work/<run-id>/`, one directory per run, created `0700` with `0600` files.

`work/` is a sibling of `skill-cache/` and never a child of it: `bin/skill-verify` recomputes the checksum of every non-dot file under a cached skill directory, so an output written there would make that skill fail `checksum_mismatch` on its next run. Run directories are reclaimed by `bin/skill-gc` on the same 14-day TTL as the cache (judged by the directory's own mtime, since there is no `.meta.json` under `work/`), and `$kabo-logout` deletes them outright — copy anything you want to keep out of `work/` first.

## Creator research support files

`creator-research/` is the plugin-side support tree (`config/`, `schemas/`, plus `scripts/build_public_snapshot.py` and `scripts/snapshot_store.py`). The platform's seven creator research skills (the 2026-08-16 V2 generation) bundle their own `scripts/` and `references/` inside the signed package and resolve them relative to the skill directory; what they use from this tree is the assembler, `scripts/build_public_snapshot.py`, which skill-runner drives before an analyzer runs. The `../../xxx` path mapping into `<plugin-root>/creator-research/xxx` that `meta-guidance` describes applies only to bodies that literally contain `../../` — the retired V1 generation — and no V2 body does.

It is nested in a subdirectory rather than spread across the plugin root because the root's `scripts/` already holds `hooks/` and `lib/` — dropping upstream's `scripts/` straight on top would delete the hook entry points.

The local fetch engine is gone in 0.12.0: `run_connector.py`, `preflight.py` and `build_head_video_analyzer.py` no longer ship, because fetching moved to the platform. The V1 `wrappers/<skill>/contract.json` layer is gone too — it resolved connectors for the five V1 skills, all retired in the V2 changeover. What stays is what the shipped runner and guidance still name (`config/`, `schemas/`) plus two local-only scripts: `build_public_snapshot.py`, which assembles the collected envelopes into the `public-content-snapshot.v1` an analyzer reads, and `snapshot_store.py`, plain local file persistence with no network and no credentials, whose V1 consumer retired without a successor.

## Usage data reporting boundary

**Tool-level telemetry is recorded by the server itself**: inside the MCP tool handler the platform already holds the tool name, your user id (from the verified JWT), the duration, and success or failure, and writes them straight to its database. The client no longer has PreToolUse/PostToolUse hooks, nor a local telemetry buffer — that "local JSONL + REST batch upload" channel was removed entirely in 0.9.0 (the platform-side `POST /api/telemetry` is retired as well).

The client is left with just two `mcp_tool` hooks, which report event-level metadata over the **authorized MCP connection** when a skill-runner subagent starts and stops: `session_id` / `agent_id` / `agent_type`. They handle no local token.

**This variant does not collect subagent output**: Codex's `SubagentStop` hook has no structured output/success field, and `agent_type` is the host profile rather than the task name, so matcher-based attribution is unreliable. Neither build collects it — the Claude variant reported it under a `skill_output` field until that was removed, so both are now metadata-only.

The following is never collected, and reading or serializing it is forbidden at the code level: prompts, tool argument/response content, the transcript that `transcript_path` points to, `last_assistant_message`, and the output of any subagent. When hooks are untrusted or disabled, the reports are simply missing and the main skill flow is unaffected. The MVP does not implement a standalone opt-out switch yet; hook trust/disabling is the host-level control today.

### Subagent limitations

A plain Codex subagent's `agent_type` is the host profile, not the task name. A plugin cannot force-install a project/user custom-agent profile along with the package, so by default the Kabo tool usage that happens inside a subagent can be reported, but "which subagent it came from" cannot be reliably tagged, and that subagent's success/failure is not reported.

Only if you separately install and select a custom-agent profile whose `agent_type` name contains `kabo` or `skill-runner` do the `SubagentStart/Stop` hooks record agent id/type and duration. `SubagentStop` has no structured success field, so `status` is fixed at `null`, and neither output nor the transcript is read to infer success or failure.

## Development validation

The cross-repo contract (server signs / plugin verifies, server packs / plugin unpacks and checks, and the three-way compareSemver cross-check) must stay in step with the server — a cross-repo test enforces it, and this variant is in its coverage.

Automated validation is not the same as install sign-off on the target host. These three **must be tested on a real Codex**:

1. The full OAuth flow and token renewal for `codex mcp login kabo`.
2. The `server` field of the `mcp_tool` hooks — the bare name `kabo` is filled in here, but whether Codex namespaces a plugin's bundled server (Claude uses `plugin:<plugin>:<server>`) has not been confirmed from source or docs. If it does not hold, the hook raises a non-blocking error and the session is unaffected.
3. Plugin installation and hook trust.
