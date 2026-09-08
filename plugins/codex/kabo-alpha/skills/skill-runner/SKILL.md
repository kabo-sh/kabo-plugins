---
name: skill-runner
description: Execute a downloaded local skill that has passed Kabo's skill-verify. For explicit use only by the Codex subagent that meta-guidance dispatches; the input must contain the skill's absolute path, the task summary, the parameters, and the expected output. Not for unverified skills or ordinary tasks.
---

# Kabo Skill Runner

You run **verified** Kabo skills whose `execution` is `subagent` — those with a semantic pass in their sequence. Deterministic skills (`execution: pipeline`) run as one `kabo-run-pipeline` command in the main task and never reach you.

## Input requirements

The task must explicitly provide (you cannot see the main conversation; if something is missing, stop and return what is missing — do not guess at its content):

1. The absolute path of the verified skill: `<data root>/skill-cache/<id>/<version>/`.
2. A summary of the user's task plus the required parameters.
3. The expected output form.
4. The path `<data root>/execution-conventions.md`: Section C of the platform's guidance, written by SessionStart. Read it first; it **wins** wherever it conflicts with this file — it updates faster than the plugin version. Text the dispatcher pasted instead (only when that file is missing) wins over the file. Neither present → follow this file.
5. An optional catalog readiness note (connector, `ready`, operations `implemented`): when present, do not call `data_connector_catalog`.

If any one of the first three is missing, stop and return what is missing.

## Execution discipline

1. Resolve the plugin root two levels up from this `SKILL.md` path. An attached cross-client convention may name `${CLAUDE_PLUGIN_ROOT}` or the Claude-only `~/.kabo/plugin-root` directory; on Codex these are path placeholders, not literal locations. Normalize both to this resolved plugin root (which is also recorded as one line in `<data root>/plugin-root`). Inside a `kabo-run-pipeline` step both are the `{plugin}` placeholder.
2. **Already verified.** The dispatcher verified this skill moments ago — inside the download-to-unpack bridge (`skill-unpack --verify`), or with one `skill-verify` run on a cache hit. Do not run `skill-verify` yourself, before or after. The post-run hygiene check (no `__pycache__`, `*.pyc` or `*.pyo` under the skill) and the `--local-only` re-verification are performed by `kabo-run-pipeline`; a red result there is a failed run. Never delete or repair anything in the signed cache.
3. Read `manifest.json` and `SKILL.md` in the target directory, plus only the references or schemas the SKILL.md explicitly requires for the current operation. Do only what the SKILL.md says: follow its steps and output template strictly and do not extend beyond the task. Do not inspect implementation-source files merely to understand a verified script before running its documented command; read source only when the SKILL.md explicitly requires it, the user requested code inspection, or a step failed and that source is needed to diagnose the failure.
4. Call only the Kabo MCP tools declared in `manifest.required.tools`; external data must come from those tools — never fabricate numbers. Judge by whether the tool is **actually callable**, not by whether its name matches the manifest entry verbatim. For each shared manifest name, take the suffix after the final `__` and construct the exact callable `mcp__kabo__<suffix>`; for example, `mcp__plugin_kabo-alpha_kabo__data_connector_run` maps only to `mcp__kabo__data_connector_run`. A callable with the same suffix in any other namespace is not Kabo and must be rejected. Apply this exact mapping to the generic `data_connector_*` family (`data_connector_run`, `data_connector_batch_run`, `data_connector_catalog`, `data_connector_job`) and the platform research tools for Instagram/YouTube candidate collection and enrichment (`collect_instagram_trend_candidates`, `enrich_instagram_shortlist`, `collect_youtube_trend_candidates`, `enrich_youtube_shortlist`). If a required tool is genuinely not callable, stop immediately and name it; do not edit the shared manifest. The sole derived exception is `data_connector_job`, under the deferred-jobs rule below.
5. Use Bash only for `<plugin-root>/bin/kabo-run-dir --skill`, the `python3 --version` prerequisite check, writing the envelope files described under POST, and `<plugin-root>/bin/kabo-run-pipeline`; the target skill's own `scripts/` and the plugin's own `creator-research/scripts/` run only as `--step` arguments inside the pipeline. No other system operations and no access to unrelated paths. Never hit an external API from Bash — no curl, web search or prior knowledge in place of a tool; if a call fails, say so plainly instead of filling the gap with fake data. Write **only** inside this run's work directory (see "Work directory" below). **Never** write inside the skill cache directory: `skill-verify` recomputes the checksum of every non-dot file under the skill directory, so a single analyzer output left there makes the next run of that skill fail with `checksum_mismatch`.
6. Return a concise structured summary of about 300 tokens at most (template below): skill name/version, completion status, conclusions, and each file as **run-id plus its path under the run directory** (for example `20260814T093012Z-3f9a1c02 → analysis/owner-account-analysis.json`), never as a full filesystem path. The main agent resolves these paths under the data root; the summary is relayed off the machine, and a home directory spells out the account name on it. **Owner-account results carry no numeric values in the summary** — state the conclusion and name the file that holds the numbers; the figures stay in the work-directory JSON. Public-evidence figures may be quoted, always with their window, baseline, sample size and source. Do not dump the intermediate process. Name the rendered creator-facing report on its own `creator_report: <run-id> → report/<file>` line, copied from the pipeline output: the main agent's reply body is that file (guidance Section E), so a summary without this line leaves the run undeliverable.

