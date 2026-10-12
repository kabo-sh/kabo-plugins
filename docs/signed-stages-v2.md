# Native signed stages V2 (candidate 0.21.29)

V1 retains `min_plugin_version >= 0.21.28`. V2 requires `>= 0.21.29` and every signed command includes a bare `{stage_outcome}` placeholder. The native pipeline's existing shell-context validation rejects quoted placeholders. Caller commands, parameters, report paths and continuation flags remain forbidden for signed stages.

The host supplies `owner/reservation.json` with `{format_version:1,skill_id,run,manifest_sha256,attempt_id}`. `run` is the real reserved cwd, `attempt_id` the canonical run ID. The command writes the fixed private `owner/stage-outcomes/<stage>.json`:

```json
{"format_version":1,"status":"awaiting_connector","input_sha256":"<original input bytes SHA-256, or null>","requests":[{"tool":"data_connector_run","arguments":{"connector_id":"...","operation":"...","params":{}}}]}
```

`completed` requires no requests. `awaiting_connector` requires 1–4 flattened requests, using only `data_connector_run` or `data_connector_batch_run` (at most four members). The pipeline does not fetch. A paused command may exit 0 while the run remains `running`; it emits an explicit awaiting outcome and no final `creator_report`. Missing/invalid outcomes, process failures and a ninth handoff close the run as failed. Eight handoffs permit the ninth execution to complete. Only the paused stage can resume; started/failed attempts and successors cannot run.

Resume preserves the same native scope/attempt/package/input/language and the original pending outcome bytes. The normal `PostToolUse` hook may supply receipt proof only for the fixed layout namespace: Codex `mcp__kabo__data_connector_run/batch_run`, Claude `mcp__plugin_kabo-alpha_kabo__data_connector_run/batch_run`: exact `turn_id`, `tool_input`, `tool_use_id`, and child `agent_id` or main `session_id`. The sidecar binds native scope and resolved request to the original staged envelope digest. The host selects new matching records absent from the pause baseline, in pending request order; mtime, caller snapshots, user-supplied receipt paths and file existence are not proof.

Only after that check does the host write fixed `owner/stage-receipts/<stage>.json`:

```json
{"format_version":1,"input_sha256":"...","requests_sha256":"<host canonical audit digest>","outcome_sha256":"<original pending UTF-8 bytes SHA-256>","envelopes":["<complete host envelope projections, in request order>"]}
```

The original envelope bytes and sidecar digest remain unchanged. Receipt envelopes retain every original field and add `request` from the proven normal tool arguments (`native_request.params`), matching the Web projection. An existing `request` must equal those plain params; contradictory or nested request metadata is rejected rather than overwritten. This projection is not a claim of raw-byte identity.

The signed entry consumes this receipt and writes a fresh outcome. An unchanged pending file remains awaiting; it never implies completion. Numbered outcome/receipt copies retain previous rounds. All private files and directories retain owner/nonlink checks, while final reports retain the existing package, scope, revocation, artifact digest and UTF-8 guards.

Hosts missing the required normal hook fields cannot prove continuation and receive `native_same_turn_connector_receipt_missing` before the command is rerun. This source feature does not prove those fields are present on any installed host. Current tests use real locally signed packages and synthetic hook events, not a model or product E2E. The local owner filesystem remains the existing host trust boundary; these checks are not a cryptographic defense against an adversarial process with the same user's write authority.


A separate normal Codex 0.153 field probe observed `session_id`, `turn_id`, `tool_use_id` and exact `tool_input` after normal hook approval. Its local `mcp__kabo_field__` server is intentionally outside the candidate's trusted namespace, so it establishes host field availability on that tested path, not candidate receipt execution or product continuation. Codex 0.154 and actual Claude callbacks remain unverified.
