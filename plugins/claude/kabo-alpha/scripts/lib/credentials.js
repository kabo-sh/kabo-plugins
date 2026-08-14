// OAuth wire protocol for the terminal device login (RFC 8628), shared by bin/kabo-auth (login) and
// bin/kabo-headers (renewal).
//
// Every literal in the frozen-constants block below belongs to the agreed client/server contract and
// is asserted on both sides - changing one here alone is the one failure mode of this flow that fails
// **silently** (a scope that is one item short does not error, it just makes some tool 403 a week
// later).
//
// This module holds no auth-header literal on purpose: it obtains and renews tokens, while
// assembling the request header is bin/kabo-headers' job alone. It also never prints a token, never
// writes one to a log, and never passes one to a subprocess - it spawns nothing.

import {
  CREDENTIALS_VERSION,
  acquireCredentialLock,
  apiEndpoint,
  deleteCredentials,
  readCredentials,
  releaseCredentialLock,
  writeCredentials,
} from './common.js';

// ---------- Frozen constants ----------

/** Static public client seeded by the server migration; a headless client must not do a DCR round trip first */
export const OAUTH_CLIENT_ID = 'kabo-cli';

/**
 * The scope set, byte-identical to what the host OAuth path requests today.
 * `offline_access` is the highest-risk item: without it the server issues no renewal token at all and
 * nothing errors - the user is simply kicked out every 30 minutes for no visible reason.
 */
export const OAUTH_SCOPE = 'openid offline_access account:read registry telemetry data';

/** RFC 8628 grant type URN; an extension grant on the server's token endpoint */
export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** OAuth server metadata, from which both endpoints are discovered rather than hardcoded */
export const AS_METADATA_PATH = '/api/auth/.well-known/oauth-authorization-server';

/**
 * Renew when the access token has less than this left.
 * Not 0 and not 60s: an MCP request takes time of its own, and a token with three seconds left
 * expires during server-side verification - producing a 401 that looks exactly like "never
 * authorized". The cost is at most one extra renewal per 30 minutes.
 */
export const ACCESS_TOKEN_SKEW_MS = 120_000;

/** Renewal token lifetime when the server does not state one; mirrors the server's own refresh token TTL */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Per-request budgets. The renewal one is the biggest share of kabo-headers' 10s budget */
export const DISCOVERY_TIMEOUT_MS = 5000;
export const DEVICE_CODE_TIMEOUT_MS = 5000;
export const TOKEN_TIMEOUT_MS = 6000;

/** RFC 8628 §3.5: a `slow_down` adds five seconds to the polling interval, permanently */
export const SLOW_DOWN_STEP_MS = 5000;

/**
 * Jitter added to every poll.
 * The server throttles on `>= pollingInterval`, so polling exactly on the interval boundary makes an
 * occasional `slow_down` inevitable.
 */
export const POLL_JITTER_MS = 250;

// ---------- HTTP helpers ----------

/**
 * One form-urlencoded POST to the token endpoint.
 *
 * form-urlencoded rather than JSON is deliberate: this is OAuth 2.1's required encoding and it is the
 * path the host's authorization_code exchange already proves out today. (The device authorization
 * request in `requestDeviceCode` is JSON instead - that is better-auth's native shape for its own
 * endpoint. Two endpoints, two encodings, each the one that is already proven there.)
 *
 * @returns {Promise<{transport: 'ok'|'network', status?: number, body?: object|null}>}
 *   `transport: 'network'` covers unreachable, timeout and unparseable - all of which mean "the road
 *   is closed", which is a different outcome from any error the server names.
 */
async function postForm(url, params, timeoutMs) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body = null;
    try {
      body = JSON.parse(await res.text());
    } catch { /* a non-JSON body is judged by status alone below */ }
    return { transport: 'ok', status: res.status, body };
  } catch {
    return { transport: 'network' };
  }
}

async function postJson(url, payload, timeoutMs) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body = null;
    try {
      body = JSON.parse(await res.text());
    } catch { /* same */ }
    return { transport: 'ok', status: res.status, body };
  } catch {
    return { transport: 'network' };
  }
}

/** The `error` field of an OAuth error body, or null when the server did not name one */
function errorCode(response) {
  const code = response?.body?.error;
  return typeof code === 'string' && code !== '' ? code : null;
}

// ---------- Discovery ----------

/**
 * Read the authorization server metadata and pull out the two endpoints we need.
 *
 * Discovery is not optional politeness: it is what turns "this Kabo server predates the device flow"
 * into a sentence the user can act on, instead of a 404 from a hardcoded path.
 *
 * @returns {Promise<{ok: true, issuer: string, token_endpoint: string, device_authorization_endpoint: string}
 *   | {ok: false, reason: 'network'|'malformed'|'unsupported'}>}
 */