## Work directory

Every artifact this run produces goes in one place, atomically reserved before the first fetch or script runs:

- Root: `$KABO_CODEX_DATA` if set, otherwise `~/.kabo/codex`; the run directory is `<root>/work/<run-id>/`, where `<run-id>` is a UTC compact timestamp plus 8 hex characters (for example `20260814T093012Z-3f9a1c02`).
- Reserved once by `<plugin-root>/bin/kabo-run-dir --skill <skill dir>` in PRE, and the run id it prints is the only one you use. The helper reserves the run directory with an exclusive mkdir, creates its `owner/`, `snapshot/`, `analysis/`, and `report/` subdirectories at mode 0700, and opens `run-manifest.json` in status `running`. Never invent, accept from another run, reopen, or reuse a run id, and never replace this command with `mkdir -p`; concurrent runs must not share a path.
- Steps write only through `{snapshot}`, `{analysis}`, `{report}` and `{owner}`; the pipeline runs them from the run directory under `umask 077` with `PYTHONDONTWRITEBYTECODE=1` (so imports cannot create `__pycache__` inside the signed skill) and hardens the run directory to 0700/0600 afterwards — never run `chmod`, `find` or bare `python3` yourself; the only `python3` you launch is `python3 --version` in PRE. A semantic pass writes its file under `<run dir>/analysis/`, nowhere else.
- The envelope files you write in POST go under `<run dir>/snapshot/`, written under `umask 077` in the same command so they land 0600.
- Never write anywhere else — not the skill cache, not the plugin directory, not the working directory you happen to start in.
- Report each file as `<run-id> → <path under the run directory>`; the main agent resolves it under the data root without exposing a machine-specific home directory.

## Fixed sequence: PRE, FETCH, POST

**PRE** — one Bash call before any fetch; the first output line is the run id. No `python3` → stop and say so (shipped scripts are stdlib-only Python 3 — no pip, no third-party import, no network; never reimplement one or substitute an interpreter):

```bash
'<plugin-root>/bin/kabo-run-dir' --skill <skill dir> && PYTHONDONTWRITEBYTECODE=1 python3 --version
```

**FETCH** — every connector call the SKILL.md's evidence plan names, in one assistant turn where dependencies allow: independent read-only calls go together (`data_connector_batch_run` for two to four when actually callable, else individual `data_connector_run` calls in the same turn; batching changes only transport scheduling — preserve every connector id, operation, complete `params` object, response envelope and request order — and never covers pagination, deferred-job polling, retries, refreshes, repeated sampling or writes); a call that feeds another goes first. Within one run, reuse a completed response only when `connector_id`, `operation` and the complete `params` object are identical — never for pagination, polling, a non-completed response, an explicit retry or refresh, repeated sampling the SKILL.md requires, or any operation that may write external state. No `kabo:` line follows a call on this host (Codex has no PostToolUse hook, so nothing is staged); the response you hold **is** the artifact.

**POST** — two parts, in this order:

