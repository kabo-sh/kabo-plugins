// Kabo plugin shared utility library (used by both hook scripts and bin/ executables).
//
// WARNING - telemetry hard rule:
//   The telemetry this plugin collects stops at the **event level**, with a strict field allowlist
//   (see EVENT_FIELDS, 12 fields in total).
//   No code may read, serialize, or report the following content-level data:
//     - prompt (the user's prompt)
//     - tool_input (tool arguments)
//     - the contents of tool_response (only the boolean error flag may be read, to tell success from failure)
//     - the contents of the session transcript file that transcript_path points at
//   Being able to collect it does not mean it should be collected; the implementation side holds this line.
//
// Every function follows the "silent degradation" principle: no failure throws, and none affects the
// user's session.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const PLUGIN_VERSION = '0.17.0';
export const SUPPORTED_API_VERSION = '1.0.0';
export const DEFAULT_ENDPOINT = 'https://kabo.sh';
export const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // skill cache TTL: 14 days
// ---------- Path conventions ----------
/** Codex data root: every hook and every plain Bash call resolves to the same path reliably. */
export function dataRoot() {
  return process.env.KABO_CODEX_DATA || path.join(os.homedir(), '.kabo', 'codex');
}
/**
 * Platform API root (trailing slashes stripped). Since 0.9.0 the endpoint no longer comes from a
 * credentials file (there is none); only an environment variable override is honored.
 * hooks and bin/* must use the same source, otherwise the revocation list comes from A while the
 * signature verification public key comes from B.
 */
export function apiEndpoint() {
  const raw = process.env.KABO_API_ENDPOINT || DEFAULT_ENDPOINT;
  return String(raw).replace(/\/+$/, '');
}

/**
 * Where the plugin install root is recorded. The SKILL.md of creator-research skills refers to
 * relative paths like `../../config/`, which have to be resolved to the plugin's creator-research/.
 * The SessionStart hook computes the plugin root from its own file location and writes it here, for
 * the shell-only skill-runner to read.
 */
export function pluginRootMarkerPath() {
  return path.join(dataRoot(), 'plugin-root');
}

export function cacheRoot() {
  return path.join(dataRoot(), 'skill-cache');
}
/**
 * Where a run writes: `<data root>/work/<run-id>/`, one directory per run, created by the
 * skill-runner itself under `umask 077` (see skills/skill-runner/SKILL.md).
 *
 * Same root as the skill cache, a different branch, and deliberately not the same branch:
 * bin/skill-verify recomputes the checksum of every non-dot file under a cached skill
 * directory, so a single analyzer output left there makes that skill fail checksum_mismatch on
 * its next run.
 * Reclamation is not shared with the cache either, although both use CACHE_TTL_MS: a cache
 * entry's age comes from `downloaded_at` in its .meta.json, while a run directory has no such
 * file and can only be judged by its own mtime. One loop reading two different clocks would
 * silently treat "no .meta.json" as "expired", which is right for the cache and wrong here.
 */
export function workRoot() {
  return path.join(dataRoot(), 'work');
}

/**
 * The onboarding profile `$kabo-start` writes (schema kabo-onboarding-profile.v1): questionnaire
 * answers, the diagnosis, the baseline and the 90-day plan. No secrets, but it is the account's own
 * diagnosis on disk, so logout removes it along with the run work directories (decided 2026-08-23).
 */
export function onboardingProfilePath() {
  return path.join(dataRoot(), 'onboarding-profile.json');
}
/**
 * Legacy single-key cache location.
 * Since 0.10.0 the trust anchor is a keyset (see publicKeysPath); this file is kept only as a
 * **fallback read**: a pin left behind by an older plugin version should not go dead the moment the
 * user upgrades, otherwise they hit one inexplicable signature verification failure.
 */
export function publicKeyPath() {
  return path.join(dataRoot(), 'public-key.pem');
}

/**
 * Pin location of the server signing keyset, **bucketed per endpoint**.
 *
 * A single global path is not usable: the endpoint is decided by KABO_API_ENDPOINT, so a global cache
 * would let any server it has ever pointed at take the trust anchor seat - after that everything
 * kabo.sh serves would be verified with a poisoned key.
 * With bucketing each endpoint pins its own key and they never interfere.
 */