export async function discoverOAuthEndpoints(endpoint = apiEndpoint(), timeoutMs = DISCOVERY_TIMEOUT_MS) {
  let body = null;
  try {
    const res = await fetch(`${endpoint}${AS_METADATA_PATH}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      // A 4xx is the host answering "there is no such document here" - an older or simply different
      // deployment, which is a configuration fact, not a transport failure. Only 5xx and below-the-HTTP
      // failures are worth retrying, and the two lead the caller to different exit codes.
      return { ok: false, reason: res.status >= 400 && res.status < 500 ? 'unsupported' : 'network' };
    }
    body = JSON.parse(await res.text());
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (!body || typeof body !== 'object') return { ok: false, reason: 'malformed' };
  const tokenEndpoint = body.token_endpoint;
  const deviceEndpoint = body.device_authorization_endpoint;
  if (typeof tokenEndpoint !== 'string' || tokenEndpoint === '') return { ok: false, reason: 'malformed' };
  // The metadata parses but advertises no device endpoint: an older deployment. This is the case
  // worth naming precisely - the user is not misconfigured and retrying will not help.
  if (typeof deviceEndpoint !== 'string' || deviceEndpoint === '') return { ok: false, reason: 'unsupported' };
  return {
    ok: true,
    issuer: typeof body.issuer === 'string' ? body.issuer : `${endpoint}/api/auth`,
    token_endpoint: tokenEndpoint,
    device_authorization_endpoint: deviceEndpoint,
  };
}

// ---------- Device authorization request ----------

/**
 * Ask for a device code.
 *
 * The body carries exactly `client_id` and `scope`, and must never carry `user_id`: pre-binding a
 * device code to a named user turns the confirmation page into a targeted phishing device.
 *
 * @returns {Promise<{ok: true, device: object} | {ok: false, reason: 'network'|string}>}
 */
export async function requestDeviceCode(deviceEndpoint, timeoutMs = DEVICE_CODE_TIMEOUT_MS) {
  const res = await postJson(
    deviceEndpoint,
    { client_id: OAUTH_CLIENT_ID, scope: OAUTH_SCOPE },
    timeoutMs,
  );
  if (res.transport === 'network') return { ok: false, reason: 'network' };
  const device = res.body;
  if (res.status !== 200 || !device || typeof device.device_code !== 'string' || typeof device.user_code !== 'string') {
    return { ok: false, reason: errorCode(res) || `http_${res.status}` };
  }
  return { ok: true, device };
}

// ---------- Token endpoint ----------

/**
 * Normalize a token endpoint response into the three outcomes a caller can act on.
 * @returns {{outcome: 'tokens', tokens: object}
 *   | {outcome: 'error', code: string}
 *   | {outcome: 'network'}}
 */
function classifyTokenResponse(res) {
  if (res.transport === 'network') return { outcome: 'network' };
  // 5xx is the server saying "not now", which is the same recovery as an unreachable host: keep the
  // credential, do not send the user through a login they do not need.
  if (res.status >= 500) return { outcome: 'network' };
  if (res.status === 200 && res.body && typeof res.body.access_token === 'string') {
    return { outcome: 'tokens', tokens: res.body };
  }
  return { outcome: 'error', code: errorCode(res) || `http_${res.status}` };
}

/** Exchange an approved device code for tokens (one attempt; the polling loop lives in bin/kabo-auth) */
export async function redeemDeviceCode(tokenEndpoint, deviceCode, timeoutMs = TOKEN_TIMEOUT_MS) {
  return classifyTokenResponse(await postForm(tokenEndpoint, {
    grant_type: DEVICE_GRANT_TYPE,
    device_code: deviceCode,
    client_id: OAUTH_CLIENT_ID,
  }, timeoutMs));
}

/**
 * Renew with the refresh token.
 *
 * Rotation is strict and has no reuse window: the old value is dead the instant this succeeds, so the
 * result must be persisted before anything else uses it, and two of these must never run at once
 * (that is what the lock in `ensureFreshAccessToken` is for).
 */
export async function refreshTokens(tokenEndpoint, refreshToken, timeoutMs = TOKEN_TIMEOUT_MS) {
  return classifyTokenResponse(await postForm(tokenEndpoint, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  }, timeoutMs));
}

// ---------- Credential file assembly ----------

/**
 * Build the on-disk credential object from a token response.
 *
 * `id_token` is deliberately dropped: requesting `openid` yields one, the client has no use for it,
 * and persisting it would only add a second piece of identity-bearing material to the disk.
 * `previous` carries the fields a renewal response does not repeat (the endpoints, and the refresh
 * token itself when the server chose not to rotate it).
 */
export function credentialsFromTokens({ endpoint, issuer, tokenEndpoint, tokens, previous = null, now = Date.now() }) {
  const accessTtlMs = Number.isFinite(tokens.expires_in) ? tokens.expires_in * 1000 : 30 * 60 * 1000;
  const refreshTtlMs = Number.isFinite(tokens.refresh_expires_in)
    ? tokens.refresh_expires_in * 1000
    : REFRESH_TOKEN_TTL_MS;
  const refreshToken = typeof tokens.refresh_token === 'string' && tokens.refresh_token !== ''
    ? tokens.refresh_token
    : previous?.refresh_token;
  return {
    version: CREDENTIALS_VERSION,
    endpoint,
    issuer,
    token_endpoint: tokenEndpoint,
    client_id: OAUTH_CLIENT_ID,
    scope: typeof tokens.scope === 'string' && tokens.scope !== '' ? tokens.scope : OAUTH_SCOPE,
    refresh_token: refreshToken,
    refresh_expires_at: new Date(now + refreshTtlMs).toISOString(),
    access_token: tokens.access_token,
    access_expires_at: new Date(now + accessTtlMs).toISOString(),
    obtained_at: new Date(now).toISOString(),
  };
}

/** Milliseconds until an ISO timestamp; -Infinity for a missing or unparseable one (treated as expired) */
export function msUntil(iso, now = Date.now()) {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at - now : -Infinity;
}

/** Is the cached access token still usable without a renewal round trip? */
export function accessTokenUsable(credentials, now = Date.now()) {
  return !!credentials && msUntil(credentials.access_expires_at, now) > ACCESS_TOKEN_SKEW_MS;
}

// ---------- The hot path: hand back a usable access token ----------

/**
 * Resolve a usable access token, renewing only when necessary.
 *
 * Outcomes map one to one onto bin/kabo-headers' exit codes, and the mapping is the whole point:
 *   'ok'         -> 0, emit the header
 *   'needs_login'-> 1, this credential is gone or belongs elsewhere; the user must sign in again
 *   'unreachable'-> 2, the authorization server could not be reached; the credential is untouched
 * Conflating the last two is the expensive mistake: deleting the file on a network blip escalates one
 * bad minute into a forced re-login, while keeping a dead refresh token burns a failed round trip on
 * every single MCP request.
 *
 * @returns {Promise<{status: 'ok', access_token: string} | {status: 'needs_login', reason: string} | {status: 'unreachable', reason: string}>}
 */
export async function ensureFreshAccessToken(endpoint = apiEndpoint(), now = Date.now()) {
  const initial = readCredentials();
  if (!initial) return { status: 'needs_login', reason: 'no_credentials' };
  // Same protection endpoint bucketing would have given, applied earlier: never present a token
  // obtained from one deployment to another.
  if (initial.endpoint !== endpoint) return { status: 'needs_login', reason: 'endpoint_mismatch' };
  if (accessTokenUsable(initial, now)) return { status: 'ok', access_token: initial.access_token };

  const locked = await acquireCredentialLock();
  try {
    // Re-read under the lock (or after giving up on it): waiting is itself evidence that another
    // process was renewing, and it has very probably already succeeded.
    const current = readCredentials();
    if (!current) return { status: 'needs_login', reason: 'no_credentials' };
    if (current.endpoint !== endpoint) return { status: 'needs_login', reason: 'endpoint_mismatch' };
    if (accessTokenUsable(current, Date.now())) return { status: 'ok', access_token: current.access_token };
    // Could not get the lock and the file is still stale: back off rather than force the lock. Two
    // renewals at once produce a guaranteed invalid_grant, and that outcome deletes the credential.
    if (!locked) return { status: 'unreachable', reason: 'renewal_in_progress' };

    if (msUntil(current.refresh_expires_at, Date.now()) <= 0) {
      deleteCredentials();
      return { status: 'needs_login', reason: 'refresh_expired' };
    }

    const result = await refreshTokens(current.token_endpoint, current.refresh_token);
    if (result.outcome === 'network') return { status: 'unreachable', reason: 'authorization_server_unreachable' };
    if (result.outcome === 'error') {
      // Exactly one error code means "this key is dead": keeping it would cost a wasted round trip on
      // every later request. Everything else (client misconfiguration included) keeps the file.
      if (result.code === 'invalid_grant') {
        deleteCredentials();
        return { status: 'needs_login', reason: 'invalid_grant' };
      }
      return { status: 'needs_login', reason: result.code };
    }

    const next = credentialsFromTokens({
      endpoint,
      issuer: current.issuer,
      tokenEndpoint: current.token_endpoint,
      tokens: result.tokens,
      previous: current,
      now: Date.now(),
    });
    try {
      writeCredentials(next);
    } catch {
      // The rotated token could not be persisted. The in-memory one still works for this request, but
      // the one on disk is already dead server-side, so say nothing reassuring here - the next request
      // will report needs-auth honestly.
      return { status: 'ok', access_token: next.access_token };
    }
    return { status: 'ok', access_token: next.access_token };
  } finally {
    if (locked) releaseCredentialLock();
  }
}