1. **Write the envelopes.** Give every distinct successful request its own numbered file — `<run dir>/snapshot/envelope-01.json`, `envelope-02.json`, ... in request order — holding the complete response byte-for-byte as the tool returned it. Nothing stages an envelope on this host, so this hand-written copy is the run's audit record and the analyzer's input: **never retype it from memory in shortened form, never re-serialize it with fields dropped, never paraphrase or abridge it.** Every field dropped to save tokens is evidence the report can no longer stand on. A large or truncated assistant-visible display is not a failed fetch and never authorizes replacing earlier successful requests with one combined fallback query; never reissue a completed request. Write with `umask 077` in the same command, one command per envelope or one for all of them. In your own messages expose only `connector_id`, `operation`, `status`, `limitations`, `retrieved_at` and the run-relative path — never a complete envelope.
2. **One `kabo-run-pipeline` call** carrying every deterministic step the SKILL.md documents, in its order, as `--step` arguments, without `--staging` (there is nothing to drain on this host; the flag stays supported for hosts that stage). The pipeline runs the steps from the run directory stopping at the first failure, checks hygiene, hardens, verifies `--local-only`, finalizes `run-manifest.json`, and prints `step n/N ok <secs>s <command>` per step, the `creator_report: <run-id> → report/<file>` line and `run-manifest: <run-id> → run-manifest.json` (a `drained=<n>` line appears only when `--staging` was given). Example for a SKILL.md documenting assemble → analyze → validate → render → validate:

```bash
'<plugin-root>/bin/kabo-run-pipeline' --run-id <run-id> --skill <skill dir> \
  --language <tag> --param handle=<handle> \
  --step 'python3 {cr}/scripts/build_public_snapshot.py {envelopes} --platform youtube --window auto --output {snapshot}/public-content-snapshot.json' \
  --step 'python3 {cr}/scripts/account_analyzers.py {snapshot}/public-content-snapshot.json --operation all --maturity-days 2 --focus-handle {param.handle} --output {analysis}/account_analysis.json' \
  --step 'python3 {skill}/scripts/diagnose_reach_drop.py {analysis}/account_analysis.json --output {analysis}/reach_drop_assessment.json' \
  --step 'python3 {skill}/scripts/validate_reach_drop.py {analysis}/reach_drop_assessment.json' \
  --step 'python3 {skill}/scripts/render_reach_drop.py {analysis}/reach_drop_assessment.json --language {language} --output {report}/REACH_DROP_DIAGNOSIS.md' \
  --step 'python3 {skill}/scripts/validate_creator_report.py {report}/REACH_DROP_DIAGNOSIS.md --assessment {analysis}/reach_drop_assessment.json --language {language}'
```

Translating a SKILL.md command: `${PLUGIN_ROOT}` (and `${CLAUDE_PLUGIN_ROOT}` in an attached convention) → `{plugin}`; `../../` (only where the body literally writes it) → `{cr}/`, which is `{plugin}/creator-research`, never two levels above the skill cache; the skill's own `scripts/` → `{skill}/scripts/`; outputs → `{snapshot}`, `{analysis}` or `{report}`; `{envelopes}` = one `--envelope <path>` per `snapshot/envelope-NN.json` you wrote, in numeric order; `{run}`, `{owner}`, `{language}`, `{param.<key>}` cover the rest. Placeholders are written bare, never inside quotes: the pipeline single-quotes every value for `/bin/sh` itself, so `--focus-handle "{param.handle}"` hands the analyzer `'@handle'` with the quote characters as part of the handle, and it never matches the account. An unknown placeholder, or a placeholder inside shell quotes, fails before any step runs. A `step n/N FAILED exit=<code>` line or exit 1 is a failed run — name the step and what is missing; do not deliver, do not rerun with different data.

Rules that hold across the three phases:

- **`--window auto`** to `build_public_snapshot.py` when the user requested no time window and the evidence plan analyzes every returned item; it derives the exact min/max publish timestamps while assembling. Never inspect envelopes or run Python snippets to discover those bounds. An explicit user- or Skill-specified window always wins and is passed unchanged.
- **No `--help` probing**: when the SKILL.md documents a script's complete invocation, it runs directly as a step; consult CLI help or additional schemas only after a documented invocation fails because its contract is unclear. This relaxes no schema or validator gate the SKILL.md requires.
- **Read only what the SKILL.md requires** (manifest, SKILL.md, the references it names) and do not preload unrelated Report/Profile or implementation schemas. No model turn solely to report progress, re-read a successful artifact, or choose a command the SKILL.md already fixes; report progress from completed tool boundaries.
- **Semantic passes: exactly those the SKILL.md explicitly requires**, where it places them — never added, removed, split, merged or changed. A pass between two deterministic stages splits POST: one pipeline call for the stages before it, the pass (inputs from disk under the run directory, result into `{analysis}`), then a second pipeline call for the rest, both without `--staging` — the only case with a second pipeline call.

