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
// bridge remains the fallback; staying silent is also safe (the model then uses the bridge).
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

async function readEvent() {
  const chunks = [];
  let total = 0;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_EVENT_BYTES) return null;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(chunks.join(''));
  } catch {
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
  const event = await readEvent();
  if (!event || typeof event !== 'object') return;
  const toolName = String(event.tool_name || '');
  if (!/registry_skill_download$/.test(toolName)) return;
  const pkg = findPackage(event.tool_response);
  const eventName = 'PostToolUse';
  if (!pkg) return;
  if (!safeSegment(pkg.id) || !safeSegment(pkg.version)) {
    emit(eventName, 'kabo: skill install by the plugin hook skipped (unrecognised package id/version); use the download-to-unpack bridge.');
    return;
  }
  const label = `${pkg.id}@${pkg.version}`;
  const staging = path.join(dataRoot(), STAGING_DIRNAME);
  ensurePrivateDir(staging);
  const nonce = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const packageFile = path.join(staging, `${pkg.id}@${pkg.version}-${nonce}.json`);
  const tmpRoot = path.join(staging, `unpack-${nonce}`, 'skill-cache');
  try {
    fs.writeFileSync(packageFile, JSON.stringify(pkg), { mode: 0o600, flag: 'wx' });
    ensurePrivateDir(tmpRoot);
    const run = spawnSync(process.execPath, [SKILL_UNPACK_BIN, '--verify', packageFile, tmpRoot], {
      encoding: 'utf8',
      timeout: VERIFY_TIMEOUT_MS,
      env: process.env,
    });
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
    const verified = path.join(tmpRoot, pkg.id, pkg.version);
    const destParent = path.join(cacheRoot(), pkg.id);
    const dest = path.join(destParent, pkg.version);
    ensurePrivateDir(destParent);
    const displaced = `${dest}.replaced-${nonce}`;
    if (fs.existsSync(dest)) fs.renameSync(dest, displaced);
    fs.renameSync(verified, dest);
    fs.rmSync(displaced, { recursive: true, force: true });
    emit(eventName, [
      `kabo: skill installed and verified by the plugin hook - ${label} is ready in the skill cache. Do NOT run the download-to-unpack bridge or a separate skill-verify for it; route on the digest below.`,
      ...lines.map((l) => `  ${l}`),
      '  exit_code: 0',
    ].join('\n'));
  } catch (error) {
    emit(eventName, `kabo: skill install by the plugin hook failed for ${label} (${error && error.code ? error.code : 'error'}); use the download-to-unpack bridge.`);
  } finally {
    fs.rmSync(packageFile, { force: true });
    fs.rmSync(path.dirname(tmpRoot), { recursive: true, force: true });
  }
}

try {
  await main();
} catch {
  // See FAILURE POSTURE above.
}
process.exitCode = 0;
