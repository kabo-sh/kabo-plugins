---
name: meta-guidance
description: Skill routing entry point for the Kabo platform. Any task involving creator research must go through it — YouTube public evidence collection, viral and outlier breakdowns, channel benchmarking, cross-platform creator discovery. Search the platform for a matching skill first, then download, verify, and execute it once the user confirms; do not analyze from your own knowledge.
# Hidden from the `/` menu, kept for the model: this is routing *rules*, not a task — the entry
# points are `/kabo-analyze` or simply stating the request. `user-invocable: false` drops the slash
# listing only; the description stays in context and the model can still invoke it.
user-invocable: false
# This file is the fallback for when dynamic guidance fails signature verification or the client is offline; its body is a verbatim snapshot of that server-side version.
# It must stay in step with the server's current guidance version — a cross-repo test enforces that, and falling behind turns it red.
kabo_guidance_snapshot: 13
---

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
