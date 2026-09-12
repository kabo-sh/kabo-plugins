---
description: Kabo creator research entry point — search platform skills and run them (Instagram or YouTube competitor discovery and content analysis, public account review, named-handle follower-loss or funnel, continue/stop, engagement-rate calculation, monetization threshold gaps, YouTube evidence, breakout-video breakdown, channel benchmarking, cross-platform creator discovery)
argument-hint: "[what to analyze, e.g. why has this channel been growing lately https://youtube.com/@xxx]"
---

The user's analysis request: $ARGUMENTS

Resolve `<data root>` from `$KABO_DATA_ROOT`, falling back to `~/.kabo`; all cache, conventions, plugin-root and work paths below use this resolved root.

Handle this request through the **meta-guidance** routing flow. meta-guidance is this plugin's resident skill and its content is already in the session (the dynamic version injected by SessionStart takes priority; otherwise use the static version bundled in the plugin) — follow it directly, do not invent your own approach.

Flow outline (meta-guidance is authoritative on the details; if they conflict, follow it):

1. **Catalog**: call `registry_skill_search` **once with an empty query**. That lists every skill accessible on this account; read their descriptions and tags and pick the match yourself. Never guess a keyword and never assume or hard-code a Skill id. If you do pass a query it is literal substring matching, so a sentence or a bundle of keywords will not match.
2. **Confirm**: list the matched skills (name / description / version / permissions) for the user and **wait for them to choose** before continuing.
3. **Fetch and verify, one step**: cache check first — `<data root>/skill-cache/<id>/<version>/` already present → skip the download (`skill-verify <skill dir>` once is then this run's verification); `<data root>/skill-cache/<id>.disabled` → platform-revoked, stop and say so. Otherwise `registry_skill_download` → `skill-unpack --verify <file>`: it writes the cache directory, prints one `manifest:` digest line (`execution`, `has_pipeline`, `pipeline_operations`, `required.tools`, `min_plugin_version`, `skill=<id>@<version>`) and runs `skill-verify` once, with the network revocation check. Exit ≠ 0 → **never execute**; say why; the plugin handles `KABO_VERIFY_FAIL` telemetry as meta-guidance directs, with no agent relay. Do not run `skill-verify` again in this run; the only other verification is `kabo-run-pipeline`'s built-in `--local-only` hygiene check.
4. **Readiness once**: reuse this search's `connectors_ready: true` note. Otherwise call `data_connector_catalog` once: use `skill_id` if search returned non-empty `required.connectors`; for older skills read SKILL.md and use its explicit `connector_ids` directly. Empty never proves readiness. Unready/unimplemented is a platform-side gap; stop that evidence path. Pass the note and relevant params schemas to the executor.
5. **Dispatch** by the selected pipeline array: `pipeline_operations[operation]` overrides `pipeline` when the operation has its own entry. A non-empty array routes here; an empty override disables it. Use the digest's `has_pipeline` / `pipeline_operations` to find available fast paths, and SKILL.md to select the operation. Otherwise follow the unchanged `execution` string:
   - `pipeline` → **you** execute, no skill-runner (turn sequence below).
   - `subagent` → spawn skill-runner with ① the skill path ② a task summary + the catalog readiness note + the staging-directory convention (every connector call is followed by a hook line starting `kabo:` that names the staging directory) ③ the path `<data root>/execution-conventions.md` (written by SessionStart) — paste Section C verbatim only if that file is missing.
   - `inline` → read that SKILL.md here and follow it.
6. **Deliver**: per meta-guidance Section E — the reply body is the creator-facing report named on the `creator_report:` line (printed by `kabo-run-pipeline`, and repeated by skill-runner in its summary), relayed as-is (translated to the user's language if needed). It is named run-relative — `creator_report: <run-id> → report/<file>` — because an absolute path spells this machine's account name into a summary that is relayed off it. **Resolve it under `<data root>/work/<run-id>/`.** Without that root the path is unresolvable: a real run spent three minutes searching the filesystem for the file name and turned up same-named reports from other projects and older test rounds, any of which it could have delivered as this run's result. Skill/version, quota, truncation, and the `limitations` detail are run mechanics: keep them out of the reply and give them only when the user asks; what a limitation makes missing is stated in task terms inside the delivery itself.

## Pipeline dispatch — the main agent's turn sequence

For a data-plane skill with a non-empty pipeline array for the selected operation, the whole run is five tool turns and a reply. `<plugin root>` is `${CLAUDE_PLUGIN_ROOT}`, also recorded in `<data root>/plugin-root`.

1. **Read** `<skill dir>/SKILL.md` (and only the references it names). Take from it the evidence plan — the literal connector/operation names and params — and the selected operation. The signed manifest supplies the commands.
2. **Bash**: `"<plugin root>/bin/kabo-run-dir" --skill <skill dir>` — stdout is the run id.
3. **Connector calls, one assistant turn**: every `data_connector_run` (or `data_connector_batch_run`) the SKILL.md names, together; a call whose output another needs (a handle resolve) goes first, the rest in the same turn. The PostToolUse hook stages each envelope and prints a `kabo:` line — note the staging directory it names. Never retype an envelope, and never read one back just to carry it.
4. **Bash, one call**: execute the selected signed array without --step:

   ```bash
   '<plugin-root>/bin/kabo-run-pipeline' --run-id <run-id> --skill <skill-dir> --staging <staging directory> --operation <operation> --language <tag> --param handle=<handle>
   ```

   Omit --operation for the default array. Pass only the parameters its templates require, shell-quoting flag values. Bare placeholders belong inside templates. Calls with dependencies run after their prerequisites; wait for terminal jobs and retrieve the artifact bodies required by SKILL.md before POST.

   Placeholders: `{run}` `{skill}` `{plugin}` `{cr}` (= `{plugin}/creator-research`) `{snapshot}` `{analysis}` `{report}` `{owner}` `{language}` `{param.<key>}` `{envelopes}` (one `--envelope <path>` per drained `snapshot/envelope-NN.json`, in numeric order). Write every placeholder bare: the pipeline single-quotes each value for `/bin/sh` as it substitutes it, so `--focus-handle "{param.handle}"` hands the script `'@handle'`, quote characters included, and `"{analysis}/x.json"` a path that does not exist. `${PLUGIN_ROOT}` in a SKILL.md body is `{plugin}`, `../../` is `{cr}/`, the skill's own `scripts/` is `{skill}/scripts/`; `--window auto` only when the user named no window. The pipeline drains the staging directory, runs the steps in order and stops at the first failure, checks the skill for bytecode, hardens the run directory, verifies the skill `--local-only`, finalizes `run-manifest.json`, and prints `step n/N ok` lines, `drained=<n>`, `creator_report: <run-id> → report/<file>` and `run-manifest: <run-id> → run-manifest.json`. Exit 1 or a `step n/N FAILED` line is a failed run: say which step failed, in task terms, and do not deliver.
5. **Read** `<data root>/work/<run-id>/report/<file>` from the `creator_report:` line.
6. **Reply** with that file's content per meta-guidance Section E.

In this mode Section C of meta-guidance (on disk as `<data root>/execution-conventions.md`) binds you directly: the envelope-status matrix, the relabelling rule and the never-fabricate rule apply to what you write exactly as they would to skill-runner.

## Boundaries

- When $ARGUMENTS is empty and `<data root>/onboarding-profile.json` does not exist (or exists with `onboarded_at` empty), **run the onboarding flow in `commands/kabo-start.md`** instead of asking an open question — a user with no profile and no stated target is a first-time user.
- When $ARGUMENTS is empty and the profile exists, **do not** guess what the user wants analyzed — ask for the target and the goal (channel / niche / specific video, and what conclusion they want), informed by their profile.
- When the search finds **no** matching skill, say so plainly and describe what the catalog currently covers. **Do not** fall back to native web search or existing knowledge to invent an analysis and deliver it as Kabo output — that is the exact opposite of why this entry point exists.
- Platform tools invisible or all returning 401 → tell the user to run `/kabo-login` first.
