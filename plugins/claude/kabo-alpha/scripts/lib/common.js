// Kabo plugin shared utility library (used by both hook scripts and bin/ executables).
//
// Since 0.13.0 the Claude variant authorizes through an RFC 8628 device flow run by `kabo-auth login`,
// and the resulting refresh token lives in one local file (see the credential section at the end):
//   - The user authorizes once per machine: `/kabo-login` -> confirm an 8-character code in a browser
//     tab (any device works), and the token lands in <data root>/credentials.json with mode 0600.
//   - The bundled MCP server is configured with `headersHelper`, so every MCP request asks
//     bin/kabo-headers for the auth header instead of asking the host to run OAuth.
//   - Everything else is unchanged: the three **public read-only** endpoints (GET /api/sync,
//     GET /api/meta-guidance, GET /api/public-key) take no arguments and carry no identity, and this
//     file still never assembles an auth header - that lives in exactly one file, bin/kabo-headers.
//
// What 0.7.0/0.9.0 deleted stays deleted: the static, non-expiring, audience-less environment
// token and the helper written around it (their names stay banned by the test suite, which is why
// they are not spelled here). The token stored now is bound to the `kabo-cli` client and to the MCP
// resource, expires in 30 days, rotates strictly on every renewal, and dies globally the moment
// `auth_revoke_all` is called.
//
// WARNING - collection boundary:
//   Tool-level telemetry is recorded by the server itself; skill-runner start/stop events are
//   reported directly by the mcp_tool hooks in hooks.json, metadata only - no subagent output and
//   no other content-level field ever rides that channel. The client's only local buffer
//   is pending-reports.jsonl: it stores only the **telemetry allowlist fields** of skill-verify
//   failure events, relayed by bin/kabo-headers --relay at session start and pruned once the
//   platform confirms them (see the pending-reports section at the end of this file). Nothing about
//   that buffer is injected into a model's context any more, and the model is not asked to relay it.
//   The allowlist is unchanged by that move: it now guards the relay payload instead of a prompt.
//   The following must never be read, serialized, or reported:
//     - prompt (the user's prompt)
//     - tool_input (tool arguments)
//     - the contents of tool_response
//     - the contents of the transcript file that transcript_path points at
//     - the output of any subagent other than skill-runner
//   Being able to collect it does not mean it should be collected; the implementation side holds this line.
//
// Every function follows the "silent degradation" principle: no failure throws, and none affects the
// user's session.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PLUGIN_VERSION = '0.19.1';
export const SUPPORTED_API_VERSION = '1.0.0';
export const DEFAULT_ENDPOINT = 'https://kabo.sh';
export const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // skill cache TTL: 14 days

// ---------- Paths / endpoint conventions ----------

/**
 * Plugin data root, fixed at ~/.kabo.
 *
 * It cannot be derived from $CLAUDE_PLUGIN_DATA: the host sets that variable only for hook
 * processes, while bin/* is launched by the main agent through Bash and never sees it - one
 * plugin would split into two data roots, and the consequence is revocation markers written
 * under the hook root while skill-verify checks ~/.kabo (the kill-switch stops working).
 * KABO_DATA_ROOT exists only for test isolation.
 */
export function dataRoot() {
  return process.env.KABO_DATA_ROOT || path.join(os.homedir(), '.kabo');
}

/**
 * Platform API root (trailing slashes stripped).
 *
 * The **source** of this value is still exactly one place: `KABO_API_ENDPOINT` or the default
 * https://kabo.sh. 0.13.0 brought back a credentials file, and that file also records an `endpoint`
 * - but it is only ever **compared** against this function's result, never read as the value.
 * If the two disagree, bin/kabo-headers refuses to emit a header at all, which is the cheap
 * client-side version of "do not present A's token to B".
 * hooks and bin/* must use the same source, otherwise the revocation list comes from A while
 * the signature verification public key comes from B.
 */
export function apiEndpoint() {
  const raw = process.env.KABO_API_ENDPOINT || DEFAULT_ENDPOINT;
  return String(raw).replace(/\/+$/, '');
}

export function cacheRoot() {
  return path.join(dataRoot(), 'skill-cache');
}

/**
 * Where a run writes: `<data root>/work/<run-id>/`, one directory per run, created by the
 * skill-runner subagent itself under `umask 077` (see agents/skill-runner.md).
 *
 * Same root as the skill cache, a different branch, and deliberately not the same branch:
 * bin/skill-verify recomputes the checksum of every non-dot file under a cached skill directory,
 * so a single analyzer output left there makes that skill fail checksum_mismatch on its next run.
 * Reclamation is not shared with the cache either, although both use CACHE_TTL_MS: a cache entry's
 * age comes from `downloaded_at` in its .meta.json, while a run directory has no such file and can
 * only be judged by its own mtime. One loop reading two different clocks would silently treat
 * "no .meta.json" as "expired", which is right for the cache and wrong here.
 *
 * Byte-for-byte the same convention as the Codex variant, one root apart (`~/.kabo` here,
 * `$KABO_CODEX_DATA || ~/.kabo/codex` there): the skills that write into it are the same skills,
 * and a per-variant layout would fork their SKILL.md instructions for no gain.
 */
export function workRoot() {
  return path.join(dataRoot(), 'work');
}

/**
 * The onboarding profile `/kabo-start` writes (schema kabo-onboarding-profile.v1): questionnaire
 * answers, the diagnosis, the baseline and the 90-day plan. No secrets, but it is the account's own
 * diagnosis on disk, so logout removes it along with the run work directories (decided 2026-08-23).
 */
export function onboardingProfilePath() {
  return path.join(dataRoot(), 'onboarding-profile.json');
}

/**
 * Where the plugin install root is recorded.
 *
 * The SKILL.md of creator-research skills keeps the upstream delivery verbatim, and it refers to
 * relative paths like `../../config/`, which have to be resolved to `creator-research/` inside the
 * plugin. Resolving needs the plugin's absolute path, but the skill-runner that executes the skill
 * only has Bash - `${CLAUDE_PLUGIN_ROOT}` is a substitution the host performs in **plugin config
 * files** (.mcp.json / hooks.json) and is not guaranteed to appear in the Bash process environment;
 * betting on it is betting on an unverified assumption.
 *
 * The SessionStart hook can compute the plugin root from its own file location, so it writes this
 * file and the runner reads it. No environment variable assumption on that path.
 */
export function pluginRootMarkerPath() {
  return path.join(dataRoot(), 'plugin-root');
}

/**
 * Where the node binary that ran `kabo-auth login` is recorded (one absolute path, one line).
 *
 * Read by the two POSIX sh entry points the host runs directly - bin/kabo-headers.sh (the
 * headersHelper) and scripts/hooks/session-start.sh (the SessionStart hook) - through
 * scripts/lib/node-resolve.sh. A GUI-launched host (the desktop app) does not inherit the shell
 * PATH, so nvm/volta/Homebrew node is invisible to it; a node that just completed a sign-in is a
 * node that exists, so the sign-in records it here and the shims read it back. Same directory as the
 * credential, deliberately NOT a field inside credentials.json: the shims must never open that file.
 * Not a secret, but it goes with the sign-in it was recorded by - logout removes it, and the next
 * login (or the next SessionStart that finds it missing) writes it again.
 */
export function nodePathMarkerPath() {
  return path.join(dataRoot(), 'node-path');
}

/**
 * Record process.execPath in the node-path marker: 0600, written to a temp file and renamed, like
 * the credential itself. Best-effort - failing to record it only costs the desktop app a shortcut
 * (the shims fall back to PATH and the usual install locations), so nothing here may throw.
 * No subprocess: kabo-auth's single permitted spawn is the browser opener.
 */
