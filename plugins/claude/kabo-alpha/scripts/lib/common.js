// Kabo plugin shared utility library (used by both hook scripts and bin/ executables).
//
// Since 0.7.0 this plugin holds **no client credentials at all**:
//   - The user authorizes once per session: `/mcp` -> pick `kabo` (the host manages the token).
//   - Every action needing a token (tool calls, telemetry reporting) rides that authorized MCP connection.
//   - The client only touches three **public read-only** endpoints: GET /api/sync, GET /api/meta-guidance,
//     GET /api/public-key. They take no arguments, carry no identity, and upload no user data.
//   So this file no longer reads/writes local credentials, discovers OAuth endpoints, or renews tokens.
//
// WARNING - collection boundary (CONTRACT §2.4 / §4):
//   Tool-level telemetry is recorded by the server itself; skill-runner's skill_output is reported
//   directly by the mcp_tool hook in hooks.json (see CONTRACT §2.4). The client's only local buffer
//   is pending-reports.jsonl: it stores only the **telemetry allowlist fields** of skill-verify
//   failure events, and it is not a reporting channel - reporting still happens only when the main
//   agent rides the authorized MCP connection (see the pending-reports section at the end of this file).
//   The following must never be read, serialized, or reported:
//     - prompt (the user's prompt)
//     - tool_input (tool arguments)
//     - the contents of tool_response
//     - the contents of the transcript file that transcript_path points at
//     - the output of any subagent other than skill-runner
//   Being able to collect it does not mean it should be collected; the implementation side holds this line.
//
// Every function follows the "silent degradation" principle: no failure throws, and none affects the
// user's session (CONTRACT §2.4).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PLUGIN_VERSION = '0.11.2';
export const SUPPORTED_API_VERSION = '1.0.0';
export const DEFAULT_ENDPOINT = 'https://kabo.sh';
export const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // skill cache TTL: 14 days (CONTRACT §2.3)

// ---------- Paths / endpoint conventions (CONTRACT §2.3) ----------

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
 * Since 0.7.0 the endpoint no longer comes from a credentials file (there is none); only an
 * environment variable override is honored, defaulting to https://kabo.sh.
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

/** Cache location of the server signing public key (CONTRACT §2.7), TOFU: pinned on first fetch */
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

/** last-known-good cache of signature-verified meta-guidance (CONTRACT §1.7) */
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

/** Write a JSON file silently (creating directories); never throws on failure */
export function writeJsonSilent(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

// ---------- checksum (CONTRACT §3.3, verbatim identical to the server's sign.ts) ----------

export function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * SkillPackage checksum algorithm (must be verbatim identical to the server):
 * sort files by path lexicographically, concatenate `path + "\0" + sha256hex(content) + "\n"`
 * into a manifest string, and take the sha256 hex of its UTF-8 bytes.
 * @param {{path: string, content: Buffer}[]} files
 */
export function computeChecksum(files) {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let manifest = '';
  for (const f of sorted) {
    manifest += f.path + '\0' + sha256hex(f.content) + '\n';
  }
  return sha256hex(Buffer.from(manifest, 'utf8'));
}

// ---------- Version comparison (same semantics as compareSemver in apps/api/src/registry.ts) ----------

/**
 * Three-segment numeric comparison: split on ".", each segment parseInt(x,10)||0, missing
 * segments count as 0, only the first three segments matter.
 * Since 0.7.0 update detection moved to the client (the public GET /api/sync does not accept
 * installed_skills), so this implementation must be verbatim identical in semantics to the
 * server's, otherwise the "updatable" counts disagree between the two sides.
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

// ---------- Server public key (TOFU cache, CONTRACT §2.7) ----------

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
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, resp.public_key_pem);
  } catch { /* a cache write failure does not affect this verification */ }
  return resp.public_key_pem;
}

// ---------- Signing keyset: TOFU + continuity refresh (CONTRACT §2.7) ----------

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
 * and the server's sign.ts) construct the literal with the same fixed property order, and every JS
 * implementation emits insertion order, so the bytes are reproducible.
 * The property order is part of the signature - change it anywhere and every pinned client will
 * treat the keyset as tampered with.
 */
export function keysetCanonicalBytes(keyset) {
  const keys = sortKeysByKid(keyset.keys).map((k) => ({ kid: k.kid, public_key_pem: k.public_key_pem }));
  return Buffer.from(JSON.stringify({ issued_at: keyset.issued_at, keys }), 'utf8');
}

