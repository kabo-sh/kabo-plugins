#!/usr/bin/env node
// install-skill-package.js - PostToolUse hook that installs a downloaded Skill package itself.
//
// WHY THIS EXISTS
//
// `registry_skill_download` returns the whole SkillPackage (base64 file bodies inside JSON). The
// only way the model could get those bytes to `skill-unpack` was the download-to-unpack bridge: a
// raw PTY running `dd`, fed by `write_stdin` in 16 KiB chunks. A 2 MB package is ~120 terminal
// writes. On hosts that review terminal input (approval policy on-request with automatic review,
// or a terminal started outside the sandbox) every write is reviewed, the reviewer declines a
// 16 KiB input as too large to assess, and the turn hangs on a permission request - measured
// 2026-10-14 on the account review packages. The host already holds the complete result and the
// filesystem; this hook writes the package and runs the same signed verification, so the model
// never carries package bytes and no terminal input is involved.
//
// TRUST AND PRIVACY
//
// - Verification is unchanged: the package is unpacked by this plugin's own `bin/skill-unpack
//   --verify`, which runs `bin/skill-verify` (signature, checksum, network revocation check). A
//   failed verification installs nothing.
// - The package is unpacked into a private temporary root first and moved into the cache only after
//   verification passed, so a concurrent bridge or a failed run never leaves a half-written cache.
// - Writes stay under the data root (0700 directories, 0600 files). No package content is returned
//   to the host: `additionalContext` carries only the relay-safe stdout lines of skill-unpack
//   (cache-relative `Written:`, the allowlisted manifest digest, the verify verdict) and the exit code.
// - Network: only the revocation check inside skill-verify, the same one the bridge performs.
//
// FAILURE POSTURE
//
// Always exit 0. If anything here fails, the hook says so in one `kabo:` line and the documented
// bridge remains the fallback. Local metadata diagnostics never contain tool payloads.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { cacheRoot, dataRoot, ensurePrivateDir } from '../lib/common.js';

const SKILL_UNPACK_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'skill-unpack');
const STAGING_DIRNAME = 'skill-staging';
const MAX_EVENT_BYTES = 64 * 1024 * 1024;
const VERIFY_TIMEOUT_MS = 120 * 1000;
const invocation = crypto.randomUUID();
const startedAt = Date.now();
let stage = 'start';
let outcome = 'failed';

// 只记录固定阶段、错误码和结构元数据；不写入参数、返回正文、令牌或原始 stderr。
function errorCode(error) {
  return ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EEXIST', 'ENOSPC', 'EROFS', 'ETIMEDOUT', 'ENOBUFS', 'EIO'].includes(error?.code)
    ? error.code : 'unknown_error';
}

function diagnostic(event, fields = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), invocation, event, stage,
    elapsed_ms: Date.now() - startedAt, ...fields }) + '\n';
  // stderr 在日志目录不可写时仍可由宿主捕获，也提供进程启动证据。
  try { process.stderr.write(`KABO_SKILL_INSTALL ${line}`); } catch {}
  try {
    const dir = path.join(dataRoot(), 'logs');
    ensurePrivateDir(dir);
    const file = path.join(dir, 'skill-install.jsonl');
    if (fs.existsSync(file) && fs.statSync(file).size >= 1024 * 1024) {
      fs.renameSync(file, `${file}.1`);
    }
    fs.appendFileSync(file, line, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch (error) {
    try { process.stderr.write(`KABO_SKILL_INSTALL ${JSON.stringify({ invocation, event: 'log_write_failed', code: errorCode(error) })}\n`); } catch {}
  }
}

function rejectInput(reason) {
  diagnostic('input_rejected', { reason });
  emit('PostToolUse', `kabo: skill install hook could not read the download (${reason}); installation was not completed. Diagnostic ID: ${invocation}.`);
}

async function readEvent() {
  const chunks = [];
  let total = 0;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    total += Buffer.byteLength(chunk, 'utf8');
    if (total > MAX_EVENT_BYTES) { rejectInput('event_too_large'); return null; }
    chunks.push(chunk);
  }
  try {
    diagnostic('input_received', { bytes: total });
    const event = JSON.parse(chunks.join(''));
    if (event === null) rejectInput('invalid_event');
    return event;
  } catch {
    rejectInput('invalid_json');
    return null;
  }
}

/** A SkillPackage is recognised by shape, the same fields skill-unpack itself requires. */
function isSkillPackage(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.id === 'string' &&
    typeof value.version === 'string' &&
    Array.isArray(value.files) &&
    value.files.length > 0 &&
    value.files.every((f) => f && typeof f.path === 'string' && typeof f.content_base64 === 'string')
  );
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Find the package inside the host's tool result. Hosts deliver MCP results as the structured
 * object, as the content block array, or as the text of a nested `{content:[...]}` wrapper; accept
 * each, a few levels deep, and nothing that is not package-shaped.
 */
