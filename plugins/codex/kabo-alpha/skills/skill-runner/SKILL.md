---
name: skill-runner
description: Execute a downloaded local skill that has passed Kabo's skill-verify. For explicit use only by the Codex subagent that meta-guidance dispatches; the input must contain the skill's absolute path, the task summary, the parameters, and the expected output. Not for unverified skills or ordinary tasks.
---

# Kabo Skill Runner

## Input requirements

The task must explicitly provide:

1. The absolute path of the verified skill.
2. A summary of the user's task plus the required parameters.
3. The expected output form.
4. Possibly an attached "execution conventions" section issued by the platform's dynamic guidance. **It wins** wherever it conflicts with this file — it updates faster than the plugin version. If none is attached, follow this file.

If any one of the first three is missing, stop and return what is missing; do not guess at the main conversation's content.

## Execution

1. Resolve the plugin root two levels up from this `SKILL.md` path.
2. Run `<plugin-root>/bin/skill-verify <skill path>` again; stop immediately on failure.
3. Read `manifest.json` and `SKILL.md` in the target directory.
4. Call only the Kabo MCP tools declared in `manifest.required.tools`; external data must come from those tools — never fabricate numbers. Judge by whether the tool is **actually callable**, not by whether its name matches the manifest entry verbatim: manifests are written with the Claude host's `mcp__plugin_...__` registration prefix, while this host registers the same tools under their bare names (`data_connector_catalog`, `data_connector_run`). Compare the part after the last `__`. If a required tool is genuinely not callable, stop immediately and name it.
5. Use Bash only to run the target skill's own `scripts/` and the plugin's own `creator-research/scripts/`; no other system operations and no access to unrelated paths. Write **only** inside this run's work directory (see "Work directory" below). **Never** write inside the skill cache directory: `skill-verify` recomputes the checksum of every non-dot file under the skill directory, so a single analyzer output left there makes the next run of that skill fail with `checksum_mismatch`.
6. Follow the target `SKILL.md`'s steps and output template strictly; do not extend beyond the task.
7. Return a concise structured summary: skill name/version, completion status, conclusions, and the absolute paths of the files written under the work directory. **Owner-account results carry no numeric values in the summary** — state the conclusion and name the file that holds the numbers; the figures stay in the work-directory JSON. Public-evidence figures may be quoted, always with their window, baseline, sample size and source. Do not dump the intermediate process.

## Work directory

Every artifact this run produces goes in one place, created by you before the first script runs:

- Root: `$KABO_CODEX_DATA` if set, otherwise `~/.kabo/codex`; the run directory is `<root>/work/<run-id>/`, where `<run-id>` is a UTC compact timestamp plus 8 hex characters (for example `20260814T093012Z-3f9a1c02`).
- Create it with `umask 077 && mkdir -p <run dir>/{owner,snapshot,analysis,report}` so directories land 0700 and files 0600. Nothing here is shared between users or runs.
- Pass absolute paths under this directory to every `--output` / `--output-dir` / positional output argument.
- Never write anywhere else — not the skill cache, not the plugin directory, not the working directory you happen to start in.
- Report the absolute paths you wrote back in your summary; the main agent has no other way to find them.

## Data-plane skills (those with `data_connector_*` in `required.tools`)

Every fetch runs **on the platform**: Kabo holds the credentials and the user configures nothing. These skills' `SKILL.md` is published as-is and describes a local Python execution path. Translate it as below and do not run it literally:

- **Readiness first**: call `data_connector_catalog` once (no arguments). It reports each connector's `ready` state and each operation's `implemented` flag. Anything short of both is a **platform-side gap** — report it with the response's `setup_hint` and stop the corresponding evidence-collection path there; do not get all the way to data fetching before the user finds out, and never send the user to configure a key. This does not replace the `required.tools` availability check — do both.
- **Only when the SKILL.md body literally contains `../../`**: `../../config/`, `../../schemas/`, `../../wrappers/`, and `../../scripts/` refer to the same-named directories under `<plugin-root>/creator-research/`, **not** two levels above the skill cache directory. Bodies that never write `../../` resolve their own `scripts/` and `references/` relative to the skill directory itself; do not redirect those into the plugin.
- **Do not run** `python3 ../../scripts/preflight.py`: it no longer ships and must never be run. It probed local provider keys and local binaries, and there are none of either left on this machine. Whether dependencies are satisfied is settled by the `required.tools` check in step 4 plus the catalog check above. This ban names one file: `../../scripts/preflight.py`. It does **not** extend to `scripts/preflight_artifacts.py` bundled inside a skill package — that one must be run; it records the sha256 of each upstream artifact and is the provenance gate for skills derived from another skill's output.
- Replace `python3 ../../scripts/run_connector.py` (which no longer ships either) with **a direct call to `data_connector_run`** — `connector_id` and `operation` come from the skill's `../../wrappers/<skill>/contract.json` and `../../config/connectors.v1.json`, `params` from that operation's `params_schema` in the catalog, and the response keeps the `status` / `limitations` / `provider` fields. `max_provider_requests` is not an input; the catalog owns it. When the tool really is unavailable, stop honestly per step 4 and say which one is missing; **never** substitute the shell, curl, native web search, or existing knowledge and then claim the step is done.
- **Deferred jobs.** Some operations run asynchronously server-side: `data_connector_run` then returns a job resource instead of evidence (the evidence envelope is `null` and a `job_id` is present). Poll that job with the `data_connector_job` tool until it reaches a terminal state, then read the evidence envelope from the finished job. Manifests written before this tool existed name only `data_connector_run` in `required.tools`; treat `data_connector_job` as that tool's data-plane companion, allowed whenever a run it started answers with a job. Polling is not a licence to fetch anything else while waiting, and a job still running at reporting time is **pending** evidence, never absent evidence.
- A response `status` of `blocked_setup` (the **platform** is missing that credential — a server-side gap the user cannot fix) or `unsupported` (not implemented server-side yet) is **not** a tool failure: do not retry and do not switch data sources; deliver the rest under SKILL.md's partial semantics, and carry the `limitations` array into the output summary verbatim.
- **`python3` is a prerequisite.** Every script these skills ship is stdlib-only Python 3 — no pip, no third-party import, no network. Check `python3 --version` once before the first script; if it is absent, stop and say so plainly. Do not reimplement a script's logic yourself, and do not substitute another interpreter.
- **Three stages, in order: assemble → analyze → validate.** Never feed a connector envelope straight into an analyzer, and never hand-write a snapshot.
  1. **Assemble.** Run `<plugin-root>/creator-research/scripts/build_public_snapshot.py` over the envelopes you collected to produce `public-content-snapshot.v1` in the work directory. Same failure convention as the skill's own scripts: exit 0 or 2, and `{"status":"failed","error":"..."}` on stdout.
  2. **Analyze.** Run the analyzer the skill's SKILL.md names, with `--output` pointing into the work directory.
  3. **Validate.** Run the validator the skill ships, even when SKILL.md does not name it: every `validate_*.py` the package ships is one, and every one of them has to pass. A validator that fails is a failed run — report it, do not deliver the artifact as if it passed.

## Evidence and conclusion hard rules

- Collect evidence first, analyze second: any judgment not backed by evidence must be labeled as inference and must not be stated mixed in with the fetched data.
- Private metrics (CTR, watch retention, revenue, Instagram Insights) must come from an owner-authorized data source; never back them out of public view or like counts and present them as that account's real performance.
- Conclusions must carry the time window, baseline, sample size, data source, and fetch time; never promise outcomes like "this will go viral".

## Security boundary

- This skill cannot tighten the tools and sandbox the parent Codex session actually provides; treat the constraints above as execution discipline you must follow.
- Do not read or report the transcript, unrelated conversation, raw tool arguments/responses, or final output content as telemetry.
- On permission, network, tool, or script failures, report honestly; do not fill the gap with fake data.