export function publicKeysPath(endpoint = apiEndpoint()) {
  const bucket = sha256hex(String(endpoint)).slice(0, 16);
  return path.join(dataRoot(), `public-keys.${bucket}.json`);
}

/** Every trust anchor file (used by logout cleanup: the new keyset pin plus the legacy single-key caches of every generation) */
export function publicKeyPaths() {
  try {
    return fs.readdirSync(dataRoot())
      .filter((f) => /^public-keys\.[0-9a-f]{16}\.json$/.test(f)
        || /^public-key\.[0-9a-f]{16}\.pem$/.test(f)
        || f === 'public-key.pem')
      .map((f) => path.join(dataRoot(), f));
  } catch {
    return [];
  }
}

/** Skill verification failure events awaiting relay (see the pending-reports section at the end of this file) */
export function pendingReportsPath() {
  return path.join(dataRoot(), 'pending-reports.jsonl');
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
 * directories (the sync response carrying these ids is unsigned, and the endpoint is whatever
 * KABO_API_ENDPOINT names, so a malicious endpoint can inject one).
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
/**
 * mkdir -p that keeps the directory private (0700), creation and healing in one place.
 * Everything under the data root is private state (trust anchors, cached skills, the relay buffer),
 * yet its directories are created lazily by whichever code path runs first - and onboarding
 * field-testing caught the consequence: delete ~/.kabo and the next SessionStart rebuilt it 0755
 * (the mkdirSync default under the usual umask). Node applies `mode` to every directory a recursive
 * call creates, so the whole fresh chain (including the shared parent ~/.kabo below the Codex root)
 * comes out 0700. The chmod is the healing half: `mode` never touches a directory that already
 * exists, so a root the 0755 bug left behind would otherwise stay world-readable forever; it is
 * best-effort because a pre-existing directory may be owned differently. mkdir failures propagate
 * so every caller keeps its own failure semantics.
 */
export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* a pre-existing directory may be owned differently */ }
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
/**
 * Three-segment numeric comparison: split on ".", each segment parseInt(x,10)||0, missing segments
 * count as 0, only the first three segments matter.
 * It must be verbatim identical in semantics to the server's own comparison and to the Claude
 * variant - if any of the three drifts, the "updatable" count and the min_plugin_version gate end up
 * disagreeing with each other.
 * A cross-repo contract test compares the three case by case.
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
 * (see the compat rule below):
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
 * which is exactly how the wrong sort survived in this file until 0.14.0 - a conformance test now
 * pins a non-BMP case for that reason.
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

/**
 * Normalize a URL that is about to be handed to a platform browser opener, or return null.
 *
 * On this variant the sign-in URL is built locally from `apiEndpoint()`, so it is not a server
 * response - but it is not a constant either: `KABO_API_ENDPOINT` is an ordinary environment
 * variable, and a project-level environment (a checked-in dotenv, a devcontainer, a direnv file) can
 * set it to anything at all, including a string that is not a URL. Whatever the source, the value
 * ends up in a subprocess argv, so it goes through the same gate the Claude variant applies to the
 * server-supplied device-flow URL:
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

// ---------- Server signing keyset ----------
//
// Why a keyset replaced the single key: single-key TOFU collapses "key rotation" and "being
// impersonated" into one signal - once a client has pinned a single key, the moment the platform
// rotates the signing key every old client fails signature verification at once, and the only remedy
// (delete the pin and redo TOFU) is exactly the action an attacker wants most.
// A keyset gives rotation **verifiable continuity**: the new keyset is co-signed by the old keys, so
// one verification with a key the client already has pinned is enough to move the anchor safely,
// without the user ever giving up the trust anchor.
//
// Server-side rotation flow (matching KABO_SIGNING_KEY / KABO_RETIRING_SIGNING_KEY):
//   1. Set KABO_SIGNING_KEY=the new key and KABO_RETIRING_SIGNING_KEY=the old key -> deploy;
//      both keys go into the keyset and both co-sign it, but only the new key signs skill packages and guidance;
//   2. At its next signature verification failure the client refreshes via continuity, replacing the
//      anchor wholesale with {old, new};
//   3. After the grace period, remove KABO_RETIRING_SIGNING_KEY and the old key leaves the keyset.

/** How many keys a keyset may hold at most. The cap is defensive: the response can be injected by a MITM, so do not let it blow up the local file */
export const KEYSET_MAX_KEYS = 8;

