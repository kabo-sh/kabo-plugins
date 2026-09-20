#!/usr/bin/env node
// persist-envelope.js - the PostToolUse hook that ends envelope hand-copying (kabo#482).
//
// WHY THIS EXISTS
//
// Data-plane SKILL.md files require "persist every successful Envelope", and skill-runner's
// scheduling rule already assumes the host offers somewhere to park a tool result. It did not.
// The executor's only way to get bytes onto disk was to retype the envelope as a tool argument,
// one character at a time, through the model. Measured on 2026-09-01 across seven installed-state
// E2E runs: 836s of wall clock and 112,023 characters spent on 18 such copies - 80% of all
// file-writing time - and every single copy arrived truncated, carrying a model-authored
// `_persist_note` explaining which fields it had dropped to save tokens. "Byte-for-byte" was
// unreachable by construction: a model paying per token will always elide.
//
// This hook removes the model from that path entirely. The host hands us the completed tool
// result; we write the envelope ourselves. The model's remaining cost is one short drain command.
//
// WHY A HOOK AND NOT A SERVER ROUND TRIP
//
// The server cannot reach the user's disk, and any MCP tool that returned the envelope would put
// those bytes right back in the context we are trying to keep them out of. The host is the only
// party holding both the bytes and the filesystem. The platform's implementation contract records
// this as the one sanctioned exception to the hook privacy rule restated below.
//
// PRIVACY BOUNDARY - read before touching this file
//
// CONTRACT §2.4 forbids hooks from reading or serializing `tool_response`. That rule guards
// *telemetry*: it exists so no hook can ship response bodies to the platform. This hook is the
// one carved-out exception, and the carve-out is conditional on all of the following holding:
//   - it writes to the local disk only, under the data root, mode 0600;
//   - it opens no socket, spawns no process, and imports nothing that could;
//   - the only thing it returns to the host is `additionalContext`, which carries connector id,
//     operation, status, byte count and a sha256 prefix - never envelope content;
//   - nothing here is reachable from the telemetry path.
// Adding a network call, a subprocess, or response bytes to the returned context breaks the
// carve-out, not just this file's style. Do neither without amending §2.4 first.
//
// FAILURE POSTURE
//
// Always exit 0 with no stderr. A hook that breaks a user's run to report that an *optimization*
// failed has inverted its own priorities: the runner's fallback (writing the file itself) still
// works, so the worst case of staying silent is the slow path we had before.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dataRoot, ensurePrivateDir, isSafeName, sha256hex } from '../lib/common.js';

/**
 * The drain command, resolved from this file's own location rather than from
 * `~/.kabo/plugin-root`. Two reasons: the marker file records whichever plugin root last ran
 * SessionStart, which is the wrong one under `--plugin-dir`; and handing the runner a literal
 * absolute path costs it fewer tokens than a command substitution it would have to compose.
 */
const SAVE_ENVELOPE_BIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'bin',
  'kabo-save-envelope',
);

/** Envelopes are staged here, one directory per host session, and drained by bin/kabo-save-envelope. */
const STAGING_DIRNAME = 'envelope-staging';

/**
 * Read the hook event off stdin.
 *
 * Bounded because stdin is attacker-adjacent in the only sense that matters here: a runaway
 * connector response should cost us a truncated read, not the host's memory. 64 MiB is far above
 * the largest envelope observed (17 KB) and far below anything that would hurt.
 */
async function readEvent() {
  const chunks = [];
  let total = 0;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > 64 * 1024 * 1024) return null;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(chunks.join(''));
  } catch {
    return null;
  }
}

/**
 * Pull the text payload out of a `tool_response`.
 *
 * MCP results reach the hook as the content block array (`[{type:"text",text:"<envelope>"}]`),
 * which is what the host would also persist. Accept a bare string too: the shape is the host's,
 * not ours, and a future host that inlines the text should not silently stop staging.
 */
