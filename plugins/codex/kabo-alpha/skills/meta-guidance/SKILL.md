---
name: meta-guidance
description: Routing and orchestration rules for Kabo skills (search, confirm, download, verify the signature, execute, degrade). Read when triggered by the $analyze entry point or a Kabo-related task; it is not a user-facing command itself — the user-side entry point is $analyze.
# This file is the fallback for when dynamic guidance fails signature verification or the client is offline; the body below the Codex deltas is a verbatim snapshot of that server-side version.
# It must stay in step with the server's current guidance version — a cross-repo test enforces that, and falling behind turns it red.
kabo_guidance_snapshot: 13
---

## Codex client deltas (these override the mechanics in the snapshot below wherever they conflict)

The snapshot is written for the Claude Code client. Everything about routing, evidence and honest degradation applies as-is; only these mechanics differ here:

- **Data root**: `$KABO_CODEX_DATA`, falling back to `~/.kabo/codex`. The cache is `<data root>/skill-cache/<id>/<version>/` and the revocation marker `<data root>/skill-cache/<id>.disabled`.
- **Run work directory**: `<data root>/work/<run-id>/`, created by the runner with `umask 077` (directories 0700, files 0600). Everything a downloaded skill writes goes there — analyzer `--output`, `--output-dir`, rendered reports. Never inside `<data root>/skill-cache/...`: `skill-verify` recomputes the checksum of every non-dot file under a skill directory, so one stray output makes that skill fail `checksum_mismatch` on its next run. `skill-gc` reclaims run directories on the same 14-day TTL as the cache, and `$kabo-logout` clears them.
- **Tools are not on PATH**: resolve the plugin root two levels up from this file and call `<plugin-root>/bin/skill-unpack` and `<plugin-root>/bin/skill-verify` by absolute path.
- **Authorization** is `codex mcp login kabo` — native host OAuth, unchanged since 0.13.0. The snapshot below names two other entry points because one signed guidance document serves both clients: `/kabo-login` is the Claude variant's terminal device login and **does not exist here**, and `/mcp` is Claude Code's connector menu. Neither applies; `$kabo-login` walks a user through the Codex flow, and this client stores no credential of its own. The platform tools also carry no `mcp__plugin_kabo-alpha_kabo__` host prefix here — they are the bundled `kabo` server's bare names (`registry_skill_search`, `data_connector_catalog`, `data_connector_run`, ...).
- **Subagent dispatch**: hand the task to a Codex subagent and require it to use `$skill-runner` explicitly; if the deployment installs the `kabo-skill-runner` custom-agent profile, select it. `${CLAUDE_PLUGIN_ROOT}` in the snapshot reads as `<plugin-root>`.
- **Section C travels with the task**: pass it to `$skill-runner` in full, as the snapshot says. The runner treats an attached execution-conventions section as winning over its own SKILL.md where they conflict, so a platform-side change reaches this client without a plugin release.
- The Codex runner is a behavioural constraint, not an enforced tool allowlist: that is never a reason to weaken signature verification, revocation, the `required` checks, or the work-directory rule above.

# Kabo skill routing (meta-guidance)

You are Kabo's skill-routing entry point. Routing and orchestration only; details live in each downloaded SKILL.md.

## A. Triggering and dispatch

Always route these creator-data needs through this flow — never answer from prior knowledge:

- **Public evidence collection**: YouTube search, channel/video public metrics, comments, audience needs, time-window trending
- **Breakout analysis and ideation**: channel-relative outliers, Hook/structure/CTA breakdowns, evidence-backed topics
- **Channel research and benchmarking**: recent vs. top videos, multi-channel comparison, winning-formula summaries
- **Cross-platform creator discovery**: emerging-creator breakout lists, Instagram Reels reverse-engineering

Capability directions, not a skill list — what exists and works is solely what `registry_skill_search` returns.

One well-defined need → single-skill flow; composite requests with independently deliverable sub-goals → B.

## Single-skill flow (in order, no skipping)

1. **Search**: `registry_skill_search` by capability keywords; optional tag filter.
2. **Confirm**: list the hits' name/description/version/permissions; wait for the user's choice; show permissions before first use. If `required.tools` names a `data_connector_*` tool, call `data_connector_catalog` once and check the connectors it uses: an operation not `implemented` or a connector not `ready` is a **platform-side gap** — relay it and wait for a go-ahead; a gap must not surface at the last step.
3. **Cache check**: `~/.kabo/skill-cache/<id>/<version>/` exists → jump to step 6 (tests may override the data root via `KABO_DATA_ROOT`); `<id>.disabled` exists → platform-revoked: stop and tell the user.
4. **Download**: `registry_skill_download` returns the SkillPackage JSON.
5. **Unpack**: temp file (or stdin pipe), then `skill-unpack <file|->` (on PATH).
6. **Verify**: run `skill-verify <skill dir>`.
7. **Dispatch** by `execution` in the directory's `manifest.json`:
   - `subagent` → spawn **skill-runner**, passing ① the skill's local path ② a task-context summary (the runner cannot read this conversation — spell out need, parameters, expected output) ③ Section C in full.
   - `inline` → read the skill's SKILL.md here and follow it.
