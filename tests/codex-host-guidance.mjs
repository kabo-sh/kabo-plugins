// Diagnostic only: execute the actual Public hook against a loopback server and
// freshly generated test trust. Never read host credentials or contact production.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';

test('Codex bootstrap survives signed, cached, cold, invalid and capacity paths', async () => {
const pluginRoot = fileURLToPath(new URL('../plugins/codex/kabo-alpha/', import.meta.url));
assert.ok(pluginRoot && path.isAbsolute(pluginRoot), 'supply an absolute Public Codex plugin directory');
const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'));
const common = await import(pathToFileURL(path.join(pluginRoot, 'scripts/lib/common.js')));
const pair = crypto.generateKeyPairSync('ed25519');
const pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const kid = crypto.createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'retirement-host-guidance-'));
const network = [];
let mode = 'valid', current;
const server = http.createServer((request, response) => {
  network.push({ url: request.url, method: request.method, authorization: request.headers.authorization ?? null });
  response.setHeader('Content-Type', 'application/json');
  if (mode === 'offline') { response.writeHead(503); response.end('{}'); return; }
  if (request.url === '/api/sync') {
    response.end(JSON.stringify({ server_api_version: '1.0.0', catalog: [], revocations: [] }));
  } else if (request.url === `/api/meta-guidance?plugin=${manifest.version}`) response.end(JSON.stringify(current));
  else { response.writeHead(404); response.end('{}'); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const endpoint = `http://127.0.0.1:${server.address().port}`;
const signed = content => {
  const value = {
    format_version: 1, type: 'kabo.meta-guidance', guidance_version: 18,
    issued_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(), resource: `${endpoint}/mcp`, content,
  };
  const checksum = common.computeChecksum([
    { path: 'kabo.meta-guidance/header.txt', content: Buffer.from(common.buildGuidanceHeader(value)) },
    { path: 'kabo.meta-guidance/content.md', content: Buffer.from(content) },
  ], 1);
  return { ...value, checksum, signature: crypto.sign(null, Buffer.from(checksum), pair.privateKey).toString('base64'), algorithm: 'ed25519', key_id: kid };
};
/** Give each cold-path case its own disposable test trust, never host trust. */
async function dataDir(name) {
  const directory = path.join(scratch, name);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory, `public-keys.${common.sha256hex(endpoint).slice(0, 16)}.json`),
    JSON.stringify({ issued_at: null, keys: [{ kid, public_key_pem: pem }] }), { mode: 0o600 });
  return directory;
}
/** Exercise the real hook with only isolated storage and the loopback endpoint. */
const hookRoots = new WeakMap();
function hook(directory, installRoot = pluginRoot, { home, defaultRoot = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(installRoot, 'scripts/hooks/session-start.js')], {
      env: { PATH: process.env.PATH, ...(home ? { HOME: home } : {}),
        ...(!defaultRoot ? { KABO_CODEX_DATA: directory } : {}), KABO_API_ENDPOINT: endpoint },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(watchdog); reject(error); });
    child.once('close', code => {
      clearTimeout(watchdog);
      try {
        assert.equal(code, 0, stderr);
        const value = JSON.parse(stdout);
        hookRoots.set(value, directory);
        resolve(value);
      } catch (error) { reject(error); }
    });
    child.stdin.end('{}');
  });
}
const outputs = [];
/** Check signed bytes independently from the missing host bootstrap finding. */
function record(name, value, expectedContent, installRoot = pluginRoot) {
  const context = value.hookSpecificOutput?.additionalContext ?? '';
  assert.ok(context.startsWith(`Before using Kabo skills on Codex, read \`${installRoot.replace(/\/$/, '')}/skills/meta-guidance/SKILL.md\`.`));
  assert.ok(context.length <= common.MAX_ADDITIONAL_CONTEXT_CHARS);
  const resolved = context.match(/Active Codex data paths \(JSON\): (.+?)\. Never bypass/);
  assert.ok(resolved, `${name}: resolved paths missing`);
  assert.deepEqual(JSON.parse(resolved[1]), {
    data_root: hookRoots.get(value),
    execution_conventions: path.join(hookRoots.get(value), 'execution-conventions.md'),
  }, `${name}: bootstrap must expose the hook's actual paths`);
  assert.doesNotMatch(resolved[1], /[<>&`\u2028\u2029]/, `${name}: path JSON must remain display safe`);
  const start = context.indexOf(common.GUIDANCE_BEGIN), end = context.indexOf(common.GUIDANCE_END);
  const extracted = start >= 0 && end > start ? context.slice(start + common.GUIDANCE_BEGIN.length + 1, end - 1) : null;
  assert.equal(extracted, expectedContent, `${name}: signature/fallback behavior changed`);
  outputs.push({
    case: name, signed_content_present: extracted !== null,
    codex_host_bootstrap_present: /Codex client deltas|skills\/meta-guidance\/SKILL\.md/.test(context),
    context_characters: context.length,
    resolved_paths_roundtrip: true,
    system_message: value.systemMessage,
  });
}
try {
  const content = '# Synthetic cross-host routing\nCache: $KABO_DATA_ROOT/skill-cache. Tools: skill-verify on PATH.\n';
  current = signed(content);
  const warm = await dataDir('warm');
  record('fresh-verified-guidance', await hook(warm), content);
  mode = 'offline';
  record('verified-cache-fallback', await hook(warm), content);
  record('offline-no-guidance-cache', await hook(await dataDir('cold')), null);
  const isolatedHome = path.join(scratch, 'isolated-home');
  const defaultDirectory = await dataDir('isolated-home/.kabo/codex');
  record('default-root-isolated-home', await hook(defaultDirectory, pluginRoot,
    { home: isolatedHome, defaultRoot: true }), null);
  mode = 'valid';
  current = { ...signed(content), content: `${content}TAMPERED` };
  record('tampered-guidance-without-cache', await hook(await dataDir('tampered')), null);
  current = signed('x'.repeat(common.MAX_ADDITIONAL_CONTEXT_CHARS + 100));
  record('oversize-guidance-rejected-by-verifier', await hook(await dataDir('oversize')), null);
  const special = await dataDir('special 空格 "quote" \\ newline\n`<>&\u2028\u2029');
  current = signed(content);
  record('custom-root-special-characters', await hook(special), content);
  const boundary = await dataDir(path.join('budget-'.repeat(32), 'boundary-'.repeat(15)));
  const probe = await hook(boundary);
  record('context-budget-probe', probe, content);
  const exactContent = 'b'.repeat(content.length + common.MAX_ADDITIONAL_CONTEXT_CHARS
    - probe.hookSpecificOutput.additionalContext.length);
  assert.ok(exactContent.length > 0 && exactContent.length <= 8000);
  current = signed(exactContent);
  const exact = await hook(boundary);
  record('exact-context-budget-keeps-complete-signed-body', exact, exactContent);
  assert.equal(exact.hookSpecificOutput.additionalContext.length, common.MAX_ADDITIONAL_CONTEXT_CHARS);
  current = signed(`${exactContent}x`);
  const overflow = await hook(boundary);
  record('one-character-context-overflow-keeps-paths-drops-whole-body', overflow, null);
  assert.match(overflow.systemMessage, /dynamic guidance too long/);
  assert.doesNotMatch(overflow.hookSpecificOutput.additionalContext, /b{20}/);
  const crowded = await dataDir('crowded');
  current = signed('x'.repeat(8000));
  const entries = Array.from({ length: 10 }, (_, index) => ({ event: 'skill_verify_fail',
    event_id: index.toString(16).padStart(32, '0'), skill_id: 'x'.repeat(64), skill_version: '1'.repeat(32),
    error_type: 'x'.repeat(64), status: 'error', ts: new Date().toISOString() }));
  await fs.writeFile(path.join(crowded, 'pending-reports.jsonl'), entries.map(row => JSON.stringify(row)).join('\n') + '\n');
  const crowdedOutput = await hook(crowded);
  record('maximum-valid-guidance-ignores-legacy-relay-buffer', crowdedOutput, current.content);
  assert.doesNotMatch(crowdedOutput.systemMessage, /awaiting relay|injected this time/);
  assert.doesNotMatch(crowdedOutput.hookSpecificOutput.additionalContext, /Kabo events awaiting relay/);
  // Stay below macOS PATH_MAX while still overflowing the injected host context.
  let longInstall = path.join(scratch, ...Array(4).fill('long-install-'.repeat(15)), 'kabo-alpha');
  await fs.mkdir(path.dirname(longInstall), { recursive: true });
  await fs.cp(pluginRoot, longInstall, { recursive: true });
  longInstall = await fs.realpath(longInstall);
  const capped = await hook(await dataDir('long-install'), longInstall);
  record('host-context-cap-drops-whole-guidance-keeps-bootstrap', capped, null, longInstall);
  assert.match(capped.systemMessage, /dynamic guidance too long/);
  assert.ok(network.length > 0 && network.every(row => row.method === 'GET' && row.authorization === null));
  console.log(JSON.stringify({
    kind: 'isolated-hook-diagnostic-not-model-e2e', plugin_version: manifest.version,
    loopback_only: true, no_authorization_headers: true, cases: outputs,
  }, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(scratch, { recursive: true, force: true });
}

});