function responseText(toolResponse) {
  if (typeof toolResponse === 'string') return toolResponse;
  if (Array.isArray(toolResponse)) {
    const parts = toolResponse
      .filter((block) => block && typeof block === 'object' && block.type === 'text')
      .map((block) => (typeof block.text === 'string' ? block.text : ''));
    return parts.length === 1 ? parts[0] : parts.join('');
  }
  if (toolResponse && typeof toolResponse === 'object') {
    // Some hosts hand back the already-decoded structured result.
    if (typeof toolResponse.text === 'string') return toolResponse.text;
    if (Array.isArray(toolResponse.content)) return responseText(toolResponse.content);
  }
  return null;
}

/** A V1 connector envelope, identified structurally rather than by which tool returned it. */
function isEnvelope(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.status === 'string' &&
    typeof value.connector_id === 'string' &&
    typeof value.operation === 'string' &&
    Array.isArray(value.limitations)
  );
}

/**
 * A typed tool result: the aggregate tools (`collect_*`, `enrich_*`) do not return an envelope,
 * they return the whole result with a `schema_version` of its own (`trend-candidate-set.v1` and
 * the like) and none of connector_id / operation / limitations.
 *
 * Recognised by shape, like `isEnvelope` above, and deliberately not by listing schema names: a
 * list drifts, and drifting here stops persistence silently. A plain object carrying only
 * `items` and no `schema_version` is still not staged, or any JSON at all would become evidence.
 *
 * Why it has to be staged: without it these results reach no staging directory, so the Skill can
 * only fall back to reading the Codex rollout — the copy recorded after the fence, wrapped in
 * `<untrusted_data>`, at a path that moves with the host. The reading end
 * (persist_envelope.py's staged_candidates) has had its typed branch all along; this is the
 * producing end it was waiting for. Same fix as kabo-desktop b0da01f.
 */
function isTypedResult(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.schema_version === 'string'
  );
}

/**
 * Strict base64 -> bytes, or `null`.
 *
 * `Buffer.from` is lenient: it skips characters outside the alphabet and returns a short buffer
 * rather than throwing. Re-encoding and comparing catches that. It does not catch truncation - a
 * shorter payload is still valid base64 - which is why the caller also checks the server's sha256.
 * The two together are what make "the bytes on disk are the object the connector produced" true.
 */
function decodeBase64(value) {
  const body = Buffer.from(value, 'base64');
  return body.toString('base64') === value.replace(/\s+/g, '') ? body : null;
}

/**
 * Artifact bodies returned by `data_connector_artifact`.
 *
 * Unwrap **by shape**, never by tool name — the same rule the envelope side follows, for the same
 * reason: host registration prefixes and `required.tools` both drift, and a rename must not quietly
 * stop persistence.
 *
 * The pairing is positional but verified: `structuredContent.artifacts[]` carries the identifiers
 * (object_ref, sha256, content_type) while `content[]` carries the bytes, and the server emits one
 * content block per projected artifact in the same order. A mismatch means the two halves disagree
 * about what came back, and staging a body under the wrong sha256 would put a file in the audit
 * trail that claims to be something it is not — so a disagreement stages nothing.
 */
function collectArtifacts(parsed) {
  const projected = parsed?.structuredContent?.artifacts;
  const blocks = parsed?.content;
  const jobId = parsed?.structuredContent?.job_id;
  if (!Array.isArray(projected) || !Array.isArray(blocks)) return [];
  if (typeof jobId !== 'string' || !jobId) return [];

  /* **Text artifacts count too.** A transcript comes back as a text block, and the codex runner's
   * SKILL.md says so. Keeping only images made `bodies.length` differ from `projected.length` on
   * any mixed response, and the mismatch guard below then dropped *everything* - including the
   * frames that did arrive. Normalize both shapes before pairing. */
  const bodies = [];
  for (const block of blocks) {
    if (block?.type === 'image' && typeof block.data === 'string') {
      bodies.push(decodeBase64(block.data));
    } else if (block?.type === 'text' && typeof block.text === 'string') {
      bodies.push(Buffer.from(block.text, 'utf8'));
    }
  }
  if (bodies.length !== projected.length) return [];

  const out = [];
  for (const [index, artifact] of projected.entries()) {
    const block = bodies[index];
    if (
      typeof artifact?.object_ref !== 'string' ||
      typeof artifact?.sha256 !== 'string' ||
      typeof artifact?.content_type !== 'string'
    ) {
      return [];
    }
    out.push({
      body: block,
      jobId,
      kind: typeof artifact.kind === 'string' ? artifact.kind : 'keyframes',
      objectRef: artifact.object_ref,
      sha256: artifact.sha256,
      contentType: artifact.content_type,
    });
  }
  return out;
}