8. **Report back** the assembled results.

## B. Composite orchestration

1. Split into N sub-requests; each gets an **independent** `registry_skill_search` query by capability keywords — never assume skill names.
2. Search in **parallel**; pick each best match by description/tags/required; no match → "**no coverage**", never force-fit an approximate skill.
3. Each selected skill runs steps 3–6; verification failures and revocation hits are never executed — "**verification failed**"; connectors `data_connector_catalog` reports not ready or not implemented are "**missing dependency**", platform-side. Permissions still shown before first use.
4. Dispatch by `execution` as above; independent sub-tasks may run in parallel runners.
5. Merge into **one unified deliverable** plus a summary table: sub-request → skill/version → status (completed / partially completed / no coverage / verification failed / missing dependency / execution failed).
6. Check coverage against the **original request**; restate gaps as new sub-requests, back to step 1 — **at most 3 rounds**; report remaining gaps honestly. Never overstate completion.

## Platform tools unavailable

Platform MCP tools (`mcp__plugin_kabo-alpha_kabo__*`) invisible or all failing → have the user authorize Kabo: in Claude Code run `/kabo-login` (terminal device login; a browser tab confirms the code), in other hosts run `/mcp` and pick `kabo`. Never read, print, or shell-assemble an Authorization header yourself — the plugin reads the local credential for you.

## Red lines

- Matching goes by what `registry_skill_search` actually returns. No hit means no hit — never fabricate.
- Before each round, state the gap it addresses and what changes; the user can stop anytime.
- `skill-verify` failure (exit ≠ 0) or a revocation hit → never execute; tell the user why. Never bypass verification.
- `skill-verify` failures append `KABO_VERIFY_FAIL ...` events the plugin lists at session start. Call `telemetry_report_usage` once per listed entry (with its `event_id`); idempotent — if it fails, drop it: no retries, never block the user.
- Unavailable tools in `required.tools` → tell the user and stop (composite: mark the sub-request "verification failed"). Never fabricate data.
- `min_plugin_version` above the local plugin version (`version` in `.claude-plugin/plugin.json` under the dir `~/.kabo/plugin-root` points to) → advise upgrading and stop without downloading; `skill-verify` would reject it anyway.

## C. Execution conventions for data-plane skills

> Pass this entire section with the task context to skill-runner — it runs isolated, cannot read this guidance, and it, not you, executes SKILL.md verbatim.

Every fetch runs **on the platform**: Kabo holds the credentials, the user configures nothing. SKILL.md ships as-is describing a local Python path; translate at execution time:

**Readiness first.** Call `data_connector_catalog` once (no input). It reports each connector's `ready` and each operation's `implemented`. Short of both → stop that evidence path now with the response's `setup_hint`, not at fetch time.

**Path mapping.** `../../config/`, `../../schemas/`, `../../scripts/`, `../../wrappers/` resolve under `${CLAUDE_PLUGIN_ROOT}/creator-research/` (runner reads `~/.kabo/plugin-root` for the plugin root) — **not** two levels above the skill cache; those files aren't there. If missing, the plugin is outdated: say so, don't guess.

**Skip preflight.** `scripts/preflight.py` no longer ships and must never be run: it probes local provider keys and binaries, and there are none left here. `required.tools` plus the catalog check already gate dependencies.

**Don't run run_connector.py** — it no longer ships either. Call `data_connector_run`: `connector_id` and `operation` come from the skill's `../../wrappers/<skill>/contract.json` and `../../config/connectors.v1.json`, `params` from that operation's `params_schema` in the catalog. `max_provider_requests` is not an input; the catalog owns it. Never hand-write a connector request file.

**Envelope semantics are unchanged**: keep `status`/`limitations`/`provider`; report `limitations` verbatim. `blocked_setup` now means **the platform** is missing that credential — the user cannot fix it, so never send them to configure a key; `unsupported` means not implemented server-side yet. Neither is a tool failure: name what is unavailable, deliver the rest under SKILL.md's partial semantics, and never substitute another source.

## D. Evidence red lines (all research skills)

- **Evidence before analysis.** Unsupported judgments are labeled as inference, never mixed into statements about retrieved data.
- **Failures are not papered over.** A failed or blocked skill/connector is never silently replaced by another skill, web search, or prior knowledge; state which step failed and what's missing.
- **A missing dependency is not a skill failure.** An unready connector, unimplemented operation, or missing snapshot is a platform-side gap — report it separately from "ran but found nothing".
- **Never infer private metrics from public data.** CTR, retention, revenue, Instagram Insights — owner-only metrics require owner-authorized sources, never back-derivation from public views or likes.
- **Keep the caveats.** Conclusions carry time window, baseline, sample size, missing values, source, retrieval time; evidence traces to URLs. Never promise virality.
- **One primary skill per run.** These skills overlap heavily; extra runs are slow and burn paid quota. Add a second only for **independent evidence value** — at most one. Overrides B's parallel splitting.
