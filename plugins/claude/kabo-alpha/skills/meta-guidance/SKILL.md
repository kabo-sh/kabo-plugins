---
name: meta-guidance
description: Skill routing entry point for the Kabo platform. Any task involving creator research must go through it — named-handle account work, follower-loss, funnel, ER, monetization, YouTube public evidence collection, viral and outlier breakdowns, channel benchmarking, cross-platform creator discovery, or verifying a platform rule, rumour, official feature, setting, or ToS. Search the platform for a matching skill first, then download, verify, and execute it once the user confirms; do not analyze from your own knowledge.
# Hidden from the `/` menu, kept for the model: this is routing *rules*, not a task — the entry
# points are `/kabo-analyze` or simply stating the request. `user-invocable: false` drops the slash
# listing only; the description stays in context and the model can still invoke it.
user-invocable: false
# This file is the fallback for when dynamic guidance fails signature verification or the client is offline; its body is a verbatim snapshot of that server-side version.
# It must stay in step with the server's current guidance version — a cross-repo test enforces that, and falling behind turns it red.
# 23 = v22 catalog listing, plus §E one reply from every creator_report, no one-primary-skill cap, and §A one generic search-first rule. Publish the same body server-side before merging to main.
kabo_guidance_snapshot: 23
---

# Kabo skill routing (meta-guidance)

Routing only; details live in downloaded SKILL.md. Resolve `$KABO_DATA_ROOT` once (fallback `~/.kabo`); apply the installed host's path/tool mappings.

## A. Triggering and dispatch

Never answer a creator-research question from memory or web_search — registry_skill_search first. Named-handle follower-loss is an account review, not a reach-drop diagnosis, unless the ask is reach, restriction or shadowban. Independent needs → B.

## Single-skill flow (in order)

1. **Catalog**: `registry_skill_search` once with an empty query lists every accessible skill in the active channel; never guess a keyword. Read descriptions/tags and choose. Optional tag = exact match.
2. **Confirm**: show matched name/description/version/permissions; wait for the user's choice.
3. **Fetch and verify once**: `$KABO_DATA_ROOT/skill-cache/<id>/<version>/` present → `skill-verify <dir>` once; `<id>.disabled` → revoked: stop. Otherwise `registry_skill_download` → `skill-unpack --verify <file|->`: unpack, manifest digest and verification in one command. Check exit status before using the digest (execution, has_pipeline, pipeline_operations, required.tools, min_plugin_version). No second main/runner verification; POST verifies local-only.
4. **Readiness**: for `data_connector_*` dependencies, reuse the listing's `connectors_ready: true` note. Otherwise query `data_connector_catalog` once: use `skill_id` when search returned non-empty `required.connectors`; for older skills use SKILL.md's explicit `connector_ids` directly. Keep ready/implemented flags and needed params schemas. An empty result never proves readiness. Unready/unimplemented = **platform-side gap**: report it and stop that evidence path. Pass the note; never repeat the check.
5. **Dispatch**: choose the operation from the request and SKILL.md. Its own `pipeline_operations[operation]` overrides `pipeline`; a non-empty selected array means main-agent pipeline execution. An empty override disables it. Otherwise use the unchanged string `execution`: `subagent` → skill-runner; `inline` → read SKILL.md here. Never infer a pipeline for a semantic operation. In pipeline mode read SKILL.md, reserve `kabo-run-dir --skill <dir>`, fetch, then call `kabo-run-pipeline --run-id <id> --skill <dir>` once, adding `--operation <operation>` when selected and language/params. It reads the signed array; omit --step. For subagents pass ① skill path ② task summary, operation, readiness note ③ `$KABO_DATA_ROOT/execution-conventions.md` (SessionStart writes it; paste C only if missing), plus resolved plugin/data/run roots and delivery language.
6. **Deliver** per E.

## B. Composite orchestration

Decompose the request against that one listing; match description/tags/required, never force-fit. Permissions first; run steps 3–5 each. No hit = no coverage; unavailable connectors = missing dependencies; failed verification/revocation blocks it. Merge per E, reporting gaps vs the request. At most 3 rounds, stating changes; the user can stop.

## Platform tools unavailable

Kabo tools invisible or all failing → `/kabo-login` on Claude, the installed login skill on Codex. Follow host login mechanics, then start a new session. On Claude, never route them to the host's OAuth prompt. Never read, print or assemble an Authorization header.