/** Keyset checksum: reuses the same checksum function from §3.3, with the pseudo path providing domain separation */
export function keysetChecksum(keyset) {
  return computeChecksum([{ path: KEYSET_PSEUDO_PATH, content: keysetCanonicalBytes(keyset) }]);
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
  const checksum = keysetChecksum(next);
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

// ---------- pending-reports relay buffer (CONTRACT §4) ----------
//
// The client has no reporting channel (no credentials), and skill-verify is a Bash subprocess that
// cannot even see MCP. A verification failure is exactly the signal the platform most needs to see,
// so on failure a line is left locally, SessionStart injects a prompt, and the main agent relays it
// once over the authorized MCP connection.
// Only telemetry allowlist fields are written: skill_id / skill_version / error_type / status / ts -
// no paths, no file contents, no user input of any kind.

/** Expiry threshold: a failure older than 7 days has no diagnostic value left, and keeping it only makes the injected section grow */
export const PENDING_REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Maximum entries kept in the file (so a broken loop cannot blow the file up) */
export const PENDING_REPORT_MAX = 100;
/** Maximum entries injected per session (injection costs model context) */
export const PENDING_REPORT_INJECT_MAX = 10;

/**
 * Deterministic event_id: the same (skill, version, error_type) on the same day yields one id.
 * The server's (user_id, event_id) uniqueness constraint therefore makes relaying naturally
 * idempotent - a repeated relay is swallowed as a duplicate.
 * Because of that the client **never automatically deletes** relayed entries: it cannot confirm the
 * relay succeeded, and a repeated relay is harmless while a lost signal is not. Entries only leave
 * by TTL or by the entry-count cap.
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
    fs.mkdirSync(path.dirname(pendingReportsPath()), { recursive: true });
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

  try {
    const rewritten = pruned.map((e) => JSON.stringify(e) + '\n').join('');
    if (rewritten !== text) {
      // Concurrency safety: when two sessions share one data root, another process may have appended
      // new lines after we read the file, and rewriting the whole file would erase them - while the
      // buffer's invariant is "entries only leave by TTL/cap".
      // Before rewriting, append the tail added since the first read verbatim, then land it atomically
      // via a temp file and rename.
      // There is still a microsecond window between "re-read" and "rename", which is accepted:
      // event_id is derived deterministically, so the same failure recurring on the same day produces
      // the same entry - losing a line delays a report at most, it does not lose uniqueness.
      let tail = '';
      try {
        const latest = fs.readFileSync(file, 'utf8');
        if (latest.length > text.length && latest.startsWith(text)) {
          tail = latest.slice(text.length);
        }
      } catch { /* if it cannot be read, treat it as having no additions */ }
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, rewritten + tail);
      fs.renameSync(tmp, file);
    }
  } catch { /* a failed rewrite does not affect the result of this read */ }
  return pruned;
}

// ---------- meta-guidance signature envelope (CONTRACT §1.7) ----------

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
 * Rebuild the signed header text (CONTRACT §1.7).
 *
 * Strictly five lines, fixed order, nothing added or removed: type / guidance_version / issued_at /
 * expires_at / resource, each line `key + ": " + value + "\n"`.
 * Deliberately not JSON: key order, whitespace, and number formatting cannot be guaranteed
 * byte-identical between two language implementations, while signature comparison requires both
 * sides to assemble **exactly the same bytes**.
 */
export function buildGuidanceHeader(envelope) {
  const e = envelope || {};
  return (
    `type: ${e.type}\n` +
    `guidance_version: ${e.guidance_version}\n` +
    `issued_at: ${e.issued_at}\n` +
    `expires_at: ${e.expires_at}\n` +
    `resource: ${e.resource}\n`
  );
}

/**
 * meta-guidance signature verification (the seven client-side verification steps of CONTRACT §1.7
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

  // (2) Rebuild the header and the two files from the response fields, recompute the checksum, and compare for equality
  const files = [
    { path: GUIDANCE_HEADER_PATH, content: Buffer.from(buildGuidanceHeader(envelope), 'utf8') },
    { path: GUIDANCE_CONTENT_PATH, content: Buffer.from(envelope.content, 'utf8') },
  ];
  if (computeChecksum(files) !== envelope.checksum) return reject('checksum_mismatch');

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
