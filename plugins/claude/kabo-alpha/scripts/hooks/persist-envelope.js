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
function nextSequence(dir) {
  let max = 0;
  for (const name of fs.readdirSync(dir)) {
    const match = /^(\d{2,})\.(json|meta)$/.exec(name);
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
  // Both are needed, because `isError` is a **call-level** signal on a batch. One `failed` envelope
  // in a `data_connector_batch_run` flags the whole call, the host then routes it to the failure
  // event, and the envelopes that *did* complete are sitting inside that payload. Listening only to
  // the success event silently drops them in exactly the mixed-outcome batch where re-fetching is
  // most expensive. A fully failed envelope gets staged too, which is right: what a runner may
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
  if (envelopes.length === 0) return;

  // The session id partitions staging so two runs on one machine cannot drain each other's
  // evidence. It comes from the host, so it is validated before it becomes a path segment.
  const sessionId = typeof event.session_id === 'string' ? event.session_id : '';
  if (!isSafeName(sessionId)) return;

  const stagingDir = path.join(dataRoot(), STAGING_DIRNAME, sessionId);
  ensurePrivateDir(stagingDir);

  const singleton = envelopes.length === 1 && isEnvelope(parsed);
  const staged = [];
  const startSequence = nextSequence(stagingDir);
  let sequence = startSequence;

  for (const envelope of envelopes) {
    const { text: bytes, verbatim } = bytesFor(envelope, text, singleton);
    const sha256 = sha256hex(bytes);
    const meta = {
      connector_id: envelope.connector_id,
      operation: envelope.operation,
      status: envelope.status,
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
        fs.writeFileSync(`${stem}.json`, bytes, { mode: 0o600, flag: 'wx' });
      } catch (error) {
        if (error?.code === 'EEXIST') {
          sequence += 1;
          continue;
        }
        throw error;
      }
      fs.writeFileSync(`${stem}.meta`, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
      written = true;
    }
    if (!written) return;
    staged.push(meta);
    sequence += 1;
  }

  // What goes back to the model. Compact by design: this is injected after *every* connector call,
  // and a verbose reminder repeated a dozen times per run is its own context tax. The first one
  // spells out the command; later ones are a single line, because by then the runner has it.
  const first = startSequence === 1;
  const describe = (m) =>
    `${m.connector_id}/${m.operation} status=${m.status} bytes=${m.bytes} sha256=${m.sha256.slice(0, 12)}`;
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
        `kabo: ${staged.length === 1 ? 'this envelope has' : `these ${staged.length} envelopes have`} already been written to disk ${fidelity}:`,
        ...lines,
        'Do NOT retype or re-serialize an envelope into a file — the stored copy is already complete and yours would not be.',
        `When this run's snapshot/ exists, move them in with one command:`,
        `  "${path.normalize(SAVE_ENVELOPE_BIN)}" --from ${stagingDir} --into <run dir>/snapshot`,
      ].join('\n')
    : [`kabo: envelope staged (drain pending):`, ...lines].join('\n');

  // Echo back the event we were actually invoked for. The host matches `hookEventName` against the
  // event it fired, and this one script is wired to both `PostToolUse` and `PostToolUseFailure`;
  // hard-coding the success name would make the host drop this output on the failure path, so the
  // runner would never see the `kabo:` line naming the staging directory and would hand-write the
  // envelopes it was just handed for free.
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