/**
 * One tool result may carry more than one envelope, and the three data-plane tools each wrap
 * theirs differently. Unwrap by shape, never by tool name: `required.tools` and host registration
 * prefixes both drift, and a rename must not quietly stop persistence.
 *
 * Only `completed`-family envelopes are worth staging as evidence, but the filter here is
 * deliberately *not* on status: `completed_partial` and `partial` are usable evidence the target
 * Skill must still persist, and even a `failed` envelope is worth having on disk when someone
 * later asks what the run actually saw. The runner decides what to consume; we decide what exists.
 */
function collectEnvelopes(parsed) {
  if (isEnvelope(parsed)) return [parsed];
  // Envelope first: when a value satisfies both, the envelope sidecar carries more.
  if (isTypedResult(parsed)) return [parsed];
  if (parsed && typeof parsed === 'object') {
    // data_connector_batch_run: { results: [envelope | job, ...] }
    if (Array.isArray(parsed.results)) {
      return parsed.results.flatMap((item) => collectEnvelopes(item));
    }
    // data_connector_job / a deferred data_connector_run: the job resource carries it (null until terminal).
    if (isEnvelope(parsed.envelope)) return [parsed.envelope];
  }
  return [];
}

/**
 * Serialize back to bytes for storage.
 *
 * The stored artifact must be the envelope the connector returned, not a re-rendering of it, so a
 * single envelope is written from the exact substring the host delivered rather than from
 * `JSON.stringify(parsed)` - key order and number formatting are part of what an audit copy is
 * for. Multi-envelope payloads have no such substring, so those are re-serialized compactly and
 * marked as such in the sidecar.
 */
function bytesFor(envelope, wholeText, singleton) {
  if (singleton) return { text: wholeText, verbatim: true };
  return { text: JSON.stringify(envelope), verbatim: false };
}

/**
 * Continue the staging directory's numbering. Must match the names actually written below
 * (`01.json` / `01.meta`) - an anchor that never matches silently restarts at 1 on every call and
 * each connector response overwrites the last, which is worse than not staging at all.
 */