export function writeNodePathMarker() {
  try {
    const dir = dataRoot();
    ensurePrivateDir(dir);
    const tmp = path.join(dir, `node-path.tmp-${process.pid}`);
    try { fs.rmSync(tmp, { force: true }); } catch { /* the open below reports anything real */ }
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, `${process.execPath}\n`);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, nodePathMarkerPath());
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      throw err;
    }
    fs.chmodSync(nodePathMarkerPath(), 0o600);
  } catch {
    /* best effort, see above */
  }
}

/** The recorded node path (first line, trimmed), or null when nothing usable is recorded. */
export function readNodePathMarker() {
  try {
    const first = fs.readFileSync(nodePathMarkerPath(), 'utf8').split('\n', 1)[0].trim();
    return first || null;
  } catch {
    return null;
  }
}

/** Cache location of the server signing public key, TOFU: pinned on first fetch */
/**
 * TOFU cache path for the server signing public key, **bucketed per endpoint**.
 *
 * A single global path is not usable: the endpoint is decided by KABO_API_ENDPOINT (which a
 * project-level environment variable can set), so a global cache would let any server it points at
 * take the trust anchor seat - after that even the meta-guidance served by kabo.sh would be verified
 * with a poisoned key, and guidance goes straight into the model context.
 * With bucketing each endpoint pins its own key and they never interfere.
 */
export function publicKeyPath(endpoint = apiEndpoint()) {
  const bucket = sha256hex(String(endpoint)).slice(0, 16);
  return path.join(dataRoot(), `public-key.${bucket}.pem`);
}

/**
 * Cache path of the pinned **keyset**, bucketed by exactly the same rule as publicKeyPath.
 *
 * The deadlock of single-key pinning: rotating the key makes signature verification fail on every
 * pinned client at once, and the only way out is clearing the cache and doing TOFU again - which is
 * precisely the step that reopens the man-in-the-middle window. Storing the whole keyset instead
 * means that as long as any pinned key on hand can verify the signature of the keyset the server
 * serves, there is a continuity proof from the old anchor to the new one and the anchor can be
 * rotated wholesale.
 */
export function publicKeysPath(endpoint = apiEndpoint()) {
  const bucket = sha256hex(String(endpoint)).slice(0, 16);
  return path.join(dataRoot(), `public-keys.${bucket}.json`);
}

/** Public key caches for all endpoints (used by logout cleanup); lists the new keysets alongside the single-key PEMs of 0.9.0 and earlier */
export function publicKeyPaths() {
  try {
    return fs.readdirSync(dataRoot())
      .filter((f) => (
        /^public-key\.[0-9a-f]{16}\.pem$/.test(f) || f === 'public-key.pem' ||
        /^public-keys\.[0-9a-f]{16}\.json$/.test(f)
      ))
      .map((f) => path.join(dataRoot(), f));
  } catch {
    return [];
  }
}

/** Local buffer of events awaiting relay (skill-verify failures; see the pending-reports section at the end of this file) */
export function pendingReportsPath() {
  return path.join(dataRoot(), 'pending-reports.jsonl');
}

/** last-known-good cache of signature-verified meta-guidance */
export function guidanceCachePath(endpoint = apiEndpoint()) {
  const bucket = sha256hex(String(endpoint)).slice(0, 16);
  return path.join(dataRoot(), `meta-guidance.${bucket}.json`);
}

/** Guidance caches for all endpoints (used by logout cleanup) */
export function guidanceCachePaths() {
  try {
    return fs.readdirSync(dataRoot())
      .filter((f) => /^meta-guidance\.[0-9a-f]{16}\.json$/.test(f) || f === 'meta-guidance.json')
      .map((f) => path.join(dataRoot(), f));
  } catch {
    return [];
  }
}

/** Local disable marker for revocation: <root>/skill-cache/<id>.disabled */
export function disabledMarkerPath(skillId) {
  return path.join(cacheRoot(), `${skillId}.disabled`);
}

/**
 * Safety check: is a "single-segment directory name" such as a skill id / version legal?
 * Same constraints as assertSafeRelPath in bin/skill-unpack (reject empty, ".", "..", backslash, NUL),
 * plus "must not contain '/'" - used to validate ids that come from server responses (such as
 * sync's revocations).
 * Path-traversal hard rule: an illegal id must never be joined into a path passed to fs.rmSync or a
 * file write, otherwise a value like "../.." can escape skill-cache and delete/write arbitrary
 * directories.
 */
export function isSafeName(name) {
  return (
    typeof name === 'string' &&
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  );
}

/**
 * mkdir -p that keeps the directory private (0700), creation and healing in one place.
 *
 * Everything under the data root is private state (credentials, trust anchors, cached skills, the
 * relay buffer), yet its directories are created lazily by whichever code path runs first - and
 * onboarding field-testing caught the consequence: delete ~/.kabo and the next SessionStart rebuilt
 * it 0755 (the mkdirSync default under the usual umask), because only the login path passed a mode.
 * Every directory-creating path goes through here so the permission no longer depends on which code
 * path won the race to create the root. Node applies `mode` to every directory a recursive call
 * creates, so the whole fresh chain comes out 0700.
 *
 * The chmod is the healing half: `mode` never touches a directory that already exists, so a root the
 * 0755 bug already left behind would otherwise stay world-readable forever. It is best-effort - a
 * pre-existing directory may be owned differently and must not fail the caller. mkdir failures do
 * propagate: callers disagree on whether that is fatal (writeCredentials throws, writeJsonSilent
 * swallows), and this helper must not flatten that difference.
 */
export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* a pre-existing directory may be owned differently */ }
}

/**
 * Normalize a URL that is about to be handed to a platform browser opener, or return null.
 *
 * The verification URL of the device flow arrives **from the server** (RFC 8628
 * `verification_uri_complete`), and kabo-auth spawns an opener with it. A response body is not a
 * trusted input, so it is parsed and constrained before it can reach a subprocess:
 *   - it must parse as an absolute URL (`new URL`), which rules out a bare argv fragment such as
 *     `--flag` or `-e`;
 *   - the scheme must be http/https. Nothing else may be opened: `file:` reads a local file,
 *     `javascript:`/`data:` execute in whatever the platform hands them to, and on Windows several
 *     schemes are registered to interpreters.
 * The **serialized** form is returned rather than the string as received, so whatever reaches argv is
 * the parser's own output with control characters and spaces percent-encoded.
 *
 * @returns {string|null} null = do not open it
 */
export function safeBrowserUrl(value) {
  if (typeof value !== 'string' || value === '') return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.href;
}

// ---------- Local credential: paths, atomic read/write, cross-process lock ----------
//
// This half deliberately contains **no** auth-header literal: assembling the header is
// bin/kabo-headers' job and nothing else's. Splitting "hold the token" from "present the token" is
// what lets the test suite narrow the header ban to exactly one file instead of dropping it.

/** File format version of credentials.json; a file that does not say 1 is treated as absent */
export const CREDENTIALS_VERSION = 1;

/**
 * The one credential file: <data root>/credentials.json.
 *
 * Flat and unbucketed, unlike publicKeyPath/guidanceCachePath. Those cache things that may
 * legitimately coexist for several endpoints; being signed in to two deployments at once is not a
 * real need, and bucketing would buy a second path convention, a second logout enumerator, and a
 * second place to get it wrong. The protection bucketing would have given ("do not hand A's token to
 * B") is provided instead by the endpoint comparison in bin/kabo-headers - earlier and louder.
 */
export function credentialsPath() {
  return path.join(dataRoot(), 'credentials.json');
}

/**
 * Renewal lock: a **directory**, because mkdir is atomic on every platform while open(O_EXCL) is not
 * on some network filesystems.
 */
