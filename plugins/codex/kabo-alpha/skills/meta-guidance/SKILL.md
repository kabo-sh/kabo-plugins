---
name: meta-guidance
description: Routing and orchestration rules for Kabo skills (search, confirm, download, verify the signature, execute, degrade). Read when triggered by the $analyze entry point or a Kabo-related task; it is not a user-facing command itself — the user-side entry point is $analyze.
# This file is the fallback for when dynamic guidance fails signature verification or the client is offline; the body below the Codex deltas is a verbatim snapshot of that server-side version.
# It must stay in step with the server's current guidance version — a cross-repo test enforces that, and falling behind turns it red.
kabo_guidance_snapshot: 15
---

## Codex client deltas (these override the mechanics in the snapshot below wherever they conflict)

The snapshot is written for the Claude Code client. Everything about routing, evidence and honest degradation applies as-is; only these mechanics differ here:

- **Data root**: `$KABO_CODEX_DATA`, falling back to `~/.kabo/codex`. The cache is `<data root>/skill-cache/<id>/<version>/` and the revocation marker `<data root>/skill-cache/<id>.disabled`.
- **Run work directory**: `<data root>/work/<run-id>/`, created by the runner with `umask 077` (directories 0700, files 0600). Everything a downloaded skill writes goes there — analyzer `--output`, `--output-dir`, rendered reports. Never inside `<data root>/skill-cache/...`: `skill-verify` recomputes the checksum of every non-dot file under a skill directory, so one stray output makes that skill fail `checksum_mismatch` on its next run. `skill-gc` reclaims run directories on the same 14-day TTL as the cache, and `$kabo-logout` clears them.
- **Tools are not on PATH**: resolve the plugin root two levels up from this file and call `<plugin-root>/bin/skill-unpack` and `<plugin-root>/bin/skill-verify` by absolute path.
- **Authorization** is `codex mcp login kabo --scopes openid,offline_access,account:read,registry,telemetry,data` — native host OAuth. The explicit `--scopes` is required: the host's default scope request includes `email`, which the platform rejects at client registration (`invalid_scope`) before any consent page; `$kabo-login` carries the full flow, including why a trimmed list fails silently instead. The snapshot below names another entry point because one signed guidance document serves both clients: `/kabo-login` is the Claude variant's terminal device login and **does not exist here**. It does not apply; `$kabo-login` walks a user through the Codex flow, and this client stores no credential of its own. The platform tools also carry no `mcp__plugin_kabo-alpha_kabo__` host prefix here — they are the bundled `kabo` server's bare names (`registry_skill_search`, `data_connector_catalog`, `data_connector_run`, ...).
- **Subagent dispatch**: hand the task to a Codex subagent and require it to use `$skill-runner` explicitly; if the deployment installs the `kabo-skill-runner` custom-agent profile, select it. `${CLAUDE_PLUGIN_ROOT}` in the snapshot reads as `<plugin-root>`.
- **Section C travels with the task**: pass it to `$skill-runner` in full, as the snapshot says. The runner treats an attached execution-conventions section as winning over its own SKILL.md where they conflict, so a platform-side change reaches this client without a plugin release.
- The Codex runner is a behavioural constraint, not an enforced tool allowlist: that is never a reason to weaken signature verification, revocation, the `required` checks, or the work-directory rule above.

# Kabo skill routing (meta-guidance)

Routing and orchestration only; details live in each downloaded SKILL.md.

## A. Triggering and dispatch

Always route these creator-data needs through this flow — never answer from prior knowledge: public evidence collection (YouTube search, public channel/video metrics, comments, time-window trending), breakout analysis and ideation (channel-relative outliers, Hook/structure/CTA breakdowns, evidence-backed topics), channel research and benchmarking, cross-platform creator discovery (Instagram Reels reverse-engineering).

Capability directions, not a skill list — what exists is solely what `registry_skill_search` returns.

One well-defined need → single-skill flow; independently deliverable sub-goals → B.

## Single-skill flow (in order, no skipping)

1. **Search**: `registry_skill_search` by capability keywords; optional tag filter.
2. **Confirm**: list the hits' name/description/version/permissions; wait for the user's choice. `required.tools` naming a `data_connector_*` tool → call `data_connector_catalog` once; an operation not `implemented` or a connector not `ready` is a **platform-side gap** — relay it and wait for a go-ahead.
3. **Cache check**: `~/.kabo/skill-cache/<id>/<version>/` → jump to step 6; `<id>.disabled` → platform-revoked: stop and tell the user.
4. **Download**: `registry_skill_download` returns the SkillPackage JSON.
5. **Unpack**: `skill-unpack <file|->` (on PATH), from temp file or stdin.
6. **Verify**: run `skill-verify <skill dir>`.
7. **Dispatch** by `execution` in the directory's `manifest.json`: `subagent` → spawn **skill-runner** with ① the skill's local path ② a task-context summary (the runner cannot read this conversation) ③ Section C in full; `inline` → read the skill's SKILL.md here and follow it.
8. **Deliver** per Section E.

## B. Composite orchestration

