---
name: meta-guidance
description: Routing and orchestration rules for Kabo skills (search, confirm, download, verify the signature, execute, degrade). Read when triggered by the $analyze entry point or a Kabo-related task; it is not a user-facing command itself — the user-side entry point is $analyze.
# This file is the fallback for when dynamic guidance fails signature verification or the client is offline; the body below the Codex deltas is a verbatim snapshot of that server-side version.
# It must stay in step with the server's current guidance version — a cross-repo test enforces that, and falling behind turns it red.
kabo_guidance_snapshot: 16
---

## Codex client deltas (these override the mechanics in the snapshot below wherever they conflict)

The snapshot is written for the Claude Code client. Everything about routing, evidence and honest degradation applies as-is; only these mechanics differ here:

- **Data root**: `$KABO_CODEX_DATA`, falling back to `~/.kabo/codex`. The cache is `<data root>/skill-cache/<id>/<version>/` and the revocation marker `<data root>/skill-cache/<id>.disabled`.
- **Run work directory**: `<data root>/work/<run-id>/`, created by the runner with `umask 077` (directories 0700, files 0600). Everything a downloaded skill writes goes there — analyzer `--output`, `--output-dir`, rendered reports. Never inside `<data root>/skill-cache/...`: `skill-verify` recomputes the checksum of every non-dot file under a skill directory, so one stray output makes that skill fail `checksum_mismatch` on its next run. `skill-gc` reclaims run directories on the same 14-day TTL as the cache, and `$kabo-logout` clears them.
- **Tools are not on PATH**: resolve the plugin root two levels up from this file and call `<plugin-root>/bin/skill-unpack` and `<plugin-root>/bin/skill-verify` by absolute path.
- **Authorization** uses native host OAuth. The recommended compatibility form is `codex mcp login kabo --scopes openid,offline_access,account:read,registry,telemetry,data`; the current platform also supports bare `codex mcp login kabo`, while the explicit form pins the required Kabo permissions across host versions. If `--scopes` is supplied, do not trim that list: without `offline_access` renewal stops, and without `registry`/`telemetry`/`data` the platform tools 403. The snapshot below names another entry point because one signed guidance document serves both clients: `/kabo-login` is the Claude variant's terminal device login and **does not exist here**. It does not apply; `$kabo-login` walks a user through the Codex flow, and this client stores no credential of its own. The snapshot's "a new session picks the sign-in up on every host" is the part that does apply here. For each shared manifest name such as `mcp__plugin_kabo-alpha_kabo__data_connector_run`, take the suffix after the final `__` and construct the exact Codex callable `mcp__kabo__<suffix>` (`mcp__kabo__data_connector_run` in this example). A same-suffix callable in any other namespace is not Kabo and must be rejected; do not rewrite the shared manifest.
- **Subagent dispatch**: resolve the sibling runner instruction file at `<plugin-root>/skills/skill-runner/SKILL.md`, then hand the task to a Codex subagent with that absolute path as `runner_skill_path` and require it to read that file completely before executing the downloaded Skill. Do not rely on `$skill-runner` being visible in the isolated subagent's Skill catalog: it is intentionally not implicitly invocable. If the deployment installs the `kabo-skill-runner` custom-agent profile, select it. Dispatch with no inherited conversation turns (`fork_turns: "none"`), because the task payload below is the complete execution contract and inheriting the main thread only increases model context. The payload must also include the resolved `data_root`, `run_root: <data root>/work`, and the user's requested `delivery_language`; do not let the isolated runner infer any of them from its current directory or source content. `${CLAUDE_PLUGIN_ROOT}` and the Claude-only `~/.kabo/plugin-root` directory in the snapshot both mean the Codex `<plugin-root>` recorded as one line in `<data root>/plugin-root`; pass the resolved absolute path, never either Claude placeholder literally.
- **Wait without model work**: after dispatch, wait for the runner to finish. Do not send progress questions or create a model continuation solely to poll it; only intervene after an explicit failure or timeout.
- **Section C travels with the task**: pass it to `$skill-runner` in full, as the snapshot says. The runner treats an attached execution-conventions section as winning over its own SKILL.md where they conflict, so a platform-side change reaches this client without a plugin release.
- The Codex runner is a behavioural constraint, not an enforced tool allowlist: that is never a reason to weaken signature verification, revocation, the `required` checks, or the work-directory rule above.
- **Validated report passthrough**: when the runner's validated `creator_report` already matches the user's language, return that file body verbatim. Do not re-title, summarize, reorder, shorten, expand, or add a measurement paragraph. Translate only when the report language differs, while preserving its headings, paragraph order, links and facts.