/** POSIX single-quote a path for the command line the runner is told to paste. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function nextSequence(dir) {
  let max = 0;
  for (const name of fs.readdirSync(dir)) {
    const match = /^(\d{2,})\.(json|art|meta|lock)$/.exec(name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

async function main() {
  const event = await readEvent();
  if (!event || typeof event !== 'object') return;

  // `PostToolUse` carries the result as `tool_response`; `PostToolUseFailure` carries the very same
  // bytes as `error` and has no `tool_response` at all.
  //
  // This file is byte-identical in both variants. A host that registers both events (the Claude
  // variant does) needs both, because `isError` is a **call-level** signal on a batch. One `failed`
  // envelope in a `data_connector_batch_run` flags the whole call, the host then routes it to the
  // failure event, and the envelopes that *did* complete are sitting inside that payload. Listening
  // only to the success event silently drops them in exactly the mixed-outcome batch where
  // re-fetching is most expensive. Codex registers only `PostToolUse` (its event enum has no failure
  // event), so there the `error` fallback simply never fires. A fully failed envelope gets staged too, which is right: what a runner may
  // *consume* is governed by the status matrix, but what happened should still be on disk.
  const toolResponse = event.tool_response ?? event.error;
  if (toolResponse === undefined || toolResponse === null) return;

  const text = responseText(toolResponse);
  if (typeof text !== 'string' || text.length === 0) return;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The host's own oversized-result notice lands here (it is prose, not JSON) - and that is
    // fine: the notice only appears when the host already wrote the bytes to a file of its own.
    return;
  }

  const envelopes = collectEnvelopes(parsed);
  const artifacts = collectArtifacts(parsed);
  if (envelopes.length === 0 && artifacts.length === 0) return;

  // The session id partitions staging so two runs on one machine cannot drain each other's
  // evidence. It comes from the host, so it is validated before it becomes a path segment.
  const sessionId = typeof event.session_id === 'string' ? event.session_id : '';
  if (!isSafeName(sessionId)) return;

  // Partition again by the calling agent. A spawned subagent (one skill-runner per skill in a
  // composite request) reports the *root* session id, so every runner in the request would share
  // one directory and the first `--staging` drain would sweep the others' envelopes into its own
  // snapshot. `agent_id` is set for those subagents (Codex 0.154 PostToolUse: session_id is the
  // root thread, agent_id the spawned one); the main thread has none and keeps the session dir.
  const agentId = typeof event.agent_id === 'string' && isSafeName(event.agent_id) ? event.agent_id : null;
  const stagingDir = agentId
    ? path.join(dataRoot(), STAGING_DIRNAME, sessionId, agentId)
    : path.join(dataRoot(), STAGING_DIRNAME, sessionId);
  ensurePrivateDir(stagingDir);

  // Who holds a reserved stem: the drain reclaims a stale lock only when this process is gone, and
  // only the exact lock it judged stale (the token), never a replacement written since.
  const lockOwner = `${process.pid} ${crypto.randomUUID()}\n`;
  // A typed result must take the verbatim path: the reading end compares sha256 byte for
  // byte, and re-serializing shifts key order or number literals, which it reads as damage.
  const singleton =
    envelopes.length === 1 && (isEnvelope(parsed) || isTypedResult(parsed));
  const staged = [];
  const startSequence = nextSequence(stagingDir);
  let sequence = startSequence;

  for (const envelope of envelopes) {
    const { text: bytes, verbatim } = bytesFor(envelope, text, singleton);
    const sha256 = sha256hex(bytes);
    const typed = !isEnvelope(envelope) && isTypedResult(envelope);
    // Two sidecar shapes, told apart by whether `connector_id` is there: a typed one names its
    // schema and carries no connector, which is exactly what persist_envelope.py's
    // staged_candidates looks for. The cost is that a typed result is not counted by
    // envelope-progress (it skips entries without connector_id / operation / status) — one
    // uncounted entry is better than inventing a connector name to fill the field.
    const meta = typed
      ? {
          schema_version: envelope.schema_version,
          bytes: Buffer.byteLength(bytes, 'utf8'),
          sha256,
          verbatim,
          staged_at: new Date().toISOString(),
          tool_use_id: typeof event.tool_use_id === 'string' ? event.tool_use_id : null,
        }
      : {
          connector_id: envelope.connector_id,
          operation: envelope.operation,
          status: envelope.status,
          // Staging numbers carry no request order (each is reserved before its write finishes). The envelope's own request id
          // is what lets a runner pair a drained file back with the call (and the input) that made it.
          request_id: typeof envelope.request_id === 'string' ? envelope.request_id : null,
          bytes: Buffer.byteLength(bytes, 'utf8'),
          sha256,
          verbatim,
          staged_at: new Date().toISOString(),
          tool_use_id: typeof event.tool_use_id === 'string' ? event.tool_use_id : null,
        };
    // **Exclusive create, and step over a collision.** `nextSequence` read the directory in this
    // process, but the write happens later and other hook processes are running concurrently — the
    // runner is explicitly told to submit independent connector calls in the same turn, so two
    // hooks racing for the same number is the normal case, not the exotic one. A plain write would
    // let the second one silently replace the first envelope, which is the exact loss this whole
    // file exists to prevent.
    //
    // Envelope first, sidecar second: a process killed between the two leaves a `.json` with no
    // `.meta`, which the drain refuses to move and reports rather than skipping.
    let written = false;
    for (let attempt = 0; attempt < 64 && !written; attempt += 1) {
      const stem = path.join(stagingDir, String(sequence).padStart(2, '0'));
      try {
        // Reserve the whole stem, not just this body's extension: an envelope (`.json`) and an
        // artifact (`.art`) racing for the same number would otherwise both claim `<stem>.meta`.
        fs.writeFileSync(`${stem}.lock`, lockOwner, { mode: 0o600, flag: 'wx' });
      } catch (error) {
        if (error?.code === 'EEXIST') {
          sequence += 1;
          continue;
        }
        throw error;
      }
      try {
        fs.writeFileSync(`${stem}.json`, bytes, { mode: 0o600, flag: 'wx' });
      } catch (error) {
        fs.rmSync(`${stem}.lock`, { force: true });
        if (error?.code === 'EEXIST') {
          sequence += 1;
          continue;
        }
        throw error;
      }
      fs.writeFileSync(`${stem}.meta`, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
      fs.rmSync(`${stem}.lock`, { force: true });
      written = true;
    }
    // Out of stems: stop staging this batch, but still report what already landed below - returning
    // here would leave those files in staging with no `kabo:` line telling the runner they exist.
    if (!written) break;
    staged.push(meta);
    sequence += 1;
  }

  /* Artifact bodies (keyframes) stage the same way, with `.art` instead of `.json`.
   *
   * This is the same carve-out, not a new one: local disk only, under the data root, mode 0600,
   * no socket, no subprocess, and the returned `additionalContext` still carries nothing but
   * identifiers. What changes is the content type of the bytes, and none of the four conditions
   * in CONTRACT §2.4 mentions one.
   *
   * Why it has to happen here at all: the frames only exist as bytes inside this response. The
   * server cannot reach the user's disk, and the evidence object points at frames *by path* —
   * without a local file there is nothing for `frames[].path` to name, which is exactly the gap
   * the 2026-08-26 regression recorded as "retained as host artifacts but never read". */
  for (const artifact of artifacts) {
    /* **Verify before writing, not after.** Writing a payload we could not decode faithfully under
     * the server's sha256 pushes the failure to `kabo-save-envelope`, which refuses the *whole*
     * drain - one damaged frame would then cost the run every envelope staged beside it. One hash
     * here turns that into a single skipped frame. */
    const body = artifact.body;
    if (!body || sha256hex(body) !== artifact.sha256) continue;
    // The sidecar sha256 is the one the *server* computed over the original object. Recomputing it
    // here and storing ours would make the drain's check self-referential — it would only prove the
    // staging file did not rot, never that it is the object the connector produced.
    const meta = {
      // Not a connector/operation pair: an artifact belongs to a *job*, and the response carries
      // the job id rather than the operation that produced it. Inventing
      // `public-video-media/artifact` (the first draft did) puts a pair in the audit trail that
      // never ran.
      artifact: true,
      job_id: artifact.jobId,
      kind: artifact.kind,
      object_ref: artifact.objectRef,
      status: 'completed',
      bytes: body.byteLength,
      sha256: artifact.sha256,
      content_type: artifact.contentType,
      verbatim: true,
      staged_at: new Date().toISOString(),
      tool_use_id: typeof event.tool_use_id === 'string' ? event.tool_use_id : null,
    };
    let written = false;
    for (let attempt = 0; attempt < 64 && !written; attempt += 1) {
      const stem = path.join(stagingDir, String(sequence).padStart(2, '0'));
      try {
        // Reserve the whole stem, not just this body's extension: an envelope (`.json`) and an
        // artifact (`.art`) racing for the same number would otherwise both claim `<stem>.meta`.
        fs.writeFileSync(`${stem}.lock`, lockOwner, { mode: 0o600, flag: 'wx' });
      } catch (error) {
        if (error?.code === 'EEXIST') {
          sequence += 1;
          continue;
        }
        throw error;
      }
      try {
        fs.writeFileSync(`${stem}.art`, body, { mode: 0o600, flag: 'wx' });
      } catch (error) {
        fs.rmSync(`${stem}.lock`, { force: true });
        if (error?.code === 'EEXIST') {
          sequence += 1;
          continue;
        }
        throw error;
      }
      fs.writeFileSync(`${stem}.meta`, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
      fs.rmSync(`${stem}.lock`, { force: true });
      written = true;
    }
    // Out of stems: stop staging this batch, but still report what already landed below - returning
    // here would leave those files in staging with no `kabo:` line telling the runner they exist.
    if (!written) break;
    staged.push(meta);
    sequence += 1;
  }

  if (staged.length === 0) return;

  // What goes back to the model. Compact by design: this is injected after *every* connector call,
  // and a verbose reminder repeated a dozen times per run is its own context tax. The first one
  // spells out the command; later ones are a single line, because by then the runner has it.
  const first = startSequence === 1;
  // Frames and envelopes are described differently because the runner does different things with
  // them: an envelope is JSON it must not retype, a frame is an image it has to *look at*. Calling
  // a keyframe an "envelope" (the first live run did) sends it looking for JSON that is not there.
  const describe = (m) => {
    const size = `bytes=${m.bytes} sha256=${m.sha256.slice(0, 12)}`;
    if (m.artifact) return `${m.kind} ${m.object_ref} ${size}`;
    // A typed result has no connector triple; naming it by its schema keeps this line readable
    // instead of printing `undefined/undefined` at the runner.
    if (m.schema_version) return `${m.schema_version} ${size}`;
    return `${m.connector_id}/${m.operation} status=${m.status} ${size}`;
  };
  const lines = staged.map((m) => `  - ${describe(m)}`);
  // "byte-for-byte" is only true for a response that carried exactly one envelope, where the stored
  // file is the substring the host delivered. A batch has no such substring per entry, so those are
  // re-serialized from the parsed value and the claim is downgraded to "complete" — the sidecar
  // records which one each file is. Overstating this would put a promise in the runner's context
  // that the artifact cannot keep, which is the failure mode this whole change exists to end.
  const allVerbatim = staged.every((m) => m.verbatim);
  const fidelity = allVerbatim ? 'byte-for-byte' : 'complete (batch entries re-serialized from the same response)';
  const context = first
    ? [
        `kabo: ${staged.length === 1 ? 'this result has' : `these ${staged.length} results have`} already been written to disk ${fidelity}:`,
        ...lines,
        'Do NOT retype or re-serialize any of them into a file — the stored copy is already complete and yours would not be.',
        `When this run's snapshot/ exists, move them in with one command:`,
        `  ${shellQuote(path.normalize(SAVE_ENVELOPE_BIN))} --from ${shellQuote(stagingDir)} --into <run dir>/snapshot`,
      ].join('\n')
    : [`kabo: envelope staged (drain pending):`, ...lines].join('\n');

  // Echo back the event we were actually invoked for. The host matches `hookEventName` against the
  // event it fired. Where a host wires this script to both `PostToolUse` and `PostToolUseFailure`
  // (the Claude variant), hard-coding the success name would make it drop this output on the
  // failure path, so the runner would never see the `kabo:` line naming the staging directory and
  // would hand-write the envelopes it was just handed for free. Codex wires only `PostToolUse`.
  const eventName =
    event.hook_event_name === 'PostToolUseFailure' ? 'PostToolUseFailure' : 'PostToolUse';
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: eventName, additionalContext: context },
    }),
  );
}

try {
  await main();
} catch {
  // See FAILURE POSTURE above. Silence is the contract.
}
// `process.exit()` would be wrong here: stdout is a pipe to the host, writes to it are asynchronous,
// and exiting immediately can discard the JSON the host is waiting for. Setting the code lets the
// process end on its own once the write drains. (bin/kabo-headers documents the same hazard.)
process.exitCode = 0;
