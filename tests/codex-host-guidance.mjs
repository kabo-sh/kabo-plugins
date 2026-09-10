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
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(path.join(directory, `public-keys.${common.sha256hex(endpoint).slice(0, 16)}.json`),
    JSON.stringify({ issued_at: null, keys: [{ kid, public_key_pem: pem }] }), { mode: 0o600 });
  return directory;
}
/** Exercise the real hook with only isolated storage and the loopback endpoint. */
function hook(directory, installRoot = pluginRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(installRoot, 'scripts/hooks/session-start.js')], {
      env: { PATH: process.env.PATH, KABO_CODEX_DATA: directory, KABO_API_ENDPOINT: endpoint },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(watchdog); reject(error); });
    child.once('close', code => {
      clearTimeout(watchdog);
      try { assert.equal(code, 0, stderr); resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
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
  const start = context.indexOf(common.GUIDANCE_BEGIN), end = context.indexOf(common.GUIDANCE_END);
  const extracted = start >= 0 && end > start ? context.slice(start + common.GUIDANCE_BEGIN.length + 1, end - 1) : null;
  assert.equal(extracted, expectedContent, `${name}: signature/fallback behavior changed`);
  outputs.push({
    case: name, signed_content_present: extracted !== null,
    codex_host_bootstrap_present: /Codex client deltas|skills\/meta-guidance\/SKILL\.md/.test(context),
    context_characters: context.length,
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
  mode = 'valid';
  current = { ...signed(content), content: `${content}TAMPERED` };
  record('tampered-guidance-without-cache', await hook(await dataDir('tampered')), null);
  current = signed('x'.repeat(common.MAX_ADDITIONAL_CONTEXT_CHARS + 100));
  record('oversize-guidance-rejected-by-verifier', await hook(await dataDir('oversize')), null);
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
  const longInstall = path.join(scratch, ...Array(6).fill('long-install-'.repeat(15)), 'kabo-alpha');
  await fs.mkdir(path.dirname(longInstall), { recursive: true });
  await fs.cp(pluginRoot, longInstall, { recursive: true });
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