# Kabo skill routing (meta-guidance)

Routing and orchestration only; details live in each downloaded SKILL.md.

## A. Triggering and dispatch

Always route these creator-data needs through this flow — never from prior knowledge: public evidence collection (YouTube search, public channel/video metrics, comments, window trending), breakout analysis and ideation (channel-relative outliers, Hook/structure/CTA breakdowns, evidence-backed topics), channel research and benchmarking, cross-platform creator discovery (Instagram Reels).

One well-defined need → single-skill flow; independently deliverable sub-goals → B.

## Single-skill flow (in order, no skipping)

1. **Search**: `registry_skill_search` by capability keywords; optional tag filter.
2. **Confirm**: list each hit's name/description/version/permissions and wait for the user's choice. A `data_connector_*` tool in `required.tools` → `data_connector_catalog` once; an operation not `implemented` or a connector not `ready` is a **platform-side gap** — relay it and wait.
3. **Cache check**: `~/.kabo/skill-cache/<id>/<version>/` → step 6; `<id>.disabled` → platform-revoked: stop and tell the user.
4–6. **Download** (`registry_skill_download` returns the SkillPackage JSON), **unpack** (`skill-unpack <file|->`, on PATH, from temp file or stdin), then **verify** (`skill-verify <skill dir>`).
7. **Dispatch** by `execution` in `manifest.json`: `subagent` → spawn **skill-runner** with ① the skill's local path ② a task-context summary (it cannot read this conversation) ③ Section C in full; `inline` → read that SKILL.md here.
8. **Deliver** per Section E.

## B. Composite orchestration

1. Split into N sub-requests, each with an **independent** `registry_skill_search` query by capability keywords — never assume names.
2. Search in **parallel**; best match by description/tags/required; no match → "**no coverage**", never a force-fit.
3. Selected skills run steps 3–6; verification failures and revocation hits never execute; an unready or unimplemented connector is a platform-side "**missing dependency**". Permissions shown before first use.
4. Dispatch by `execution` as above.
5. Merge into **one unified deliverable** per Section E; report failed or missing sub-requests in task terms (partial / no coverage / verification failed / missing dependency / execution failed).
6. Check coverage against the **original request**; restate gaps as new sub-requests (say what each round changes; the user can stop anytime), back to step 1 — **at most 3 rounds**; report remaining gaps honestly.

## Platform tools unavailable

Platform MCP tools (`mcp__plugin_kabo-alpha_kabo__*`) invisible or all failing → have the user run `/kabo-login` (terminal device login); a new session then picks the sign-in up on every host. Never route them to the host's OAuth prompt for `kabo`; never read, print, or shell-assemble an Authorization header — the plugin reads the local credential.

## Red lines

- Matching goes by what `registry_skill_search` returns — capability directions, not a skill list; no hit means no hit, never fabricate.
- `skill-verify` failure (exit ≠ 0) or a revocation hit → never execute; say why.
- `skill-verify` failures append `KABO_VERIFY_FAIL` events listed at session start; call `telemetry_report_usage` once per `event_id` — idempotent; on failure drop it, never block the user.
- Unavailable `required.tools` → tell the user and stop (composite: "verification failed"); never fabricate data.
- `min_plugin_version` above the local version (`.claude-plugin/plugin.json` under `~/.kabo/plugin-root`) → advise upgrading and stop; `skill-verify` rejects it anyway.

## C. Execution conventions for data-plane skills

> Pass this whole section to skill-runner with the task — it runs isolated and cannot read this guidance.

Every fetch runs **on the platform**: Kabo holds the credentials, the user configures nothing. SKILL.md describes a local Python path; translate it:

**Readiness first.** `data_connector_catalog` once: connectors report `ready`, operations `implemented`. Short of both → stop that evidence path with the response's `setup_hint`, not at fetch time.

**Path mapping.** `../../config/`, `../../schemas/`, `../../scripts/` sit under `${CLAUDE_PLUGIN_ROOT}/creator-research/` (root in `~/.kabo/plugin-root`), **not** two levels above the skill cache. Missing → the plugin is outdated: say so, don't guess.

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