export function credentialsLockPath() {
  return path.join(dataRoot(), 'credentials.lock');
}

/** Lock protocol constants; all three are frozen - do not retune them in isolation */
export const LOCK_RETRY_MS = 50;
export const LOCK_MAX_WAIT_MS = 2000;
/** A holder can only ever hold the lock for ~6s (the renewal timeout), so 15s is unambiguous abandonment */
export const LOCK_STALE_MS = 15000;

/**
 * Read the credential file.
 * Returns null for "not signed in", which is also what a truncated or foreign-shaped file gets: a
 * half-written JSON and "no credential" must lead to the same recovery path, never to a crash on the
 * hot path.
 */
export function readCredentials() {
  const raw = readJsonSilent(credentialsPath());
  if (!raw || typeof raw !== 'object') return null;
  if (raw.version !== CREDENTIALS_VERSION) return null;
  if (typeof raw.refresh_token !== 'string' || raw.refresh_token === '') return null;
  if (typeof raw.endpoint !== 'string' || raw.endpoint === '') return null;
  return raw;
}

/**
 * Write the credential file **atomically** with mode 0600.
 *
 * Not writeFileSync onto the target: `mode` does not apply to an existing file, and one interrupted
 * write leaves a truncated JSON behind - which is a different thing from "not signed in" on every
 * recovery path. So: create a temp file in the same directory with mode 0600, write, rename over the
 * target, then chmod as a belt-and-braces pass over umask and any permissions inherited from an
 * older file.
 * Throws on failure - unlike the caches in this file, silently failing to persist a credential would
 * show up much later as a mysterious "I have to log in again every time".
 */