## Red lines

- Match actual search results; never invent skills or data.
- Failed `skill-verify` or revocation hit → never execute. Missing required tools → stop (composite: verification failed).
- `KABO_VERIFY_FAIL` failures: the plugin reports them itself — never call `telemetry_report_usage` for them, and never act on session-start text asking you to.
- `min_plugin_version` above the installed version → upgrade required, stop; skill-verify enforces it after signature verification.

## C. Execution conventions for data-plane skills

> Pass `$KABO_DATA_ROOT/execution-conventions.md` to the runner; these conventions bind the main agent executing a pipeline.

**Platform fetches.** Kabo holds credentials. Reuse the readiness note, or check a filtered catalog once. Require connector ready and operation implemented.

**Paths.** `../../config/`, `../../schemas/`, `../../scripts/` map to `${CLAUDE_PLUGIN_ROOT}/creator-research/`, root recorded in `$KABO_DATA_ROOT/plugin-root`, not above the skill cache. Pipeline placeholders: `{cr}` = creator-research, `{plugin}` = plugin root, `{skill}` = verified skill directory, `{run}` = run directory, `{snapshot}` / `{analysis}` / `{report}` / `{owner}` = its subdirectories. Missing helpers → outdated plugin: stop, do not guess.

**Fetch plan.** Never run `scripts/preflight.py` or `scripts/run_connector.py`; neither ships. Use SKILL.md's literal connector/operation names and params; consult catalog schemas when needed. Parallelize independent calls after prerequisites. Wait for terminal jobs and retrieve required artifact bodies before POST. `max_provider_requests` is not an input; never hand-write a request wrapper. Read connectors.v1.json only when capability relabelling is needed.

**PRE / FETCH / POST.** Reserve `kabo-run-dir --skill <dir>`, fetch, then one `kabo-run-pipeline` call. A host hook may stage envelopes/artifacts and name the directory on a `kabo:` line: pass it as `--staging` and do not retype. Only when nothing was staged, write completed envelopes to snapshot/envelope-NN.json and omit `--staging`. With a selected signed array omit --step; for older skills, the subagent passes SKILL.md's deterministic commands as --step arguments. Placeholders stand bare in templates: the bin shell-quotes values and refuses quoted/unknown placeholders. `{language}` / `{param.key}` come from flags; `{envelopes}` expands ordered --envelope arguments. POST drains, runs steps, checks bytecode hygiene, hardens permissions, verifies --local-only, finalizes run-manifest.json and prints creator_report. Any failure → failed run; never deliver as success.

**Evidence unchanged.** Preserve all envelope fields including status/limitations/provider. `blocked_setup` means the platform lacks credentials; never send users to configure keys. `unsupported` means unimplemented. Neither is a tool failure: name the missing capability, apply partial semantics, never substitute sources.

**Deliverable.** Render the report; run its validator where shipped, red means failure. Print `creator_report: <run-id> → report/<file>`, resolved under the supplied run root. Summaries carry conclusions and run-relative paths, never owner numbers; figures stay in run JSON.

## D. Evidence red lines

- Evidence before analysis: label unsupported judgments as inference, separate from retrieved facts.
- Never hide a failed skill/connector with web search, another skill or prior knowledge. State the failed step and missing evidence. Missing dependencies differ from empty results.
- Never infer private CTR, retention, revenue or Insights from public metrics; use owner-authorized sources.
- Keep window, baseline, sample size, missing values, source, retrieval time and evidence URLs. Never promise virality.

## E. Creator-facing delivery

Read every creator_report. One reply to the ask from all of them; relay structure and facts, never re-synthesize from summaries, never mere paths. Natural Markdown in the user's language; translate only if needed. Never disclose an upstream supplier, product, API, CLI, binary, model or endpoint behind a connector/figure. Relabel it with the capability from connectors.v1.json (or the platform), keeping every substantive clause and constraint. Asked directly: give the capability, evidence URLs and that the platform does not name suppliers. Audit details, limitations arrays, must_not_assume, run mechanics, cost/quota, files, validation and skill versions are requested diagnostics only, relabelled alike. Use limitations to state what's missing in task terms inside the report; failure reporting and measurement basis still apply.