These rules change no Connector selection or parameters, evidence contents, Analyzer behavior, schemas, validation gates, rendered output, failure semantics, or user-visible conclusions; they remove redundant reads, duplicate completed requests, and avoidable orchestration turns.

## Data-plane skills (those with `data_connector_*` in `required.tools`)

Every fetch runs **on the platform**: Kabo holds the credentials and the user configures nothing. These skills' `SKILL.md` is published as-is and describes a local Python execution path. Translate it as above and do not run it literally:

- **Readiness**: the readiness note settles it; only when none was attached, call `data_connector_catalog` once (no arguments). It reports each connector's `ready` state and each operation's `implemented` flag. Anything short of both is a **platform-side gap** — report it with the response's `setup_hint` and stop the corresponding evidence-collection path there; do not get all the way to data fetching before the user finds out, and never send the user to configure a key. This does not replace the `required.tools` availability check — do both.
- **Only when the SKILL.md body literally contains `../../`**: `../../config/`, `../../schemas/`, and `../../scripts/` refer to the same-named directories under `<plugin-root>/creator-research/` — `{cr}/` inside a step — **not** two levels above the skill cache directory. Bodies that never write `../../` resolve their own `scripts/` and `references/` relative to the skill directory itself (`{skill}/`); do not redirect those into the plugin.
- **Do not run** `python3 ../../scripts/preflight.py`: it no longer ships and must never be run. It probed local provider keys and local binaries, and there are none of either left on this machine. Whether dependencies are satisfied is settled by the `required.tools` check in discipline item 4 plus the readiness check above. This ban names one file: `../../scripts/preflight.py`. It does **not** extend to `scripts/preflight_artifacts.py` bundled inside a skill package — that one must run, as a step; it records the sha256 of each upstream artifact and is the provenance gate for skills derived from another skill's output.
- **Connector and operation are the literal names in the SKILL.md** (`youtube-public/list_channel_uploads` → `connector_id` `youtube-public`, `operation` `list_channel_uploads`); `params` come from its evidence plan, shaped by that operation's `params_schema` in the catalog. `python3 ../../scripts/run_connector.py` no longer ships either: replace it with **a direct call to `data_connector_run`**, whose response keeps the `status` / `limitations` / `provider` fields — stored as received, relabelled before you report them (see below). Consult `../../config/connectors.v1.json` only to relabel a non-empty `limitations` array. **No wrapper contract ships per skill** — do not go looking for a `wrappers/` directory; it was retired with the V1 skills. `max_provider_requests` is not an input; the catalog owns it. A request file is never hand-written. When the tool really is unavailable, stop honestly per discipline item 4 and say which one is missing; **never** substitute the shell, curl, native web search, or existing knowledge and then claim the step is done.
- **Deferred jobs.** Some operations run asynchronously server-side: `data_connector_run` then returns a job resource instead of evidence (the evidence envelope is `null` and a `job_id` is present). Poll that job with the `data_connector_job` tool until it reaches a terminal state, then read the evidence envelope from the finished job. Manifests written before this tool existed name only `data_connector_run` in `required.tools`; treat `data_connector_job` as that tool's data-plane companion, allowed whenever a run it started answers with a job. Polling is not a licence to fetch anything else while waiting, and a job still running at reporting time is **pending** evidence, never absent evidence.
- **Connector return statuses.** Apply this matrix exactly; only the four named partial/gap statuses are non-success statuses that are **not** tool failures:

  | Envelope status | Classification | Required action |
  | --- | --- | --- |
  | `completed` | Success | Persist and use the completed evidence. |
  | `completed_partial` or `partial` | Usable partial result; not a tool failure | Persist the returned evidence, continue only under the target SKILL.md's partial semantics, and report every resulting gap. Do not retry or switch data sources. |
  | `blocked_setup` | Platform-side gap; not a tool failure | The **platform** is missing that credential and the user cannot fix it. Stop that evidence path, then apply the target SKILL.md's partial/gap semantics to anything else deliverable. Do not retry or switch data sources. |
  | `unsupported` | Platform-side gap; not a tool failure | The operation is not implemented server-side. Stop that evidence path, then apply the target SKILL.md's partial/gap semantics to anything else deliverable. Do not retry or switch data sources. |
  | `failed` | Execution failure | Do not retry, do not switch data sources, do not persist or consume the response as successful evidence, and explicitly report which execution failed. |

  A host/backend tool result marked `isError: true` is likewise an execution failure, never a partial/gap result, even if its text contains a status-like token. Report it and do not retry or switch data sources. Any other unrecognized non-success envelope status is also an execution failure: explicitly report it, do not retry or switch data sources, and never invent partial semantics for it.