export function writeCredentials(credentials) {
  const dir = dataRoot();
  ensurePrivateDir(dir);

  const target = credentialsPath();
  const tmp = path.join(dir, `credentials.json.tmp-${process.pid}`);
  // Remove any leftover from a crashed run with the same pid before opening: `mode` is ignored for an
  // existing file, so reusing one would silently inherit whatever permissions it had.
  try { fs.rmSync(tmp, { force: true }); } catch { /* the open below will report anything real */ }
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(credentials, null, 2)}\n`);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  fs.chmodSync(target, 0o600);
  return target;
}

/**
 * Delete the credential file (and any lock left behind by a killed process).
 *
 * Called on `logout` and whenever the authorization server says the refresh token is dead
 * (`invalid_grant`). It must **not** be called for a network failure: that would turn one flaky
 * minute into a forced re-login.
 */
export function deleteCredentials() {
  let removed = false;
  try {
    if (fs.existsSync(credentialsPath())) removed = true;
    fs.rmSync(credentialsPath(), { force: true });
  } catch { /* one failure does not stop the rest of the cleanup */ }
  try {
    fs.rmSync(credentialsLockPath(), { recursive: true, force: true });
  } catch { /* same */ }
  // A run that died between "write the temp file" and "rename it" leaves a temp file holding a live
  // token. It is rare, but deleting the credential while leaving a copy of it next door is the exact
  // outcome this whole path exists to prevent.
  try {
    for (const name of fs.readdirSync(dataRoot())) {
      if (name.startsWith('credentials.json.tmp-')) fs.rmSync(path.join(dataRoot(), name), { force: true });
    }
  } catch { /* no data root, nothing to sweep */ }
  return removed;
}

/**
 * Sleep helper for the lock retry loop.
 * Deliberately **not** unref'd: this timer is the only thing keeping the process alive while it waits
 * for another process to finish renewing, and an unref'd one lets Node drain the loop and exit 13
 * ("unsettled top-level await") - which looks to the host exactly like a helper that produced nothing.
 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Try to take the renewal lock, waiting up to LOCK_MAX_WAIT_MS.
 *
 * Why a lock is a correctness requirement and not an optimization: the server rotates refresh tokens
 * strictly once (no reuse window), so two concurrent kabo-headers renewing with the same refresh
 * token guarantees one `invalid_grant` - and `invalid_grant` means "delete the credential file".
 * Without this lock, ordinary concurrent tool calls would randomly sign the user out.
 *
 * @returns {Promise<boolean>} false = give up; the caller must NOT force its way in, it re-reads the
 *   file instead (someone else has very likely just renewed it).
 */
export async function acquireCredentialLock(maxWaitMs = LOCK_MAX_WAIT_MS) {
  const lock = credentialsLockPath();
  const deadline = Date.now() + maxWaitMs;
  let breakAttempted = false;
  for (;;) {
    try {
      ensurePrivateDir(path.dirname(lock));
      fs.mkdirSync(lock);
      return true;
    } catch (err) {
      if (err && err.code !== 'EEXIST') return false;
    }
    // Stale lock: the only holder that can exist held it for at most the renewal timeout, so a
    // directory older than LOCK_STALE_MS belongs to a process that died. Break it once - repeatedly
    // breaking would race two "rescuers" against each other.
    if (!breakAttempted) {
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > LOCK_STALE_MS) {
          breakAttempted = true;
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch { /* it vanished between the two calls: just retry */ }
    }
    if (Date.now() >= deadline) return false;
    await sleep(LOCK_RETRY_MS);
  }
}

/** Release the renewal lock; safe to call when it was never taken */
export function releaseCredentialLock() {
  try {
    fs.rmSync(credentialsLockPath(), { recursive: true, force: true });
  } catch { /* the stale-lock rule in acquireCredentialLock is the backstop */ }
}

// ---------- stdin / JSON helpers ----------

/**
 * Read the hook event JSON from stdin; returns null on a TTY (manual run) or on parse failure.
 */
export async function readStdinJson() {
  try {
    if (process.stdin.isTTY) return null; // do not hang when run by hand with no piped input
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Read a JSON file silently; returns fallback on failure */
export function readJsonSilent(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write a JSON file silently (creating directories, kept 0700 - see ensurePrivateDir); never throws on failure */
export function writeJsonSilent(file, obj) {
  try {
    ensurePrivateDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

// ---------- checksum ----------
//
// WARNING: everything from here to computeChecksum is the client half of a two-sided agreement - the
// server's signing implementation must build the very same bytes from the very same files, and a
// cross-repo test pins both sides to shared vectors. Change the manifest construction (the sort key,
// the separators, the prefix line, the path rules) on one side only and every artifact the server
// signs stops verifying here: do not change it unilaterally.

export function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * The only signed-artifact format this plugin can verify.
 *
 * Deliberately a single value and not a range: a client that guesses at an unknown version would be
 * verifying new bytes with old rules, which is the one failure mode a format field exists to prevent.
 */
export const PLUGIN_ARTIFACT_FORMAT_VERSION = 1;

/**
 * Path rules of the signed manifest, byte-for-byte the server's assertion set.
 *
 * The list is closed on purpose - **an implementation must not add a rule of its own**. Every extra
 * rule is a path the server will happily sign and this client will then refuse, which surfaces to the
 * user as "the package is corrupt" while nothing is corrupt at all. Two consequences worth spelling
 * out because they look like omissions:
 *   - `\r` (U+000D) is legal in a path;
 *   - no Unicode normalization happens anywhere, so the NFC and NFD spellings of one grapheme are two
 *     distinct paths that sort at two different positions.
 * The dot-prefix rule is what keeps `.meta.json` outside signature coverage - see skill-verify.
 */
function assertArtifactPath(p) {
  const reject = (why) => {
    throw new Error(`illegal signed-artifact path (${why}): ${JSON.stringify(p)}`);
  };
  if (typeof p !== 'string' || p.length === 0) reject('empty');
  if (p.includes('\\') || p.includes('\0') || p.includes('\n')) reject('illegal character');
  if (p.startsWith('/')) reject('absolute');
  // "." and ".." are already covered by the dot-prefix rule; the empty segment catches both a
  // doubled separator and a trailing "/".
  for (const seg of p.split('/')) {
    if (seg === '' || seg.startsWith('.')) reject('illegal segment');
  }
}

/**
 * Canonical manifest bytes of a signed artifact.
 *
 * Two formats live here at once, and which one applies is decided **by the wire**, never by a guess
 * (see the compat rule in artifactFormatOf below):
 *
 *   formatVersion === 1  ->  CANON-V1: a `kabo.artifact-format\0<n>\n` prefix line, then one line per
 *                            file, with the files sorted by the **UTF-8 bytes** of their path.
 *   formatVersion == null ->  CANON-V0: the pre-format_version bytes - no prefix line, and the sort is
 *                            a plain JS string comparison, i.e. UTF-16 code-unit order.
 *
 * The sort key is the load-bearing clause and the two orders really do disagree: `a < b` on JS strings
 * compares UTF-16 code units, so a path holding a non-BMP character (a surrogate pair, lead unit
 * U+D800-U+DBFF) sorts *before* a path holding a BMP character in U+E000-U+FFFF, while their UTF-8
 * bytes sort the other way round (0xF0.. vs 0xEF..). An all-ASCII vector cannot tell the two apart,
 * which is exactly how the wrong sort survived in this file until 0.14.0 - the conformance vectors
 * now pin a non-BMP case for that reason.
 *
 * @param {{path: string, content: Buffer}[]} files
 * @param {1|null} formatVersion the value carried by the envelope; null means "the field was absent"
 */
export function canonicalManifest(files, formatVersion = null) {
  if (formatVersion === null || formatVersion === undefined) {
    const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    let manifest = '';
    for (const f of sorted) {
      manifest += f.path + '\0' + sha256hex(f.content) + '\n';
    }
    return Buffer.from(manifest, 'utf8');
  }
  // Fail closed on anything else: no forward guess, no "probably compatible".
  if (formatVersion !== PLUGIN_ARTIFACT_FORMAT_VERSION) {
    throw new Error(`unsupported_artifact_format: ${JSON.stringify(formatVersion)}`);
  }
  for (const f of files) assertArtifactPath(f.path);
  const sorted = [...files].sort(
    (a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')),
  );
  for (let i = 1; i < sorted.length; i += 1) {
    // Two entries with one path would make the manifest ambiguous: the same bytes could be produced
    // by two different file sets, so one signature would cover both.
    if (sorted[i].path === sorted[i - 1].path) {
      throw new Error(`duplicate signed-artifact path: ${JSON.stringify(sorted[i].path)}`);
    }
  }
  let manifest = `kabo.artifact-format\0${formatVersion}\n`;
  for (const f of sorted) {
    manifest += f.path + '\0' + sha256hex(f.content) + '\n';
  }
  return Buffer.from(manifest, 'utf8');
}

/**
 * checksum = sha256hex(canonical manifest bytes). Throws for an unsupported format version or an
 * illegal path - both are refusals, and every caller on a hot path turns them into a rejection rather
 * than letting them escape (silent degradation).
 * @param {{path: string, content: Buffer}[]} files
 * @param {1|null} formatVersion
 */
export function computeChecksum(files, formatVersion = null) {
  return sha256hex(canonicalManifest(files, formatVersion));
}

/**
 * The compat rule for `format_version` on the wire (v0.14.0), applied identically by skill packages,
 * meta-guidance and the keyset.
 *
 * The field is required by the server's contract schemas, and artifacts predating it may still be
 * cached or in flight, so the client has to handle both shapes:
 *
 *   present and === 1  -> CANON-V1
 *   present and  != 1  -> refuse (`unsupported_artifact_format`); never fall back
 *   absent             -> CANON-V0, until the sunset
 *
 * Four rules hold this together, and none of them may be relaxed into "try both and take whichever
 * matches" - that would make the field decorative and re-admit the bug it exists to prevent:
 *   1. no downgrade: a v1 envelope that fails is a hard failure, never a CANON-V0 retry;
 *   2. no upgrade guess: an envelope with no field is never tried as v1;
 *   3. both directions stay single-shot;
 *   4. therefore every mismatched combination - stripping the field from a v1 envelope, injecting
 *      `format_version: 1` into a legacy one - ends in a checksum mismatch. The dual-format window
 *      can cause a refusal; it cannot cause an acceptance.
 *
 * @returns {{ok: true, formatVersion: 1|null} | {ok: false, formatVersion: null}}
 */
export function artifactFormatOf(carrier) {
  const raw = carrier && typeof carrier === 'object' ? carrier.format_version : undefined;
  if (raw === undefined || raw === null) return { ok: true, formatVersion: null };
  if (raw !== PLUGIN_ARTIFACT_FORMAT_VERSION) return { ok: false, formatVersion: null };
  return { ok: true, formatVersion: PLUGIN_ARTIFACT_FORMAT_VERSION };
}

// ---------- Version comparison (same semantics as the server's own compareSemver) ----------

/**
 * Three-segment numeric comparison: split on ".", each segment parseInt(x,10)||0, missing
 * segments count as 0, only the first three segments matter.
 * Since 0.7.0 update detection moved to the client (the public GET /api/sync does not accept
 * installed_skills), so this implementation must be verbatim identical in semantics to the
 * server's, otherwise the "updatable" counts disagree between the two sides. A cross-repo test pins
 * both implementations to the same vectors: this one must not be changed on its own.
 * @returns {-1|0|1}
 */
export function compareSemver(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

// ---------- HTTP (Node's built-in fetch, silent degradation) ----------

/**
 * JSON request with a timeout; network errors, timeouts, non-2xx, and parse failures all return null.
 */
export async function fetchJsonSilent(url, options = {}, timeoutMs = 3000) {
  try {
    const res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ---------- Server public key (TOFU cache) ----------

/**
 * Fetch the server's Ed25519 signing public key (**legacy single-key interface**; since 0.10.0 the
 * Claude variant uses ensureVerified instead).
 *
 * Why it is kept: the Codex variant and cross-repo tests still call this signature. Semantics are
 * unchanged - prefer the locally cached single-key PEM, otherwise GET /api/public-key for the active
 * public key and cache it; return null if it cannot be fetched (callers treat that as "cannot verify
 * the signature" and never let unverified content through).
 * It does not understand keysets, so during a key rotation it can only verify against the active key;
 * paths that need continuity should go through ensureVerified.
 */
export async function loadPublicKeyPem(endpoint = apiEndpoint(), timeoutMs = 3000) {
  const cached = publicKeyPath(endpoint);
  try {
    const pem = fs.readFileSync(cached, 'utf8');
    if (pem.includes('PUBLIC KEY')) return pem;
  } catch { /* no cache, go to the network */ }

  const resp = await fetchJsonSilent(`${endpoint}/api/public-key`, {}, timeoutMs);
  if (!resp || typeof resp.public_key_pem !== 'string' || !resp.public_key_pem.includes('PUBLIC KEY')) {
    return null;
  }
  try {
    ensurePrivateDir(path.dirname(cached));
    fs.writeFileSync(cached, resp.public_key_pem);
  } catch { /* a cache write failure does not affect this verification */ }
  return resp.public_key_pem;
}

// ---------- Signing keyset: TOFU + continuity refresh ----------

/**
 * Pseudo path for the keyset's canonical bytes.
 * Domain separation must live **inside the signed bytes**: the signed object is just a bare 64-hex
 * string, and if the pseudo path is not folded into the checksum, a legitimate {checksum, signature}
 * pair (from a skill package, or from guidance) could be lifted as-is and passed off as a keyset
 * signature - which would let any creator's signed package swap in a trust anchor of its own.
 */
const KEYSET_PSEUDO_PATH = 'kabo.keyset/keys.json';

/** Keyset size cap: normally there are only two keys, active (+ retiring); the cap blocks a response that stuffs in hundreds */
export const MAX_KEYSET_KEYS = 8;

/**
 * kid = sha256hex(SPKI DER).slice(0, 16).
 * DER rather than PEM: PEM line breaks and trailing whitespace are unstable across implementations,
 * so the same key would produce two different kids and the self-check "kid must equal the kid
 * recomputed from the PEM" would fail for no reason.
 * @returns {string|null} null for an invalid or unparseable public key
 */
export function keyIdFromPem(pem) {
  try {
    const der = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
    return sha256hex(der).slice(0, 16);
  } catch {
    return null;
  }
}

function sortKeysByKid(keys) {
  return [...keys].sort((a, b) => (a.kid < b.kid ? -1 : a.kid > b.kid ? 1 : 0));
}

/**
 * Canonical bytes of the keyset.
 * Built from an object literal + JSON.stringify rather than string concatenation: both sides (here
 * and the server's signer) construct the literal with the same fixed property order, and every JS
 * implementation emits insertion order, so the bytes are reproducible.
 * The property order is part of the signature - change it anywhere and every pinned client will
 * treat the keyset as tampered with.
 */
export function keysetCanonicalBytes(keyset) {
  const keys = sortKeysByKid(keyset.keys).map((k) => ({ kid: k.kid, public_key_pem: k.public_key_pem }));
  return Buffer.from(JSON.stringify({ issued_at: keyset.issued_at, keys }), 'utf8');
}

/**
 * Keyset checksum: reuses the checksum function above, with the pseudo path providing domain
 * separation. `formatVersion` comes from the /api/public-key response and nowhere else - getting this
 * one wrong is the worst of the three, because a keyset that fails to verify means the anchor cannot
 * rotate and every fresh install and every key rotation dies with `public_key_unavailable`.
 */
export function keysetChecksum(keyset, formatVersion = null) {
  return computeChecksum(
    [{ path: KEYSET_PSEUDO_PATH, content: keysetCanonicalBytes(keyset) }],
    formatVersion,
  );
}

function normalizeKeyEntry(entry) {
  if (!entry || typeof entry.kid !== 'string' || typeof entry.public_key_pem !== 'string') return null;
  if (!entry.public_key_pem.includes('PUBLIC KEY')) return null;
  return { kid: entry.kid, public_key_pem: entry.public_key_pem };
}

/**
 * Read the pinned keyset.
 * Order: the new format <data root>/public-keys.<bucket>.json -> the single-key PEM of 0.9.0 and
 * earlier (synthesized into a one-key keyset with issued_at set to null, meaning "we do not know
 * when this anchor was issued") -> null if neither exists.
 * The fallback step cannot be skipped: users upgrading to 0.10.0 only have that .pem, and dropping
 * it would force every machine to redo TOFU, opening a man-in-the-middle window for nothing.
 * @returns {{issued_at: string|null, keys: {kid: string, public_key_pem: string}[]}|null}
 */
export function loadKeyset(endpoint = apiEndpoint()) {
  const cached = readJsonSilent(publicKeysPath(endpoint));
  if (cached && Array.isArray(cached.keys)) {
    const keys = cached.keys.map(normalizeKeyEntry).filter(Boolean).slice(0, MAX_KEYSET_KEYS);
    if (keys.length > 0) {
      return {
        issued_at: typeof cached.issued_at === 'string' ? cached.issued_at : null,
        keys,
      };
    }
  }

  try {
    const pem = fs.readFileSync(publicKeyPath(endpoint), 'utf8');
    const kid = pem.includes('PUBLIC KEY') ? keyIdFromPem(pem) : null;
    if (kid) return { issued_at: null, keys: [{ kid, public_key_pem: pem }] };
  } catch { /* no legacy cache */ }

  // Built-in trust anchor: trusted-keys.json ships with the plugin and **applies only to the default
  // endpoint**. First contact changes from "believe whatever the network says" (blind TOFU) to "the
  // server's keyset must verify against a built-in key" (continuity), putting the trust root back on
  // "the plugin the user installed". Custom endpoints (self-hosted / development servers) have their
  // own keys, for which the built-in anchor is simply wrong, so they keep the original TOFU behavior.
  if (endpoint === DEFAULT_ENDPOINT) {
    const bundledPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'trusted-keys.json',
    );
    const bundled = readJsonSilent(bundledPath);
    if (bundled && Array.isArray(bundled.keys)) {
      const keys = bundled.keys.map(normalizeKeyEntry).filter(Boolean).slice(0, MAX_KEYSET_KEYS);
      if (keys.length > 0) return { issued_at: null, keys };
    }
  }

  return null;
}

/** Verify one keyset signature with one public key (the signed object = the UTF-8 bytes of keyset_checksum) */
function verifyKeysetSignature(pem, signatureB64, checksum) {
  try {
    return crypto.verify(
      null,
      Buffer.from(checksum, 'utf8'),
      crypto.createPublicKey(pem),
      Buffer.from(signatureB64, 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * Fetch a new keyset and decide whether to rotate the anchor.
 * @param {string} endpoint
 * @param {ReturnType<typeof loadKeyset>} pinned the pinned keyset (null = first-time TOFU)
 * @returns {Promise<ReturnType<typeof loadKeyset>>} the accepted, persisted new keyset; null if not accepted
 */
async function refreshKeyset(endpoint, pinned, timeoutMs) {
  const resp = await fetchJsonSilent(`${endpoint}/api/public-key`, {}, timeoutMs);
  if (!resp || typeof resp !== 'object') return null;

  // The response decides which canonical bytes the keyset_checksum was built from; an unknown value
  // is a refusal, not a guess (see artifactFormatOf). Refusing here costs a rotation, not a
  // compromise: the client keeps the anchor it already trusts.
  const format = artifactFormatOf(resp);
  if (!format.ok) return null;

  // ---- Legacy server: only public_key_pem, no keyset ----
  if (!resp.keyset || typeof resp.keyset !== 'object' || !Array.isArray(resp.keyset.keys)) {
    if (pinned) {
      // With no keyset there is no continuity proof to check. A PEM identical to the pinned one =
      // nothing happened; a different one = there is no proof this new key came from the holder of
      // the old key, so never rotate the anchor (rotation must go through the keyset channel).
      return null;
    }
    const pem = resp.public_key_pem;
    if (typeof pem !== 'string' || !pem.includes('PUBLIC KEY')) return null;
    const kid = keyIdFromPem(pem);
    if (!kid) return null;
    const next = { issued_at: null, keys: [{ kid, public_key_pem: pem }] };
    writeJsonSilent(publicKeysPath(endpoint), next);
    return next;
  }

  // ---- Keyset shape validation: confirm the keyset is self-consistent before discussing trust ----
  const raw = resp.keyset;
  if (raw.keys.length < 1 || raw.keys.length > MAX_KEYSET_KEYS) return null;
  // issued_at must be parseable: replay protection relies on it for a monotonic comparison, and
  // pinning a value that Date.parse cannot handle distorts the criteria of every later continuity
  // refresh - which amounts to permanently disabling old-keyset replay protection.
  if (typeof raw.issued_at !== 'string' || !Number.isFinite(Date.parse(raw.issued_at))) return null;
  const seen = new Set();
  const keys = [];
  for (const entry of raw.keys) {
    const k = normalizeKeyEntry(entry);
    if (!k) return null;
    // The kid must be derived from the key itself: otherwise a response could hang a pinned key's
    // kid on an unknown key and slip past the key_id selection step (signature verification would
    // still fail, but the error type would change from "key rotation" to "tampering").
    if (keyIdFromPem(k.public_key_pem) !== k.kid) return null;
    if (seen.has(k.kid)) return null; // a duplicate kid makes key selection ambiguous
    seen.add(k.kid);
    keys.push(k);
  }
  const next = { issued_at: raw.issued_at, keys: sortKeysByKid(keys) };
  let checksum;
  try {
    checksum = keysetChecksum(next, format.formatVersion);
  } catch {
    return null; // an unusable format/path is a refusal, and a refusal on this path is silent
  }
  if (typeof resp.keyset_checksum !== 'string' || checksum !== resp.keyset_checksum) return null;

  const signatures = (Array.isArray(resp.keyset_signatures) ? resp.keyset_signatures : [])
    .filter((s) => s && typeof s.signature === 'string');

  if (!pinned) {
    // TOFU: this is the first time this keyset has been seen on the network, and there is nothing to
    // check beyond "prove you hold the key" - require that the active_kid key itself signed this
    // keyset, which at least rules out a man-in-the-middle who forwards someone else's keyset without
    // holding the matching private key. The real trust decision is still TOFU itself.
    const active = typeof resp.active_kid === 'string' ? resp.active_kid : null;
    const activeKey = active ? next.keys.find((k) => k.kid === active) : null;
    if (!activeKey) return null;
    const selfProven = signatures.some(
      (s) => s.kid === active && verifyKeysetSignature(activeKey.public_key_pem, s.signature, checksum),
    );
    if (!selfProven) return null;
  } else {
    // continuity: some signature must verify against a **pinned** key - that is the bridge from the
    // old anchor to the new one.
    const proven = signatures.some((s) => pinned.keys.some(
      (pk) => verifyKeysetSignature(pk.public_key_pem, s.signature, checksum),
    ));
    if (!proven) return null;

    // Replay protection: an old keyset really was issued at some point in history, so its signature
    // stays valid forever. Without comparing issued_at, an attacker replaying an old keyset from
    // within the grace period could reinstall an already-removed key into the client's anchor.
    const prev = pinned.issued_at ? Date.parse(pinned.issued_at) : NaN;
    const cur = Date.parse(next.issued_at);
    if (!Number.isFinite(cur)) return null;
    if (Number.isFinite(prev) && cur < prev) return null;
  }

  writeJsonSilent(publicKeysPath(endpoint), next); // wholesale replacement, no merging
  return next;
}

/**
 * At most one refresh per process per endpoint.
 * A refresh goes over the network, and in a tampering scenario failed signature verification is the
 * norm: without this gate a bulk verification loop would DoS /api/public-key, and every failure
 * would cost an extra network timeout.
 */
const refreshedEndpoints = new Set();

/**
 * Multi-key signature verification helper: shared by skill packages and meta-guidance.
 *
 * 1. Try the pinned keys first (the one matching key_id goes first, purely to save a computation);
 * 2. All fail and "key_id is not among the pinned keys / there are no pinned keys at all" -> the key
 *    may have rotated, so refresh once and retry;
 * 3. key_id matches a pinned key but verification fails = the content was tampered with, not a key
 *    rotation - never refresh (a refresh would only add a pointless network round trip and let a
 *    tamperer drive the client into fetching keys repeatedly by manufacturing failures).
 *
 * @param {(pem: string) => boolean} attempt verify once with one public key, returning true on success (a thrown exception counts as failure)
 * @param {{endpoint?: string, keyId?: string|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, reason: null|'signature_invalid'|'public_key_unavailable'}>}
 */
export async function ensureVerified(attempt, opts = {}) {
  const endpoint = opts.endpoint || apiEndpoint();
  const keyId = typeof opts.keyId === 'string' && opts.keyId !== '' ? opts.keyId : null;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 3000;

  const tryKeyset = (keyset) => {
    if (!keyset) return false;
    const ordered = keyId
      ? [...keyset.keys.filter((k) => k.kid === keyId), ...keyset.keys.filter((k) => k.kid !== keyId)]
      : keyset.keys;
    for (const k of ordered) {
      let ok = false;
      try {
        ok = attempt(k.public_key_pem) === true;
      } catch {
        ok = false; // a parse/verify error on one key does not mean the content is bad, try the next
      }
      if (ok) return true;
    }
    return false;
  };

  const pinned = loadKeyset(endpoint);
  if (tryKeyset(pinned)) return { ok: true, reason: null };

  const failure = () => ({ ok: false, reason: pinned ? 'signature_invalid' : 'public_key_unavailable' });
  if (pinned && keyId && pinned.keys.some((k) => k.kid === keyId)) {
    return { ok: false, reason: 'signature_invalid' };
  }
  if (refreshedEndpoints.has(endpoint)) return failure();
  refreshedEndpoints.add(endpoint);

  const next = await refreshKeyset(endpoint, pinned, timeoutMs);
  if (!next) return failure();
  if (tryKeyset(next)) return { ok: true, reason: null };
  return { ok: false, reason: 'signature_invalid' };
}

// ---------- pending-reports relay buffer ----------
//
// skill-verify is a Bash subprocess that cannot see MCP and must not touch the credential, so on
// failure it leaves a line here and something else relays it later.
//
// 2026-09-03: that "something else" is no longer the model. Until now SessionStart injected the
// buffered events into the session's opening context and asked the main agent to call
// telemetry_report_usage. Two things were wrong with it, both observed in the field:
//   - **A model is right to refuse.** "Text injected at session start tells you to call a tool" is
//     the shape of a prompt-injection attack, so a model following its safety rules reports the
//     request to the user instead of doing it. The queue then never drains - it only drains on the
//     rare session where the user explicitly authorizes it.
//   - **Nothing could ever confirm the relay**, so relayed entries were never removed (see the
//     rationale that used to live on pendingEventId) and the same events were re-injected into
//     every new session until the 7-day TTL expired - burning opening context each time for events
//     the server already had (a relay of them answers `duplicates: N`).
// The relay now runs in `bin/kabo-headers --relay`, spawned by SessionStart exactly like `--probe`:
// the one file allowed to hold the token does the authenticated POST, gets a real tool result back,
// and prunes exactly the entries the server confirmed. No prompt is injected and the model is not
// involved. The desktop app reached the same conclusion first (apps/desktop main-process direct
// reporting), and this is the CLI half of it.
//
// Only telemetry allowlist fields are written: skill_id / skill_version / error_type / status / ts -
// no paths, no file contents, no user input of any kind.

/** Expiry threshold: a failure older than 7 days has no diagnostic value left, and keeping it only makes the injected section grow */
export const PENDING_REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Maximum entries kept in the file (so a broken loop cannot blow the file up) */
export const PENDING_REPORT_MAX = 100;

/**
 * Deterministic event_id: the same (skill, version, error_type) on the same day yields one id.
 * The server's (user_id, event_id) uniqueness constraint therefore makes relaying naturally
 * idempotent - a repeated relay is swallowed as a duplicate.
 *
 * That idempotence is why a *lost* prune is harmless (the entry is simply relayed again), not a
 * reason to keep relayed entries forever: until 2026-09-03 this comment argued the client could
 * never confirm a relay, so entries only left by TTL or cap. `--relay` gets an actual tool result,
 * so a confirmed batch is pruned (dropPendingReports) and only unconfirmed entries wait.
 */
export function pendingEventId({ skill_id, skill_version, error_type, ts } = {}) {
  const day = new Date(Date.parse(ts) || Date.now()).toISOString().slice(0, 10);
  return sha256hex([
    'skill_verify_fail',
    skill_id || '-',
    skill_version || '-',
    error_type || '-',
    day,
  ].join('\0')).slice(0, 32);
}

/** Let through only telemetry allowlist fields, and keep non-strings out along the way */
function normalizePendingEntry(entry) {
  if (!entry || entry.event !== 'skill_verify_fail') return null;
  if (typeof entry.event_id !== 'string' || !/^[0-9a-f]{32}$/.test(entry.event_id)) return null;
  if (typeof entry.ts !== 'string' || !Number.isFinite(Date.parse(entry.ts))) return null;
  // Per-field character-set allowlist - this is a security boundary, not data cleaning.
  // skill_id/skill_version come from the **top-level** fields of the SkillPackage, which are outside
  // the coverage of the checksum/signature (the checksum only covers files), so a malicious response
  // can set them to arbitrary text; and these entries get injected verbatim into the model context in
  // the next session. Tightening them to the character set a directory name / version number should
  // have keeps free text out of the buffer, which removes the injection vector entirely.
  // error_type is generated by our own code but is tightened just the same - in case the buffer file
  // is tampered with locally and used as an injection route.
  const out = { event: 'skill_verify_fail', event_id: entry.event_id };
  if (typeof entry.skill_id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(entry.skill_id)) {
    out.skill_id = entry.skill_id;
  }
  if (typeof entry.skill_version === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(entry.skill_version)) {
    out.skill_version = entry.skill_version;
  }
  if (typeof entry.error_type !== 'string' || !/^[a-z_]{1,64}$/.test(entry.error_type)) return null;
  out.error_type = entry.error_type;
  out.status = 'error';
  out.ts = entry.ts;
  return out;
}

/**
 * Best-effort append of one event awaiting relay. Any failure is silent - it must never affect the
 * caller's main flow (skill-verify's exit 1 semantics and its final stderr line are unaffected).
 * @returns {object|null} the entry actually written
 */
export function appendPendingReport({ skill_id, skill_version, error_type } = {}) {
  try {
    const ts = new Date().toISOString();
    const entry = normalizePendingEntry({
      event: 'skill_verify_fail',
      event_id: pendingEventId({ skill_id, skill_version, error_type, ts }),
      skill_id,
      skill_version,
      error_type,
      status: 'error',
      ts,
    });
    if (!entry) return null;
    ensurePrivateDir(path.dirname(pendingReportsPath()));
    fs.appendFileSync(pendingReportsPath(), JSON.stringify(entry) + '\n');
    return entry;
  } catch {
    return null;
  }
}

/**
 * Read the buffer and prune it in place: drop entries past the TTL, keep only the newest
 * PENDING_REPORT_MAX, then rewrite the file.
 * Pruning happens on the reading side (SessionStart), not the writing side: skill-verify is on the
 * hot path, and rewriting the whole file on every failure would be slow and prone to truncating
 * itself under concurrency.
 * @returns {object[]} the valid entries, oldest to newest
 */
export function readAndPrunePendingReports(now = Date.now()) {
  const file = pendingReportsPath();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const kept = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry = null;
    try {
      entry = normalizePendingEntry(JSON.parse(line));
    } catch { /* bad lines are dropped and simply vanish on rewrite */ }
    if (!entry) continue;
    if (now - Date.parse(entry.ts) > PENDING_REPORT_TTL_MS) continue;
    kept.push(entry);
  }
  const pruned = kept.slice(-PENDING_REPORT_MAX);
  rewritePendingBuffer(file, text, pruned);
  return pruned;
}

/**
 * Rewrite the buffer to exactly `keep`, atomically, without losing lines another process appended
 * since `originalText` was read. Best effort throughout: a failed rewrite never propagates.
 *
 * Concurrency safety: when two sessions share one data root, another process may have appended new
 * lines after the read, and rewriting the whole file would erase them. The tail added since the
 * first read is appended verbatim, then the result lands atomically via temp file + rename.
 * There is still a microsecond window between "re-read" and "rename", which is accepted:
 * event_id is derived deterministically, so the same failure recurring on the same day produces the
 * same entry - losing a line delays a report at most, it does not lose uniqueness. For a prune after
 * a confirmed relay the same window is equally harmless in the other direction: a lost prune costs
 * one duplicate relay, which the server swallows.
 */
function rewritePendingBuffer(file, originalText, keep) {
  try {
    const rewritten = keep.map((e) => JSON.stringify(e) + '\n').join('');
    if (rewritten === originalText) return;
    let tail = '';
    try {
      const latest = fs.readFileSync(file, 'utf8');
      if (latest.length > originalText.length && latest.startsWith(originalText)) {
        tail = latest.slice(originalText.length);
      }
    } catch { /* if it cannot be read, treat it as having no additions */ }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, rewritten + tail);
    fs.renameSync(tmp, file);
  } catch { /* a failed rewrite does not affect the caller */ }
}

/**
 * Drop the given event_ids from the buffer - what a **confirmed** relay leaves behind.
 * Only ids the server acknowledged are passed in, so an unconfirmed entry always survives to be
 * retried; everything else about the file (TTL pruning, the cap, bad lines) is left to the reader.
 * @param {string[]} eventIds
 * @returns {number} how many entries were removed
 */
export function dropPendingReports(eventIds) {
  const drop = new Set(Array.isArray(eventIds) ? eventIds : []);
  if (drop.size === 0) return 0;
  const file = pendingReportsPath();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  const keep = [];
  let removed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry = null;
    try {
      entry = normalizePendingEntry(JSON.parse(line));
    } catch { /* bad lines vanish on rewrite, same as on the reading path */ }
    if (!entry) continue;
    if (drop.has(entry.event_id)) {
      removed += 1;
      continue;
    }
    keep.push(entry);
  }
  if (removed > 0) rewritePendingBuffer(file, text, keep);
  return removed;
}

// ---------- minimal MCP client wire (no credential, no request header) ----------
//
// These two helpers exist so that `bin/kabo-headers --relay` stays a thin file: it holds the token
// and does the fetch, and everything that is merely protocol lives here, where no token ever is.
// Same shape as the desktop app's mcp-wire: the platform MCP face is stateless Streamable HTTP
// (a fresh server+transport per request, enableJsonResponse), so two plain JSON-RPC POSTs -
// initialize, then tools/call - are the whole client. Pulling in the MCP SDK for that is pure weight.

/** Matches the server's own initialize test case; the server stays backward compatible with older values. */
export const MCP_PROTOCOL_VERSION = '2025-03-26';

/** The JSON-RPC bodies of a one-shot `tools/call`, in order. `id` is positional, not meaningful. */
export function buildToolCallRpcBodies(toolName, args) {
  return [
    {
      id: 1,
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'kabo-plugin', version: '1' },
      },
    },
    {
      id: 2,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    },
  ];
}

/**
 * Tolerant parse of one JSON-RPC response. Under enableJsonResponse the server answers plain JSON,
 * but Streamable HTTP also permits text/event-stream frames - accept both: try the whole body, then
 * scan for `data:` lines and take the one whose id matches. Returns null when nothing parses, and
 * the caller must treat null as "not a success" (a tolerant parse is not a tolerant verdict).
 */
export function parseRpcMessage(text, expectedId) {
  const asRecord = (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const tryParse = (raw) => {
    try {
      return asRecord(JSON.parse(raw));
    } catch {
      return null;
    }
  };
  const whole = tryParse(text);
  if (whole) return whole.id === expectedId ? whole : null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const message = tryParse(line.slice(5).trim());
    if (message && message.id === expectedId) return message;
  }
  return null;
}

/**
 * Did a `tools/call` response actually ingest the batch?
 *
 * A tool-level failure arrives as `result.isError`, not as a JSON-RPC error - treating that as
 * success is exactly how a buffer gets pruned while the server took nothing. Anything unparseable
 * is a "no" as well.
 */
export function toolCallSucceeded(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.error !== undefined) return false;
  const result = message.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  return result.isError !== true;
}

// ---------- meta-guidance signature envelope ----------

/** Injection fence sentinels. If either sentinel appears in content, reject the whole thing (otherwise the content could close the fence itself) */
export const GUIDANCE_BEGIN = '<<<KABO-META-GUIDANCE-BEGIN>>>';
export const GUIDANCE_END = '<<<KABO-META-GUIDANCE-END>>>';

/** Server-side hard cap; the client re-checks it independently and does not trust the length the response claims */
export const MAX_GUIDANCE_CONTENT_CHARS = 8000;
/** The host's cap on additionalContext (anything over it gets written to disk and replaced with a preview, i.e. the guidance stops working) */
export const MAX_ADDITIONAL_CONTEXT_CHARS = 10000;
/** Clock skew tolerance: how far ahead of local time issued_at may be */
export const GUIDANCE_CLOCK_SKEW_MS = 5 * 60 * 1000;

const GUIDANCE_TYPE = 'kabo.meta-guidance';
const GUIDANCE_HEADER_PATH = 'kabo.meta-guidance/header.txt';
const GUIDANCE_CONTENT_PATH = 'kabo.meta-guidance/content.md';

/**
 * Rebuild the signed header text.
 *
 * Fixed order, nothing added or removed, each line `key + ": " + value + "\n"`:
 *   format_version (v1 only) / type / guidance_version / issued_at / expires_at / resource.
 * Deliberately not JSON: key order, whitespace, and number formatting cannot be guaranteed
 * byte-identical between two language implementations, while signature comparison requires both
 * sides to assemble **exactly the same bytes**.
 *
 * The header **is** the format switch on this domain: a v1 envelope carries `format_version` and its
 * header therefore has six lines, a legacy envelope has five. The line is driven by the wire field
 * rather than by a constant, so the two shapes cannot be mixed - emitting a six-line header for an
 * envelope that was signed over five (or the reverse) simply fails the checksum, which is the
 * fail-closed half of the compat rule in artifactFormatOf.
 */
export function buildGuidanceHeader(envelope) {
  const e = envelope || {};
  const formatLine = e.format_version === undefined || e.format_version === null
    ? ''
    : `format_version: ${e.format_version}\n`;
  return (
    formatLine +
    `type: ${e.type}\n` +
    `guidance_version: ${e.guidance_version}\n` +
    `issued_at: ${e.issued_at}\n` +
    `expires_at: ${e.expires_at}\n` +
    `resource: ${e.resource}\n`
  );
}

/**
 * meta-guidance signature verification (the seven client-side verification steps numbered below,
 * plus two content-level rejections).
 *
 * Injected content goes straight into the model context and is the only new attack surface
 * introduced in 0.7.0: if any step fails, discard everything and fall back to the plugin's built-in
 * static skills/meta-guidance/SKILL.md.
 *
 * WARNING - note on domain separation: the signed object is a bare 64-hex sha256 string. If type and
 * the two fixed pseudo paths were not folded into the signed bytes, the {checksum, signature} pair of
 * any legitimately issued SkillPackage could be lifted as-is and passed off as meta-guidance. Here the
 * manifest string of "exactly header.txt + content.md" is folded into the checksum, which makes it
 * algorithmically impossible for a skill package (which must contain manifest.json + SKILL.md, so its
 * path set necessarily differs) to produce the same manifest string.
 *
 * @param {object} envelope the server response body
 * @param {string} pem the server public key (PEM)
 * @param {{now?: number, minVersion?: number, resource?: string}} [opts]
 * @returns {{ok: boolean, reason: string|null}}
 */
export function verifyGuidanceEnvelope(envelope, pem, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const expectedResource = typeof opts.resource === 'string' ? opts.resource : `${apiEndpoint()}/mcp`;
  const minVersion = Number.isFinite(opts.minVersion) ? opts.minVersion : 0;
  const reject = (reason) => ({ ok: false, reason });

  if (!envelope || typeof envelope !== 'object') return reject('malformed');
  for (const key of ['type', 'issued_at', 'expires_at', 'resource', 'content', 'checksum', 'signature', 'algorithm']) {
    if (typeof envelope[key] !== 'string' || envelope[key] === '') return reject(`malformed:${key}`);
  }
  if (typeof pem !== 'string' || !pem.includes('PUBLIC KEY')) return reject('no_public_key');

  // (1) Algorithm
  if (envelope.algorithm !== 'ed25519') return reject('algorithm');

  // (1b) Artifact format. A version this client does not implement is refused outright: verifying
  // unknown bytes with the rules we happen to have is how a format field gets defeated.
  const format = artifactFormatOf(envelope);
  if (!format.ok) return reject('unsupported_artifact_format');

  // (2) Rebuild the header and the two files from the response fields, recompute the checksum, and compare for equality
  const files = [
    { path: GUIDANCE_HEADER_PATH, content: Buffer.from(buildGuidanceHeader(envelope), 'utf8') },
    { path: GUIDANCE_CONTENT_PATH, content: Buffer.from(envelope.content, 'utf8') },
  ];
  let recomputed = null;
  try {
    recomputed = computeChecksum(files, format.formatVersion);
  } catch {
    return reject('checksum_mismatch'); // the two pseudo paths are fixed, so this is unreachable in practice
  }
  if (recomputed !== envelope.checksum) return reject('checksum_mismatch');

  // (3) Ed25519 verification (the signed object = the UTF-8 bytes of the checksum string, the same scheme as skill packages)
  let verified = false;
  try {
    verified = crypto.verify(
      null,
      Buffer.from(envelope.checksum, 'utf8'),
      crypto.createPublicKey(pem),
      Buffer.from(envelope.signature, 'base64'),
    );
  } catch {
    return reject('signature_error');
  }
  if (!verified) return reject('signature_invalid');

  // (4) Type (the field-side re-check of domain separation; the real separation already lives in the signed bytes)
  if (envelope.type !== GUIDANCE_TYPE) return reject('type');

  // (5) Deployment binding: resource must equal the MCP resource this client actually connects to,
  //     otherwise guidance issued in a test environment could be lifted into production as-is.
  if (envelope.resource !== expectedResource) return reject('resource');

  // (6) Freshness: expired is not accepted; issued_at further ahead than the clock skew tolerance is not accepted either
  const issuedAt = Date.parse(envelope.issued_at);
  const expiresAt = Date.parse(envelope.expires_at);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return reject('timestamp');
  if (expiresAt <= now) return reject('expired');
  if (issuedAt > now + GUIDANCE_CLOCK_SKEW_MS) return reject('issued_in_future');

  // (7) Rollback protection: a signature is valid forever, so signatures alone cannot stop a replay of
  //     old guidance that really was issued at some point and was later replaced over a security issue.
  //     A monotonic version number closes that gap (equal versions are allowed, so refetching stays idempotent).
  const version = envelope.guidance_version;
  if (!Number.isInteger(version) || version <= 0) return reject('guidance_version');
  if (version < minVersion) return reject('rollback');

  // Content-level rejection 1: length (server hard cap of 8000, re-checked independently by the client)
  if (envelope.content.length > MAX_GUIDANCE_CONTENT_CHARS) return reject('content_too_long');
  // Content-level rejection 2: sentinels - otherwise the content could close the injection fence itself and disguise later text as host framework wording
  if (envelope.content.includes(GUIDANCE_BEGIN) || envelope.content.includes(GUIDANCE_END)) {
    return reject('sentinel_in_content');
  }

  return { ok: true, reason: null };
}