/**
 * Pseudo path for the keyset checksum.
 * It reuses computeChecksum for domain separation: a SkillPackage must contain
 * manifest.json + SKILL.md and meta-guidance contains exactly header.txt + content.md, so the three
 * path sets can never be the same, and the {checksum, signature} pair of any one of them cannot be
 * lifted to impersonate another.
 */
const KEYSET_CHECKSUM_PATH = 'kabo.keyset/keys.json';

/**
 * kid = sha256hex(the public key's SPKI DER).slice(0, 16).
 *
 * DER rather than PEM: PEM is just a base64 wrapper around DER, and line width, trailing newline, and
 * CRLF all change the PEM bytes without changing the key itself. The kid is the key's identity and
 * must be determined by the key's content alone, otherwise the same key yields two different kids on
 * the server and on the client and the key_id selection hint would never match.
 * @returns {string|null} null when it cannot be parsed as a public key
 */
export function keyIdFromPem(pem) {
  try {
    const der = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
    return sha256hex(der).slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * Canonical bytes of the keyset.
 *
 * Both sides must use **the same construction order**: sort keys by kid ascending, keep only the two
 * properties kid and public_key_pem on each entry with kid first, put issued_at before keys on the
 * outer object, then JSON.stringify directly.
 * The server response body must not be stringified as-is - property order, extra fields, and
 * whitespace would all make the two sides compute different bytes, while checksum comparison requires
 * them to be byte-identical.
 */
export function keysetCanonicalBytes(keyset) {
  const keys = [...((keyset && keyset.keys) || [])]
    .sort((a, b) => (a.kid < b.kid ? -1 : a.kid > b.kid ? 1 : 0))
    .map((k) => ({ kid: k.kid, public_key_pem: k.public_key_pem }));
  return Buffer.from(JSON.stringify({ issued_at: keyset ? keyset.issued_at : null, keys }), 'utf8');
}

/**
 * keyset_checksum: the canonical bytes hang under the pseudo path and go through the same checksum
 * function as skill packages. `formatVersion` comes from the /api/public-key response and nowhere
 * else - getting this one wrong is the worst of the three, because a keyset that fails to verify
 * means the anchor cannot rotate and every fresh install and every key rotation dies with
 * `public_key_unavailable`.
 */
export function computeKeysetChecksum(keyset, formatVersion = null) {
  return computeChecksum(
    [{ path: KEYSET_CHECKSUM_PATH, content: keysetCanonicalBytes(keyset) }],
    formatVersion,
  );
}

/** Verify "the signed object = the UTF-8 bytes of the checksum" with one PEM public key; any exception counts as failure */
function verifyChecksumSignature(checksum, signatureB64, pem) {
  try {
    return crypto.verify(
      null,
      Buffer.from(checksum, 'utf8'),
      crypto.createPublicKey(pem),
      Buffer.from(String(signatureB64), 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * Read the locally pinned keyset; fall back to the legacy single-key file when there is none.
 *
 * The fallback synthesizes issued_at: null - the old file has no timestamp, and null is treated as
 * "no lower bound" and let through by continuity. That is deliberate: users upgrading from a single
 * key have no comparable time baseline to begin with, and gating themselves on a made-up timestamp
 * would only deadlock their first rotation.
 * @returns {{issued_at: string|null, keys: {kid: string, public_key_pem: string}[]}|null}
 */
export function loadKeyset(endpoint = apiEndpoint()) {
  const pinned = readJsonSilent(publicKeysPath(endpoint));
  if (pinned && Array.isArray(pinned.keys) && pinned.keys.length > 0) {
    const keys = pinned.keys.filter(
      (k) => k && typeof k.kid === 'string' && typeof k.public_key_pem === 'string',
    );
    if (keys.length > 0) {
      return { issued_at: typeof pinned.issued_at === 'string' ? pinned.issued_at : null, keys };
    }
  }
  // Only the **per-endpoint bucketed** legacy PEM is honored. The unbucketed global public-key.pem is
  // a file any endpoint could TOFU-write in 0.9.0, and treating it as a fallback would let a key
  // pinned by endpoint A be trusted for endpoint B (including the default endpoint), reopening
  // exactly the cross-endpoint trust contamination bucketing exists to block; it is kept only for
  // logout cleanup.
  const bucket = sha256hex(String(endpoint)).slice(0, 16);
  for (const legacy of [path.join(dataRoot(), `public-key.${bucket}.pem`)]) {
    try {
      const pem = fs.readFileSync(legacy, 'utf8');
      const kid = pem.includes('PUBLIC KEY') ? keyIdFromPem(pem) : null;
      if (kid) return { issued_at: null, keys: [{ kid, public_key_pem: pem }] };
    } catch { /* no such file, continue */ }
  }
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
      const keys = bundled.keys
        .filter((k) => k && typeof k.kid === 'string' && typeof k.public_key_pem === 'string'
          && k.public_key_pem.includes('PUBLIC KEY') && keyIdFromPem(k.public_key_pem) === k.kid)
        .map((k) => ({ kid: k.kid, public_key_pem: k.public_key_pem }))
        .slice(0, KEYSET_MAX_KEYS);
      if (keys.length > 0) return { issued_at: null, keys };
    }
  }

  return null;
}

/**
 * Check whether one /api/public-key response may become the new trust anchor. A pure function, so
 * every negative case can be tested one by one.
 *
 * @param {object} resp the server response body
 * @param {object|null} pinned the locally pinned keyset (null = first time)
 * @returns {{issued_at: string|null, keys: object[]}|null} the keyset to persist when acceptable
 */
export function acceptKeysetResponse(resp, pinned) {
  if (!resp || typeof resp !== 'object') return null;
  // The response decides which canonical bytes the keyset_checksum was built from; an unknown value
  // is a refusal, not a guess (see artifactFormatOf). Refusing here costs a rotation, not a
  // compromise: the client keeps the anchor it already trusts.
  const format = artifactFormatOf(resp);
  if (!format.ok) return null;
  const pinnedKeys = pinned && Array.isArray(pinned.keys) ? pinned.keys : [];
  const ks = resp.keyset;

  // Legacy server: only public_key_pem, no keyset. Synthesize a one-key keyset.
  if (!ks || typeof ks !== 'object' || !Array.isArray(ks.keys)) {
    const pem = resp.public_key_pem;
    if (typeof pem !== 'string' || !pem.includes('PUBLIC KEY')) return null;
    const kid = keyIdFromPem(pem);
    if (!kid) return null;
    // With a pin already in place a key swap cannot be accepted: the old format offers no continuity
    // proof at all, and letting it through would mean "whoever answers first becomes the new anchor",
    // rolling the entire point of the keyset back to single-key TOFU.
    if (pinnedKeys.length > 0) {
      return pinnedKeys.length === 1 && pinnedKeys[0].kid === kid ? pinned : null;
    }
    return { issued_at: null, keys: [{ kid, public_key_pem: pem }] };
  }

  if (ks.keys.length < 1 || ks.keys.length > KEYSET_MAX_KEYS) return null;
  if (typeof ks.issued_at !== 'string' || !Number.isFinite(Date.parse(ks.issued_at))) return null;
  const seen = new Set();
  const keys = [];
  for (const k of ks.keys) {
    if (!k || typeof k.kid !== 'string' || typeof k.public_key_pem !== 'string') return null;
    if (!/^[0-9a-f]{16}$/.test(k.kid)) return null;
    // The kid is recomputed from the PEM and compared: otherwise a response could hand over key A
    // labeled with B's kid, letting the key_id hint steer the client onto the wrong key.
    if (keyIdFromPem(k.public_key_pem) !== k.kid) return null;
    if (seen.has(k.kid)) return null;
    seen.add(k.kid);
    keys.push({ kid: k.kid, public_key_pem: k.public_key_pem });
  }
  keys.sort((a, b) => (a.kid < b.kid ? -1 : a.kid > b.kid ? 1 : 0));
  const candidate = { issued_at: ks.issued_at, keys };
  let checksum;
  try {
    checksum = computeKeysetChecksum(candidate, format.formatVersion);
  } catch {
    return null; // an unusable format/path is a refusal, and a refusal on this path is silent
  }
  if (typeof resp.keyset_checksum !== 'string' || checksum !== resp.keyset_checksum) return null;
  const signatures = Array.isArray(resp.keyset_signatures) ? resp.keyset_signatures : [];

  if (pinnedKeys.length === 0) {
    // First-time TOFU: at minimum require that the issuer **holds** the active private key, so a
    // man-in-the-middle who can only forward someone else's public key cannot stuff a keyset it
    // cannot sign into the trust anchor.
    const activeKid = resp.active_kid;
    if (typeof activeKid !== 'string') return null;
    const active = keys.find((k) => k.kid === activeKid);
    if (!active) return null;
    const proof = signatures.find((s) => s && s.kid === activeKid);
    if (!proof || !verifyChecksumSignature(checksum, proof.signature, active.public_key_pem)) return null;
    return candidate;
  }

  // continuity: the new keyset must have been signed by **one of the keys already pinned on hand** -
  // that is the trust chain an anchor rotation needs.
  let proven = false;
  for (const s of signatures) {
    if (!s || typeof s.signature !== 'string') continue;
    if (pinnedKeys.some((pk) => verifyChecksumSignature(checksum, s.signature, pk.public_key_pem))) {
      proven = true;
      break;
    }
  }
  if (!proven) return null;

  // Replay protection for old keysets: the signature on a keyset that really was issued at some point
  // in history stays valid forever, so without a time check an attacker could replay an old response
  // containing an already-removed key (a leaked old key, say) and add it back into the anchor.
  const prev = pinned && typeof pinned.issued_at === 'string' ? Date.parse(pinned.issued_at) : NaN;
  if (Number.isFinite(prev) && Date.parse(candidate.issued_at) < prev) return null;
  return candidate;
}

/** At most one refresh per process: signature verification failure is a routine attack signal and must not become a request amplifier an attacker can drive */
let keysetRefreshed = false;

/** Fetch /api/public-key once and replace the local pin if it passes validation; returns null on failure */
export async function refreshKeyset(endpoint = apiEndpoint(), timeoutMs = 3000) {
  const resp = await fetchJsonSilent(`${endpoint}/api/public-key`, {}, timeoutMs); // public endpoint, no authentication needed
  if (!resp) return null;
  const accepted = acceptKeysetResponse(resp, loadKeyset(endpoint));
  if (!accepted) return null;
  writeJsonSilent(publicKeysPath(endpoint), accepted); // wholesale replacement, no merging
  return accepted;
}

/**
 * Verify the signature over a checksum with the pinned keyset (shared by skill packages and meta-guidance).
 *
 * key_id is only a **key selection hint** (it is not signed and can be tampered with), so it affects
 * only the order keys are tried in and whether to refresh; it never decides success on its own:
 *   - key_id matches a pinned key but verification fails -> the content was altered, not a key
 *     rotation. Refreshing here is a pointless network round trip and would turn "a locally tampered
 *     file" into an outbound call an attacker can drive, so fail immediately.
 *   - key_id is not among the pinned keys (or there is no pin at all) -> it may be a rotation, so one
 *     refresh and retry is allowed.
 *
 * @returns {{ok: boolean, reason: string|null}} reason is one of signature_invalid | public_key_unavailable
 */
export async function verifySignedChecksum(checksum, signature, keyId, opts = {}) {
  const endpoint = opts.endpoint || apiEndpoint();
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 3000;

  /** @returns {true|false|null} null = there is not a single key */
  const attempt = (keyset) => {
    const keys = keyset && Array.isArray(keyset.keys) ? keyset.keys : [];
    if (keys.length === 0) return null;
    const hit = keyId ? keys.filter((k) => k.kid === keyId) : [];
    const ordered = hit.length > 0 ? [...hit, ...keys.filter((k) => k.kid !== keyId)] : keys;
    return ordered.some((k) => verifyChecksumSignature(checksum, signature, k.public_key_pem));
  };

  const pinned = loadKeyset(endpoint);
  const first = attempt(pinned);
  if (first === true) return { ok: true, reason: null };

  const pinnedHasKeyId = !!(keyId && pinned && pinned.keys.some((k) => k.kid === keyId));
  const verdict = (result) => ({
    ok: false,
    reason: result === null ? 'public_key_unavailable' : 'signature_invalid',
  });
  if (first === false && pinnedHasKeyId) return { ok: false, reason: 'signature_invalid' };
  if (keysetRefreshed) return verdict(first);

  keysetRefreshed = true;
  const fresh = await refreshKeyset(endpoint, timeoutMs);
  if (!fresh) return verdict(first);
  const second = attempt(fresh);
  return second === true ? { ok: true, reason: null } : verdict(second);
}

/**
 * General multi-key signature verification (for non-checksum cases such as the guidance envelope):
 * call attempt(pem) once per pinned key, and only if all fail and key_id does not match a pinned key
 * does it refresh the keyset once and retry.
 * Same semantics as verifySignedChecksum, only with "verify the checksum signature" abstracted into a
 * callback.
 */
export async function ensureVerified(attempt, opts = {}) {
  const endpoint = opts.endpoint || apiEndpoint();
  const keyId = typeof opts.keyId === 'string' && opts.keyId !== '' ? opts.keyId : null;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 3000;

  const tryKeyset = (keyset) => {
    const keys = keyset && Array.isArray(keyset.keys) ? keyset.keys : [];
    const hit = keyId ? keys.filter((k) => k.kid === keyId) : [];
    const ordered = hit.length > 0 ? [...hit, ...keys.filter((k) => k.kid !== keyId)] : keys;
    for (const k of ordered) {
      try {
        if (attempt(k.public_key_pem) === true) return true;
      } catch { /* an error on one key just moves on to the next */ }
    }
    return false;
  };

  const pinned = loadKeyset(endpoint);
  if (tryKeyset(pinned)) return { ok: true, reason: null };

  const failure = () => ({ ok: false, reason: pinned ? 'signature_invalid' : 'public_key_unavailable' });
  if (pinned && keyId && pinned.keys.some((k) => k.kid === keyId)) {
    return { ok: false, reason: 'signature_invalid' };
  }
  if (keysetRefreshed) return failure();
  keysetRefreshed = true;

  const fresh = await refreshKeyset(endpoint, timeoutMs);
  if (!fresh) return failure();
  if (tryKeyset(fresh)) return { ok: true, reason: null };
  return { ok: false, reason: 'signature_invalid' };
}

// ---------- pending-reports (the relay queue of skill verification failures) ----------
//
// Why the queue is written to disk: bin/skill-verify is a shell subprocess, it never has an MCP
// connection, and it cannot report anything itself; and the KABO_VERIFY_FAIL line at the end of
// stderr is only relayed when **the main agent happens to read that output**, so a failure in the
// background, a truncated output, or an interrupted session loses the whole line. Writing it to disk
// lets the signal survive across sessions until someone can file it.
//
// Why the client never deletes already-relayed entries: event_id is deterministic (the same day, the
// same skill, and the same error cause always yield the same id), so the server's
// (user_id, event_id) uniqueness constraint makes relaying naturally idempotent and a repeated relay
// is swallowed as a duplicate.
// Conversely, "delete once reported" would require the client to confirm the report succeeded, and
// the client cannot see the result of an MCP call at all - one wrong guess and the event is lost
// forever. Better repeated than lost; old entries age out by time and by the entry-count cap.

/** An entry older than 7 days has no relay value left (the server has long since seen the problem through other signals) */
export const PENDING_REPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Keep at most 100 entries in the file, so a long offline stretch cannot inflate it into a log file */
export const PENDING_REPORT_KEEP = 100;
/** Prompt for at most 10 relays per session, to avoid crowding out context */
export const PENDING_REPORT_INJECT_MAX = 10;

/**
 * event_id = sha256hex([event, skill_id, skill_version, error_type, UTC date].join("\0")).slice(0,32)
 *
 * Deliberately deterministic and deliberately bucketed by day: one bad package that trips
 * verification repeatedly within a single day counts as one thing on the server, so a high retry
 * count cannot skew the statistics; across days it is counted again, which still shows that "the
 * problem is ongoing".
 */
export function pendingReportEventId(skillId, skillVersion, errorType, now = new Date()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const parts = ['skill_verify_fail', skillId || '-', skillVersion || '-', errorType || '-', day];
  return sha256hex(parts.join('\0')).slice(0, 32);
}

/**
 * Per-field character-set allowlist - this is a security boundary, not data cleaning.
 * skill_id/skill_version come from the **top-level** fields of the SkillPackage and are outside the
 * coverage of the signature; the contents of this file are read into the main agent's context and
 * forwarded, so tightening them to the character set a directory name / version number should have
 * keeps free text out of the buffer. Writing and reading share the same check, so a locally tampered
 * buffer file cannot use it as a route either.
 */
function sanitizePendingRow(row) {
  if (!row || row.event !== 'skill_verify_fail') return null;
  if (typeof row.event_id !== 'string' || !/^[0-9a-f]{32}$/.test(row.event_id)) return null;
  if (typeof row.ts !== 'string' || !Number.isFinite(Date.parse(row.ts))) return null;
  if (typeof row.error_type !== 'string' || !/^[a-z_]{1,64}$/.test(row.error_type)) return null;
  const out = { event: 'skill_verify_fail', event_id: row.event_id };
  if (typeof row.skill_id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(row.skill_id)) {
    out.skill_id = row.skill_id;
  }
  if (typeof row.skill_version === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(row.skill_version)) {
    out.skill_version = row.skill_version;
  }
  out.error_type = row.error_type;
  out.status = 'error';
  out.ts = row.ts;
  return out;
}

/**
 * Append one event awaiting relay (best-effort; any failure is silent).
 * Only telemetry allowlist fields are written - this file is read verbatim into the main agent's
 * context and forwarded, so mixing in any content-level data would bypass the collection boundary
 * stated at the top of this file.
 */
export function appendPendingReport(fields = {}, now = new Date()) {
  try {
    const skillId = fields.skill_id || null;
    const skillVersion = fields.skill_version || null;
    const errorType = fields.error_type || null;
    const row = sanitizePendingRow({
      event: 'skill_verify_fail',
      event_id: pendingReportEventId(skillId, skillVersion, errorType, now),
      skill_id: skillId,
      skill_version: skillVersion,
      error_type: errorType,
      status: 'error',
      ts: new Date(now).toISOString(),
    });
    if (!row) return false;
    ensurePrivateDir(path.dirname(pendingReportsPath()));
    fs.appendFileSync(pendingReportsPath(), `${JSON.stringify(row)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the relay queue, pruning it and rewriting the file along the way (drop expired entries, keep
 * only the newest PENDING_REPORT_KEEP).
 * Pruning on the read path is deliberate: the write path lives in skill-verify, a process that must
 * stay minimal and exit on failure and should not take on file maintenance; SessionStart runs once
 * per session and is the natural maintenance point.
 */
export function readAndPrunePendingReports(now = Date.now()) {
  const file = pendingReportsPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row = null;
    try {
      row = sanitizePendingRow(JSON.parse(line));
    } catch {
      continue; // drop half-written/corrupt lines outright, so one bad line cannot jam the whole queue
    }
    if (!row) continue;
    if (now - Date.parse(row.ts) > PENDING_REPORT_MAX_AGE_MS) continue;
    rows.push(row);
  }
  const kept = rows.slice(-PENDING_REPORT_KEEP);
  try {
    const rewritten = kept.map((r) => `${JSON.stringify(r)}\n`).join('');
    if (rewritten !== raw) {
      // Concurrency safety: another process may have appended new lines after we read the file, and
      // rewriting the whole file would erase them - while the buffer's invariant is "entries only
      // leave by TTL/cap".
      // Before rewriting, append the tail added since the first read verbatim, then land it
      // atomically via a temp file and rename.
      // There is still a microsecond window between "re-read" and "rename", which is accepted:
      // event_id is derived deterministically, so the same failure recurring on the same day
      // produces the same entry - losing a line delays a report at most.
      let tail = '';
      try {
        const latest = fs.readFileSync(file, 'utf8');
        if (latest.length > raw.length && latest.startsWith(raw)) {
          tail = latest.slice(raw.length);
        }
      } catch { /* if it cannot be read, treat it as having no additions */ }
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, rewritten + tail);
      fs.renameSync(tmp, file);
    }
  } catch { /* a failed prune does not affect the result of this read */ }
  return kept;
}


/** last-known-good cache of signature-verified meta-guidance (bucketed per endpoint, same rule as publicKeysPath) */
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
 * meta-guidance signature verification (the seven client-side verification steps below plus two
 * content-level rejections).
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
