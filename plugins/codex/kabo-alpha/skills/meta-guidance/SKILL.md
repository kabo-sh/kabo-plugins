---
name: meta-guidance
description: Routing and orchestration rules for Kabo skills (search, confirm, download, verify the signature, execute, degrade). Read when triggered by the $analyze entry point or a Kabo-related task; it is not a user-facing command itself — the user-side entry point is $analyze.
# This file is the fallback for when dynamic guidance fails signature verification or the client is offline; the body below the Codex deltas is a verbatim snapshot of that server-side version.
# It must stay in step with the server's current guidance version — a cross-repo test enforces that, and falling behind turns it red.
# 19 = the client-side fast path (skill-unpack --verify, execution: pipeline, execution-conventions.md); publish the same body server-side before merging to main.
kabo_guidance_snapshot: 19
---

## Codex client deltas (these override the mechanics in the snapshot below wherever they conflict)

The snapshot is written for the Claude Code client. Everything about routing, evidence and honest degradation applies as-is; only these mechanics differ here:

- **Data root**: `$KABO_CODEX_DATA`, falling back to `~/.kabo/codex`. The cache is `<data root>/skill-cache/<id>/<version>/` and the revocation marker `<data root>/skill-cache/<id>.disabled`. Every `~/.kabo/<file>` the snapshot names lives under this root here: `<data root>/plugin-root` (one line, written by SessionStart), `<data root>/execution-conventions.md`, `<data root>/meta-guidance.current.md`, `<data root>/revocation-sync.json`, `<data root>/onboarding-profile.json`.
- **Run work directory**: `<data root>/work/<run-id>/`, reserved by `<plugin-root>/bin/kabo-run-dir --skill <skill dir>` (exclusive mkdir; `owner/`, `snapshot/`, `analysis/`, `report/` at 0700, files 0600; `run-manifest.json` opened in status `running`). Everything a downloaded skill writes goes there — analyzer `--output`, `--output-dir`, rendered reports. Never inside `<data root>/skill-cache/...`: `skill-verify` recomputes the checksum of every non-dot file under a skill directory, so one stray output makes that skill fail `checksum_mismatch` on its next run. `skill-gc` reclaims run directories on the same 14-day TTL as the cache, and `$kabo-logout` clears them.
- **Tools are not on PATH**: resolve the plugin root two levels up from this file and call `<plugin-root>/bin/skill-unpack`, `<plugin-root>/bin/skill-verify`, `<plugin-root>/bin/kabo-run-dir` and `<plugin-root>/bin/kabo-run-pipeline` by absolute path. The local plugin version that the red lines compare `min_plugin_version` against is `.codex-plugin/plugin.json` under that plugin root.
- **Download-to-unpack bridge** (fetch and verify in one stream): `registry_skill_download` returns a large structured object; it is not a shell argument and a bare PTY stdin stream can be truncated at the terminal's canonical-input boundary. Download, unpack and verify inside one `functions.exec` orchestration: JSON-stringify `download_result.structuredContent`, escape every non-ASCII UTF-16 code unit as `\uXXXX` (one backslash in the resulting JSON text) so its JavaScript length is also its exact byte count, start an echo-free raw PTY running `stty raw -echo && dd bs=1 count=<exact-byte-count> status=none | '<plugin-root>/bin/skill-unpack' --verify - '<data-root>/skill-cache'`, then send the payload with `tools.write_stdin` in chunks of at most 16 KiB. `dd` closes the pipe after the exact count; do not send an EOF character. Shell-quote the resolved absolute paths, but never interpolate package content into the command. `skill-unpack --verify` writes the cache directory, prints the `Written:` line and the `manifest:` digest (`execution`, `required.tools`, `min_plugin_version`, `skill=<id>@<version>`), then runs `skill-verify` on the new directory with the network revocation check and exits with its code — the bridge command's exit status is the verification result, and no separate `skill-verify` step follows it. A cache hit skips the download and runs `'<plugin-root>/bin/skill-verify' <skill dir>` once instead. Never stringify, print, `echo`, base64-encode, or place the package in a shell command/argument; never start `skill-unpack --verify -` without the exact-count producer already waiting; and never redownload merely because local transport or unpacking failed. A bridge/unpack failure is one local installation failure: stop and report it without executing the Skill.
- **Authorization** uses native host OAuth. The recommended compatibility form is `codex mcp login kabo --scopes openid,offline_access,account:read,registry,telemetry,data`; the current platform also supports bare `codex mcp login kabo`, while the explicit form pins the required Kabo permissions across host versions. If `--scopes` is supplied, do not trim that list: without `offline_access` renewal stops, and without `registry`/`telemetry`/`data` the platform tools 403. The snapshot below names another entry point because one signed guidance document serves both clients: `/kabo-login` is the Claude variant's terminal device login and **does not exist here**. It does not apply; `$kabo-login` walks a user through the Codex flow, and this client stores no credential of its own. The snapshot's "a new session picks the sign-in up on every host" is the part that does apply here. For each shared manifest name such as `mcp__plugin_kabo-alpha_kabo__data_connector_run`, take the suffix after the final `__` and construct the exact Codex callable `mcp__kabo__<suffix>` (`mcp__kabo__data_connector_run` in this example). A same-suffix callable in any other namespace is not Kabo and must be rejected; do not rewrite the shared manifest.
- **Execution conventions are a file here too**: SessionStart writes `<data root>/execution-conventions.md` (Section C of the body in force) and `<data root>/meta-guidance.current.md` (that whole body) on every session start, offline included — from the signature-verified dynamic guidance, otherwise from this static file. The snapshot's `~/.kabo/execution-conventions.md` is that file. Pass the path to whoever executes; paste Section C verbatim only if the file is missing. The runner treats it as winning over its own SKILL.md where they conflict, so a platform-side change reaches this client without a plugin release.
- **No envelope staging on this host**: Codex has no PostToolUse hook (`hooks/hooks.json` is SessionStart only), so the `kabo:` line the snapshot mentions never appears and nothing is ever staged. Whoever executes — this task in `pipeline` mode, the runner in `subagent` mode — writes each completed connector response byte-for-byte to `<data root>/work/<run-id>/snapshot/envelope-NN.json` (numbered in request order) before the POST step, and calls `kabo-run-pipeline` **without** `--staging`; `{envelopes}` then expands to those files. Never abridge an envelope: the hand-written copy is the run's audit record and the analyzer's input, and every field dropped to save tokens is evidence the report can no longer stand on.
- **Pipeline dispatch runs in this task**: `execution: pipeline` → Read the skill's SKILL.md → `'<plugin-root>/bin/kabo-run-dir' --skill <skill dir>` → the connector calls the SKILL.md names in one turn → write the envelopes → one `'<plugin-root>/bin/kabo-run-pipeline'` call with every deterministic step as a `--step` argument, placeholders bare → Read the report under `<data root>/work/<run-id>/report/` → reply per E. The full turn sequence and the placeholder rules are in `$analyze`.
- **Subagent dispatch** (`execution: subagent`): resolve the sibling runner instruction file at `<plugin-root>/skills/skill-runner/SKILL.md`, then hand the task to a Codex subagent with that absolute path as `runner_skill_path` and require it to read that file completely before executing the downloaded Skill. Do not rely on `$skill-runner` being visible in the isolated subagent's Skill catalog: it is intentionally not implicitly invocable. If the deployment installs the `kabo-skill-runner` custom-agent profile, select it. Dispatch with no inherited conversation turns (`fork_turns: "none"`), because the task payload is the complete execution contract and inheriting the main thread only increases model context. The payload carries ① the skill's local path ② the task summary + the catalog readiness note ③ the path `<data root>/execution-conventions.md`, plus the resolved `data_root`, `run_root: <data root>/work`, and the user's requested `delivery_language`; do not let the isolated runner infer any of them from its current directory or source content. `${CLAUDE_PLUGIN_ROOT}` and the Claude-only `~/.kabo/plugin-root` directory in the snapshot both mean the Codex `<plugin-root>` recorded as one line in `<data root>/plugin-root`; pass the resolved absolute path, never either Claude placeholder literally. The runner does not run `skill-verify`: the bridge verified the skill, and `kabo-run-pipeline` performs the hygiene check and the `--local-only` pass.
- **Wait without model work**: after dispatch, wait for the runner to finish. Do not send progress questions or create a model continuation solely to poll it; only intervene after an explicit failure or timeout.
- The Codex runner is a behavioural constraint, not an enforced tool allowlist: that is never a reason to weaken signature verification, revocation, the `required` checks, or the work-directory rule above.
- **Validated report passthrough**: when the runner's validated `creator_report` already matches the user's language, return that file body verbatim. Do not re-title, summarize, reorder, shorten, expand, or add a measurement paragraph. Translate only when the report language differs, while preserving its headings, paragraph order, links and facts.

