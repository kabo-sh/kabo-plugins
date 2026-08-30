---
name: meta-guidance
description: Skill routing entry point for the Kabo platform. Any task involving creator research must go through it — YouTube public evidence collection, viral and outlier breakdowns, channel benchmarking, cross-platform creator discovery. Search the platform for a matching skill first, then download, verify, and execute it once the user confirms; do not analyze from your own knowledge.
# Hidden from the `/` menu, kept for the model: this is routing *rules*, not a task — the entry
# points are `/kabo-analyze` or simply stating the request. `user-invocable: false` drops the slash
# listing only; the description stays in context and the model can still invoke it.
user-invocable: false
# This file is the fallback for when dynamic guidance fails signature verification or the client is offline; its body is a verbatim snapshot of that server-side version.
# It must stay in step with the server's current guidance version — a cross-repo test enforces that, and falling behind turns it red.
kabo_guidance_snapshot: 17
---

# Kabo skill routing (meta-guidance)

Routing and orchestration only; details live in each downloaded SKILL.md.

## A. Triggering and dispatch

Always route these creator-data needs through this flow — never from prior knowledge: public evidence collection (YouTube search, public channel/video metrics, comments, window trending), breakout analysis and ideation (channel-relative outliers, Hook/structure/CTA breakdowns, evidence-backed topics), channel research and benchmarking, cross-platform creator discovery (Instagram Reels).

One well-defined need → single-skill flow; independently deliverable sub-goals → B.

## Single-skill flow (in order, no skipping)

1. **Search**: `registry_skill_search` by capability keywords; optional tag filter.
2. **Confirm**: list each hit's name/description/version/permissions and wait for the user's choice. A `data_connector_*` tool in `required.tools` → `data_connector_catalog` once; an operation not `implemented` or a connector not `ready` is a **platform-side gap** — relay it and wait.
3. **Cache check**: `$KABO_DATA_ROOT/skill-cache/<id>/<version>/` (falling back to `~/.kabo`) → step 6; `<id>.disabled` → platform-revoked: stop, tell the user.
4–6. **Download** (`registry_skill_download` → SkillPackage JSON), **unpack** (`skill-unpack <file|->`, on PATH), then **verify** (`skill-verify <dir>`).
7. **Dispatch** by `execution` in `manifest.json`: `subagent` → spawn **skill-runner** with ① the skill's local path ② a task-context summary (it cannot read this conversation) ③ Section C in full; `inline` → read that SKILL.md here.
8. **Deliver** per Section E.

## B. Composite orchestration

1. Split into N sub-requests, each with an **independent** `registry_skill_search` query by capability keywords — never assume names.
2. Search in **parallel**; best match by description/tags/required; no match → "**no coverage**", never a force-fit.
3. Selected skills run steps 3–6; verification failures and revocation hits never execute; an unready or unimplemented connector is a platform-side "**missing dependency**". Permissions shown before first use.
4. Dispatch by `execution` as above.
5. Merge into **one unified deliverable** per Section E; report failed or missing sub-requests in task terms (partial/no coverage/verification failed/missing dependency/execution failed).
6. Check coverage against the **original request**; restate gaps as new sub-requests (say what each round changes; user can stop anytime), back to step 1 — **at most 3 rounds**; report remaining gaps honestly.

## Platform tools unavailable

Platform MCP tools (`mcp__plugin_kabo-alpha_kabo__*`) invisible or all failing → have the user run `/kabo-login` (terminal device login); a new session picks the sign-in up on every host. Never route them to the host's OAuth prompt for `kabo`; never read, print, or shell-assemble an Authorization header — the plugin reads the local credential.

## Red lines

- Matching goes by what `registry_skill_search` returns — capability directions, not a skill list; no hit means no hit, never fabricate.
- `skill-verify` failure (exit ≠ 0) or a revocation hit → never execute; say why.
- `skill-verify` failures append `KABO_VERIFY_FAIL` events listed at session start; call `telemetry_report_usage` once per `event_id` — idempotent; on failure drop it, never block the user.
- Unavailable `required.tools` → tell the user and stop (composite: "verification failed"); never fabricate data.
- `min_plugin_version` above the local version (`.claude-plugin/plugin.json` under `$KABO_DATA_ROOT/plugin-root`) → advise upgrading and stop; `skill-verify` rejects it anyway.