function findPackage(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return null;
  if (typeof value === 'string') return findPackage(parseJson(value), depth + 1);
  if (isSkillPackage(value)) return value;
  if (Array.isArray(value)) {
    for (const block of value) {
      const found = findPackage(block && typeof block === 'object' && 'text' in block ? block.text : block, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const key of ['structuredContent', 'structured_content', 'result', 'content', 'text']) {
      if (key in value) {
        const found = findPackage(value[key], depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

/** id/version become directory names; refuse anything skill-unpack would also refuse. */
function safeSegment(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes('..');
}

/** Relay-safe lines only: skill-unpack's stdout contract, trimmed and capped. */
function relayLines(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((line) => line.slice(0, 400));
}

function emit(eventName, context) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: context } }));
}

async function main() {
  stage = 'read_event';
  const event = await readEvent();
  if (event === null) return;
  if (!event || typeof event !== 'object' || Array.isArray(event)) { rejectInput('invalid_event'); return; }
  diagnostic('event_parsed', { tool_name_present: typeof event.tool_name === 'string', tool_response_present: Object.hasOwn(event, 'tool_response'), response_type: Array.isArray(event.tool_response) ? 'array' : event.tool_response === null ? 'null' : typeof event.tool_response });
  if (typeof event.tool_name !== 'string') { rejectInput('missing_tool_name'); return; }
  const toolName = String(event.tool_name || '');
  if (!/registry_skill_download$/.test(toolName)) { outcome = 'ignored'; diagnostic('tool_not_matched'); return; }
  stage = 'find_package';
  const pkg = findPackage(event.tool_response);
  const eventName = 'PostToolUse';
  if (!pkg) { rejectInput(Object.hasOwn(event, 'tool_response') ? 'package_not_found' : 'missing_tool_response'); return; }
  if (!safeSegment(pkg.id) || !safeSegment(pkg.version)) {
    diagnostic('input_rejected', { reason: 'invalid_package_identity' });
    emit(eventName, 'kabo: skill install by the plugin hook skipped (unrecognised package id/version); use the download-to-unpack bridge.');
    return;
  }
  const label = `${pkg.id}@${pkg.version}`;
  const staging = path.join(dataRoot(), STAGING_DIRNAME);
  const nonce = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const packageFile = path.join(staging, `${pkg.id}@${pkg.version}-${nonce}.json`);
  const tmpRoot = path.join(staging, `unpack-${nonce}`, 'skill-cache');
  try {
    stage = 'stage_package';
    diagnostic('package_found', { file_count: pkg.files.length });
    ensurePrivateDir(staging);
    fs.writeFileSync(packageFile, JSON.stringify(pkg), { mode: 0o600, flag: 'wx' });
    ensurePrivateDir(tmpRoot);
    stage = 'verify';
    diagnostic('verify_started');
    const run = spawnSync(process.execPath, [SKILL_UNPACK_BIN, '--verify', packageFile, tmpRoot], {
      encoding: 'utf8',
      timeout: VERIFY_TIMEOUT_MS,
      env: process.env,
    });
    const verifyReason = String(run.stderr || '').match(/KABO_VERIFY_FAIL error_type=([a-z_]+)/)?.[1];
    const knownReasons = ['dir_not_found', 'meta_invalid', 'id_mismatch', 'revoked', 'unexpected_entry', 'empty_dir', 'deferred_mismatch', 'checksum_mismatch', 'signature_invalid', 'unsupported_artifact_format', 'public_key_unavailable', 'plugin_too_old', 'internal_error'];
    diagnostic('verify_finished', { reason: knownReasons.includes(verifyReason) ? verifyReason : null, exit_code: run.status, signal: ['SIGTERM', 'SIGKILL', 'SIGABRT'].includes(run.signal) ? run.signal : null, code: run.error ? errorCode(run.error) : null });
    const lines = relayLines(run.stdout);
    const code = run.status === null ? 1 : run.status;
    if (run.error || code !== 0) {
      const reason = run.error ? run.error.code || 'spawn_failed' : `exit ${code}`;
      emit(eventName, [
        `kabo: skill install by the plugin hook FAILED for ${label} (${reason}); nothing was installed.`,
        ...lines.map((l) => `  ${l}`),
        'A verification failure or revocation means the Skill must not run. If the reason is local (timeout, spawn), fall back to the download-to-unpack bridge once.',
      ].join('\n'));
      return;
    }
    // Verified: move the verified directory into the cache. Replace an existing copy only after the
    // new one is complete, so readers never see a partially written skill directory.
    stage = 'install_cache';
    const verified = path.join(tmpRoot, pkg.id, pkg.version);
    const destParent = path.join(cacheRoot(), pkg.id);
    const dest = path.join(destParent, pkg.version);
    ensurePrivateDir(destParent);
    const displaced = `${dest}.replaced-${nonce}`;
    if (fs.existsSync(dest)) fs.renameSync(dest, displaced);
    fs.renameSync(verified, dest);
    fs.rmSync(displaced, { recursive: true, force: true });
    outcome = 'success';
    diagnostic('installed');
    emit(eventName, [
      `kabo: skill installed and verified by the plugin hook - ${label} is ready in the skill cache. Do NOT run the download-to-unpack bridge or a separate skill-verify for it; route on the digest below.`,
      ...lines.map((l) => `  ${l}`),
      '  exit_code: 0',
    ].join('\n'));
  } catch (error) {
    diagnostic('stage_failed', { code: errorCode(error) });
    emit(eventName, `kabo: skill install by the plugin hook failed for ${label} (${errorCode(error)}); use the download-to-unpack bridge.`);
  } finally {
    stage = 'cleanup';
    for (const target of [packageFile, path.dirname(tmpRoot)]) {
      try { fs.rmSync(target, { recursive: true, force: true }); }
      catch (error) { diagnostic('cleanup_failed', { code: errorCode(error) }); }
    }
  }
}

diagnostic('started');
try {
  await main();
} catch (error) {
  diagnostic('stage_failed', { code: errorCode(error) });
  emit('PostToolUse', `kabo: skill install hook failed during ${stage} (${errorCode(error)}). Diagnostic ID: ${invocation}.`);
} finally {
  diagnostic('finished', { outcome });
}
process.exitCode = 0;