1. Split into N sub-requests, each with an **independent** `registry_skill_search` query by capability keywords — never assume skill names.
2. Search in **parallel**; pick each best match by description/tags/required; no match → "**no coverage**" — never force-fit an approximate skill.
3. Selected skills run steps 3–6; verification failures and revocation hits never execute; unready/unimplemented connectors are platform-side "**missing dependency**". Permissions still shown before first use.
4. Dispatch by `execution` as above.
5. Merge into **one unified deliverable** per Section E; report failed or missing sub-requests in task terms (partial / no coverage / verification failed / missing dependency / execution failed).
6. Check coverage against the **original request**; restate gaps as new sub-requests (state what each round changes; the user can stop anytime), back to step 1 — **at most 3 rounds**; report remaining gaps honestly.

## Platform tools unavailable

Platform MCP tools (`mcp__plugin_kabo-alpha_kabo__*`) invisible or all failing → have the user run `/kabo-login` (terminal device login; a browser tab confirms the code); if Kabo is still unavailable afterwards, a new session picks the sign-in up on every host. Never route them to the host's own OAuth prompt for `kabo`. Never read, print, or shell-assemble an Authorization header — the plugin reads the local credential for you.

## Red lines

- Matching goes by what `registry_skill_search` returns — no hit means no hit, never fabricate.
- `skill-verify` failure (exit ≠ 0) or a revocation hit → never execute; tell the user why.
- `skill-verify` failures append `KABO_VERIFY_FAIL` events listed at session start. Call `telemetry_report_usage` once per entry (`event_id`); idempotent — on failure drop it, never block the user.
- Unavailable `required.tools` → tell the user and stop (composite: "verification failed"); never fabricate data.
- `min_plugin_version` above the local plugin version (in `.claude-plugin/plugin.json` under `~/.kabo/plugin-root`) → advise upgrading and stop; `skill-verify` would reject it anyway.

## C. Execution conventions for data-plane skills

> Pass this whole section to skill-runner with the task context — it runs isolated, cannot read this guidance, and executes SKILL.md itself.

Every fetch runs **on the platform**: Kabo holds the credentials, the user configures nothing. SKILL.md ships as-is describing a local Python path; translate at execution time:

**Readiness first.** Call `data_connector_catalog` once. Each connector reports `ready`, each operation `implemented`; short of both → stop that evidence path with the response's `setup_hint`, not at fetch time.

**Path mapping.** `../../config/`, `../../schemas/`, `../../scripts/` resolve under `${CLAUDE_PLUGIN_ROOT}/creator-research/` (root in `~/.kabo/plugin-root`), **not** two levels above the skill cache. Missing → the plugin is outdated: say so, don't guess.

**Skip preflight.** `scripts/preflight.py` no longer ships and must never be run — it probed local provider keys and binaries; none remain. `required.tools` plus the catalog check already gate dependencies.

**Don't run run_connector.py** — it no longer ships. Call `data_connector_run` instead: resolve `connector_id`/`operation` from `../../config/connectors.v1.json` (each connector's `used_by` names the skills it feeds) plus the catalog, `params` from that operation's `params_schema`; `max_provider_requests` is not an input. No wrapper contract ships per skill. Never hand-write a connector request file.

**Envelope semantics unchanged**: keep `status`/`limitations`/`provider`; report `limitations` verbatim in the summary. `blocked_setup` = **the platform** is missing that credential — the user cannot fix it, never send them to configure a key; `unsupported` = not implemented server-side yet. Neither is a tool failure: name what's unavailable, deliver the rest under SKILL.md's partial semantics, never substitute another source.

**Deliverable.** Render the creator report SKILL.md names and run its creator-report validator where shipped — red validator = failed run. Name the file on its own `creator_report:` line. Owner-account summaries carry conclusions and run-relative paths (`<run-id> → <path>`), never owner numbers — figures stay in the run directory JSON. Public figures always carry window, baseline, sample size, source.

## D. Evidence red lines (all research skills)

- **Evidence before analysis.** Unsupported judgments are labeled as inference, never mixed into statements about retrieved data.
- **Failures are not papered over.** A failed or blocked skill/connector is never silently replaced by another skill, web search, or prior knowledge; state which step failed and what's missing.
- **A missing dependency is not a skill failure.** An unready connector, unimplemented operation, or missing snapshot is a platform-side gap — report it separately from "ran but found nothing".
- **Never infer private metrics from public data.** CTR, retention, revenue, Instagram Insights require owner-authorized sources — never back-derivation from public views or likes.
- **Keep the caveats.** Conclusions carry window, baseline, sample size, missing values, source, retrieval time; evidence traces to URLs. Never promise virality.
- **One primary skill per run.** These skills overlap and extra runs burn paid quota; add a second only for **independent evidence value** — at most one. Overrides B's parallel splitting.

## E. Creator-facing delivery

The reply body is the file on the runner's `creator_report:` line — Read it and relay its structure and facts, translated to the user's language if needed; never re-synthesize from the summary. Return concise, natural Creator-facing Markdown in the user's language. Never Creator-facing: audit boundaries, limitations, `must_not_assume`, connector/provider detail, costs or quota, file names, run status, output inventory, reproducibility, validation status, skill names/versions — give them only when the user asks. Use `limitations` to shape partial results: say what is missing in task terms, never as an audit footnote. Failure reporting (D) and measurement basis stay.
