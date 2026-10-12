# Signed execution stages

Plugin candidate 0.21.28 adds an opt-in execution contract. The manifest and its commands are covered by the existing package checksum/signature. Packages declaring this contract must require `min_plugin_version: "0.21.28"` or later: older wrappers do not enforce it. Do not publish such a package until every intended host has a compatible adapter. Existing packages keep their driver/step behavior.

```json
{
  "min_plugin_version": "0.21.28",
  "execution_stages": {
    "format_version": 1,
    "stages": {
      "prepare": {
        "input": "json",
        "after": [],
        "final": false,
        "cmd": "python3 {skill}/scripts/prepare.py {stage_input} --output-dir {run} --language {language}"
      },
      "report": {
        "input": "json",
        "after": ["prepare"],
        "final": true,
        "report_file": "creator-reply.md",
        "cmd": "python3 {skill}/scripts/drive.py report --synthesis-file {stage_input}"
      }
    }
  }
}
```

This example specifies the interface, not a runnable business Skill. Authors must select their shipped drivers, input schemas and actual required validators. A stage's `after` predecessors must have completed. Stage names are attempted at most once; a failed/unfinished stage closes or blocks the attempt. Nonfinal success leaves the reservation running; only the signed final command and existing report/integrity checks can announce its report. A contract package cannot use caller-supplied steps, operation parameters, continuation or report overrides. One-shot pipelines remain a separate contract.

For Codex, `kabo_runtime.prepare_skill` uses the original network-aware verifier and binds the verified manifest identity to the requested ID/version. Its successful private receipt records package checksum and manifest digest. `stage_input` accepts that receipt's basename, an existing running reservation, a stage name and one JSON object. It writes the unchanged JSON to the fixed private `owner/stage-inputs/<stage>.json`, with a separate receipt binding run, real Skill path, package checksum, manifest digest, stage and input digest. It cannot execute a command, fetch evidence, write a connector envelope, select an output path or create another reservation.

Execute through the normal native approval path:

```text
<plugin>/bin/kabo-run-pipeline --run-id <id> --skill <dir> --stage prepare --language zh-CN
```

For JSON stages, the wrapper derives the fixed receipt from run and stage; the model need not copy its absolute path. An explicit `--input-receipt` remains available, but must match that same fixed path. Missing receipts are rejected. The wrapper checks the receipt, stage history and local package signature before execution, and preserves its existing post-execution verification, artifact hardening and failed-run behavior. Input paths must be private regular files owned by the user, with no symlink/hardlink substitution. JSON remains data; the signed command receives a file path rather than model-authored shell stdin. No-input stages use `input: "none"` and omit both receipt and `{stage_input}`.

Native wrapper tests cover Codex and Claude layouts. The local data tool is included in both plugin layouts. Desktop source integration is tracked separately in kabo-desktop#71; it reuses the host verifier receipt instead of verifying twice. Desktop/Web product adapter support, signed business package adoption, model orchestration, report quality and complete delivery require their own verification; these mechanism tests do not establish three-host acceptance. A driver that requires an entirely empty reservation cannot consume an input already stored under `owner/` without an explicitly compatible adoption path. Do not silently relax that driver's reservation guard.

Preparation locks fail closed after an abrupt runtime-server death. Do not delete an abandoned lock merely because the server PID is gone: a detached verifier may still be active. Recovery requires confirming the corresponding helper process has terminated and re-verifying the cached package through the normal preparation path. Automatic stale-lock recovery is not implemented.

The one-attempt guarantee is scoped to one reservation. `kabo-run-dir` can still create a fresh reservation for the same package; neither caller-controlled `--request-id` nor the package identity establishes a trusted user-attempt identity. A blanket ban after any earlier failed package run would also block unrelated future user requests. Cross-reservation replay prevention requires a host-owned attempt binding and is not implemented here. Raw command execution and a model's final reply likewise remain outside this wrapper contract. These limits block a claim that the full host workflow is mechanically unskippable.