- For every usable partial result or platform-side gap, carry the `limitations` array into the output summary **with its meaning intact but never verbatim**. Rewrite each entry by keeping every substantive clause — scope, counts, time window, coverage, cause, and the effect on the conclusions — and replacing only the subject: every supplier, product, API, CLI, binary, model or endpoint name becomes the returning connector's `capability` label in `../../config/connectors.v1.json` (every connector declares one; the connector id the envelope echoes back is the key to look it up under), so an entry reading `The <vendor> outlier endpoint offers no strict region filtering; results may include out-of-region channels` is reported as `the youtube-outlier source applies no strict region filter, so results may include out-of-region channels`. Substitution is the only edit allowed — never drop, merge or soften a limitation to avoid naming its source; where a constraint cannot be stated without an identity, state the constraint and its effect and leave the identity out. The same rewrite covers `provider`, `setup_hint` and any status explanation you pass on; the stored envelope keeps the original text.
- **Four stages, in order, all as steps: assemble → analyze → validate → render.** Never feed a connector envelope straight into an analyzer, and never hand-write a snapshot.
  1. **Assemble.** `{cr}/scripts/build_public_snapshot.py` over **every** successful envelope collected for this evidence plan (`{envelopes}`), producing `public-content-snapshot.v1` under `{snapshot}`. For query-driven requests, pass one matching repeated `--query` in the same order plus requested `--region` / `--language`; never assemble only the last query. Same failure convention as the skill's own scripts: exit 0 or 2, and `{"status":"failed","error":"..."}` on stdout.
  2. **Analyze.** The analyzer the skill's SKILL.md names, with `--output` pointing into `{analysis}`. If that Skill explicitly requires one semantic synthesis followed by a deterministic composer, both remain part of this stage and run in the documented order (the synthesis is the pass that splits POST).
  3. **Validate.** Each validator only on the exact artifact and at the exact point documented by the target Skill. Never infer a validator's input from its filename, and never run a final-Report validator against a snapshot, analyzer intermediate, or synthesis skeleton. Every required validator has to pass; a failure is a failed run — report it, do not deliver the artifact as if it passed.
  4. **Render.** The renderer the skill's SKILL.md names, writing into `{report}`; where the package ships a creator-report validator, run it here, on the rendered creator-facing file — same rule, a red validator is a failed run. This stage is not optional even when the structured objects already validated: the rendered file is the only text the main agent may deliver to the user.

## Evidence and conclusion hard rules

- Collect evidence first, analyze second: any judgment not backed by evidence must be labeled as inference and must not be stated mixed in with the fetched data.
- Private metrics (CTR, watch retention, revenue, Instagram Insights) must come from an owner-authorized data source; never back them out of public view or like counts and present them as that account's real performance.
- Conclusions must carry the time window, baseline, sample size, data source, and fetch time; never promise outcomes like "this will go viral".

## Output summary (about 300 tokens, hard cap)

```
Result: <two to four sentences of conclusions with window, baseline, sample size, source and retrieval time; owner-account results without numbers>
Limitations: <each entry relabelled per the rule above, or "none reported">
Gaps / failures: <platform-side gaps and execution failures in task terms, or "none">
creator_report: <run-id> → report/<file>
Artifacts: <run-id> → snapshot/envelope-01.json, analysis/<file>, report/<file>
```

## Security boundary

- This skill cannot tighten the tools and sandbox the parent Codex session actually provides; treat the constraints above as execution discipline you must follow.
- Do not read or report the transcript, unrelated conversation, raw tool arguments/responses, or final output content as telemetry.
- On permission, network, tool, or script failures, report honestly; do not fill the gap with fake data.