# Kabo skill routing (meta-guidance)

Routing and orchestration only; details live in each downloaded SKILL.md.

## A. Triggering and dispatch

Always route these creator-data needs through this flow — never from prior knowledge: public evidence collection (YouTube search, public channel/video metrics, comments, window trending), breakout analysis and ideation (channel-relative outliers, Hook/structure/CTA breakdowns, evidence-backed topics), channel research and benchmarking, cross-platform creator discovery (Instagram Reels).

One well-defined need → single-skill flow; independently deliverable sub-goals → B.

## Single-skill flow (in order, no skipping)

1. **Search**: `registry_skill_search` by capability keywords; optional tag filter.
2. **Confirm**: list each hit's name/description/version/permissions and wait for the user's choice.
3. **Fetch and verify, one step**: `~/.kabo/skill-cache/<id>/<version>/` present → skip the download (`skill-verify <skill dir>` once is then the run's verification); `<id>.disabled` → platform-revoked: stop and tell the user. Otherwise `registry_skill_download` (SkillPackage JSON) → `skill-unpack --verify <file|->` (on PATH): prints the manifest digest (`execution`, `required.tools`, `min_plugin_version`) and runs `skill-verify` once, with the network revocation check. Never run `skill-verify` again in this run.
4. **Readiness**: only when `required.tools` names a `data_connector_*` tool → `data_connector_catalog` once (large; the host may persist it to a file — read only the connectors SKILL.md names) and keep a short readiness note (connector, `ready`, operations `implemented`) for whoever executes. Not `implemented` / not `ready` = **platform-side gap** — relay it and wait.
5. **Dispatch** by `execution` in `manifest.json` — a string, or `{default, operations: {<operation>: mode}}` (pick the mode of the operation the request maps to). `pipeline` → the main agent executes, no skill-runner: Read SKILL.md; `kabo-run-dir --skill <dir>`; the connector calls SKILL.md names in **one** turn (the PostToolUse hook stages each envelope and prints a `kabo:` line naming the staging directory); then **one** `kabo-run-pipeline` call with every deterministic step (assemble → analyze → validate → render → validate) as `--step` arguments. `subagent` → spawn **skill-runner** with ① the skill's local path ② a task-context summary (it cannot read this conversation) + the readiness note + the staging-directory convention ③ the path `~/.kabo/execution-conventions.md` (SessionStart writes it) — paste Section C verbatim only if that file is missing. `inline` → read that SKILL.md here.
6. **Deliver** per Section E.

## B. Composite orchestration

1. Split into N sub-requests, each with an **independent** `registry_skill_search` query by capability keywords — never assume names.
2. Search in **parallel**; best match by description/tags/required; no match → "**no coverage**", never a force-fit.
3. Selected skills run steps 3–4; verification failures and revocation hits never execute; an unready or unimplemented connector is a platform-side "**missing dependency**". Permissions shown before first use.
4. Dispatch by `execution` as above.
5. Merge into **one unified deliverable** per Section E; report failed or missing sub-requests in task terms (partial / no coverage / verification failed / missing dependency / execution failed).
6. Check coverage against the **original request**; restate gaps as new sub-requests (say what each round changes; the user can stop anytime), back to step 1 — **at most 3 rounds**; report remaining gaps honestly.

## Platform tools unavailable

Platform MCP tools (`mcp__plugin_kabo-alpha_kabo__*`) invisible or all failing → have the user run `/kabo-login` (terminal device login); a new session then picks the sign-in up on every host. Never route them to the host's OAuth prompt for `kabo`; never read, print, or shell-assemble an Authorization header — the plugin reads the local credential.

## Red lines

- Matching goes by what `registry_skill_search` returns — capability directions, not a skill list; no hit means no hit, never fabricate.
- `skill-verify` failure (exit ≠ 0) or a revocation hit → never execute; say why.
- `skill-verify` runs once per skill per run (inside `skill-unpack --verify`); the only other verification is `kabo-run-pipeline`'s built-in `--local-only` hygiene check.
- `skill-verify` failures append `KABO_VERIFY_FAIL` events listed at session start; call `telemetry_report_usage` once per `event_id` — idempotent; on failure drop it, never block the user.
- Unavailable `required.tools` → tell the user and stop (composite: "verification failed"); never fabricate data.
- `min_plugin_version` above the local version (`.claude-plugin/plugin.json` under `~/.kabo/plugin-root`) → advise upgrading and stop; `skill-verify` rejects it anyway.

## C. Execution conventions for data-plane skills

> Pass this section to skill-runner as the file `~/.kabo/execution-conventions.md` (SessionStart writes it); when the dispatch mode is `pipeline` these conventions bind the main agent directly.

Every fetch runs **on the platform**: Kabo holds the credentials, the user configures nothing. SKILL.md describes a local Python path; translate it:

**Readiness once per run.** `data_connector_catalog` by the dispatcher (its readiness note travels with the task); the runner calls it only when no note came. Connectors report `ready`, operations `implemented`. Short of both → stop that evidence path with the response's `setup_hint`, not at fetch time.

**Path mapping.** `../../config/`, `../../schemas/`, `../../scripts/` sit under `${CLAUDE_PLUGIN_ROOT}/creator-research/` (root in `~/.kabo/plugin-root`), **not** two levels above the skill cache; in `kabo-run-pipeline` steps that is `{cr}/`, `${PLUGIN_ROOT}` is `{plugin}`, the skill's own `scripts/` is `{skill}/scripts/`, outputs go to `{snapshot}` / `{analysis}` / `{report}`. Missing → the plugin is outdated: say so, don't guess.

**Never run `scripts/preflight.py` or `scripts/run_connector.py`** — neither ships; `required.tools` plus the catalog gate dependencies. Call `data_connector_run` with the `connector_id`/`operation` SKILL.md names literally, `params` from its evidence plan and the catalog's `params_schema`; consult `../../config/connectors.v1.json` only to relabel a non-empty `limitations` array. `max_provider_requests` is not an input, no wrapper contract per skill, a request file is never hand-written.

- **Pipeline mode**: connector calls come from the SKILL.md's evidence plan, issued in one turn; every deterministic step runs inside one `kabo-run-pipeline` call; the model never retypes an envelope.

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