## C. Execution conventions for data-plane skills

> Pass this whole section to skill-runner with the task — it runs isolated and cannot read this guidance.

Every fetch runs **on the platform**: Kabo holds the credentials, the user configures nothing. SKILL.md describes a local Python path; translate it:

**Readiness first.** `data_connector_catalog` once: connectors report `ready`, operations `implemented`. Short of both → stop that evidence path with its `setup_hint`, not at fetch time.

**Path mapping.** `../../config/`, `../../schemas/`, `../../scripts/` sit under `${CLAUDE_PLUGIN_ROOT}/creator-research/` (root in `$KABO_DATA_ROOT/plugin-root`, falling back to `~/.kabo`), **not** two levels above the skill cache. Missing → outdated plugin: say so, don't guess.

**Never run `scripts/preflight.py` or `scripts/run_connector.py`** — neither ships; `required.tools` plus the catalog gate dependencies. Call `data_connector_run`: `connector_id`/`operation` from `../../config/connectors.v1.json` (a connector's `used_by` names the skills it feeds) plus the catalog, `params` from its `params_schema`. `max_provider_requests` is not an input, no wrapper contract per skill, a request file is never hand-written.

**Envelope semantics unchanged.** The stored envelope keeps `status`/`limitations`/`provider` as received — the run's audit record; what you report is relabelled per E, meaning intact and **never verbatim**. Apply this status matrix exactly:

- `completed` is success: persist and use its evidence.
- `completed_partial` and `partial` are usable partial results, not tool failures: persist their evidence, continue only under SKILL.md's partial semantics, and report every resulting gap.
- `blocked_setup` and `unsupported` are platform-side gaps, not tool failures: the former means the **platform** lacks that credential (the user cannot fix it, so never send them to configure a key), and the latter means the operation is not implemented server-side. Stop that evidence path and apply partial/gap semantics to anything else deliverable.
- `failed`, a host/backend result marked `isError: true`, and every other unrecognized non-success status are execution failures: never persist or consume them as successful evidence, and explicitly report which execution failed.

For every partial result, platform-side gap, or execution failure, do not retry and do not switch data sources. Preserve each limitation's meaning, relabel it per E, and never substitute another source.

**Deliverable.** Render the creator report SKILL.md names, run its creator-report validator where shipped (red = failed run), and name it on its own `creator_report:` line. Owner summaries carry conclusions and run-relative paths (`<run-id> → <path>`), never owner numbers; figures stay in the run JSON.

## D. Evidence red lines (all research skills)

- **Evidence before analysis.** Unsupported judgments are labeled inference, never mixed into statements about retrieved data.
- **Failures are not papered over.** A failed or blocked skill/connector is never silently swapped for another skill, web search or prior knowledge; say which step failed and what is missing.
- **A missing dependency is not a skill failure.** An unready connector, unimplemented operation or missing snapshot is a platform-side gap — report it apart from "ran but found nothing", naming the gap, not the supplier.
- **Never infer private metrics from public data.** CTR, retention, revenue, Instagram Insights need owner-authorized sources, never back-derivation from public views or likes.
- **Keep the caveats.** Conclusions carry window, baseline, sample size, missing values, source, retrieval time; evidence traces to URLs. Never promise virality.
- **One primary skill per run.** These overlap and extra runs burn paid quota; add a second only for **independent evidence value** — at most one. Overrides B's splitting.

## E. Creator-facing delivery

The reply body is the file on the runner's `creator_report:` line — Read it and relay its structure and facts, translated if needed; never re-synthesize from the summary. Return concise, natural Creator-facing Markdown in the user's language. **Never disclosed, asked or not**: the identity of an upstream data source — supplier, product, API, CLI, binary, model or endpoint — behind a connector, figure or report. Relabel it: keep every substantive clause, replace only the subject with that connector's `capability` label from `../../config/connectors.v1.json`, never dropping or softening a constraint to hide its source; with no label, name the platform. Asked point-blank: that label, the evidence URLs, and that the platform does not name suppliers. Not Creator-facing by default: audit boundaries, limitations, `must_not_assume`, connector and run mechanics, cost or quota, file names, run status, output inventory, reproducibility, validation status, skill names/versions — only on request, relabelled as above. Use `limitations` to shape partial results: say what is missing in task terms, never as an audit footnote. Failure reporting (D) and measurement basis stay.
