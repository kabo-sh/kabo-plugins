import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const plugin = host => path.join(root, 'plugins', host, 'kabo-alpha');
const accessToken = 'synthetic-access-for-loopback-tests';

function run(host, entry, args, env, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(plugin(host), entry), ...args], {
      env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

function event(index, extra = {}) {
  return { event: 'skill_verify_fail', event_id: index.toString(16).padStart(32, '0'),
    skill_id: 'synthetic-skill', skill_version: '1.0.0', error_type: 'signature_invalid',
    status: 'error', ts: new Date().toISOString(), ...extra };
}

async function fixture(t, host = 'claude') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kabo-logout-relay-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const data = path.join(directory, host);
  const peer = path.join(directory, 'other-host');
  await fs.mkdir(data, { mode: 0o700 });
  await fs.mkdir(peer, { mode: 0o700 });
  const common = await import(pathToFileURL(path.join(plugin(host), 'scripts/lib/common.js')));
  const queue = path.join(data, 'pending-reports.jsonl');
  const requests = [];
  let mode = 'accepted', appendOnAck = false, envelope;
  const server = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, url: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET') {
        assert.equal(req.headers.authorization, undefined);
        if (req.url === '/api/sync') res.end(JSON.stringify({ server_api_version: '1.0.0', catalog: [], revocations: [] }));
        else if (req.url === `/api/meta-guidance?plugin=${common.PLUGIN_VERSION}`) res.end(JSON.stringify(envelope));
        else { res.writeHead(404); res.end('{}'); }
        return;
      }
      assert.equal(req.url, '/mcp-for-claude');
      assert.equal(req.headers.authorization, `Bearer ${accessToken}`);
      // The independent credential probe intentionally sends an invalid empty RPC request.
      if (Object.keys(body).length === 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }));
        return;
      }
      if (body.method === 'initialize') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } }));
        return;
      }
      assert.equal(body.method, 'tools/call');
      assert.equal(body.params.name, 'telemetry_report_usage');
      if (mode === 'unauthorized') { res.writeHead(401); res.end('{}'); return; }
      if (mode === 'invalid') { res.end('invalid JSON'); return; }
      if (mode === 'rpc-error') { res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32603, message: 'fixture' } })); return; }
      const result = mode === 'tool-error' ? { isError: true, content: [] }
        : { content: [{ type: 'text', text: JSON.stringify({ accepted: mode === 'duplicates' ? 0 : 1, duplicates: mode === 'duplicates' ? 1 : 0 }) }] };
      if (appendOnAck) {
        await fs.appendFile(queue, JSON.stringify(event(2)) + '\n');
        appendOnAck = false;
      }
      const reply = JSON.stringify({ jsonrpc: '2.0', id: mode === 'wrong-id' ? 999 : body.id, result });
      if (mode === 'duplicates') {
        res.setHeader('Content-Type', 'text/event-stream');
        res.end(`event: message\ndata: ${reply}\n\n`);
      } else res.end(reply);
    } catch (error) {
      res.writeHead(500); res.end('{}');
      requests.push({ failure: String(error) });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const env = { PATH: process.env.PATH, KABO_API_ENDPOINT: endpoint,
    KABO_DATA_ROOT: host === 'claude' ? data : peer, KABO_CODEX_DATA: host === 'codex' ? data : peer };
  const credential = { version: 1, endpoint, access_token: accessToken, refresh_token: 'synthetic-refresh',
    access_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString() };
  if (host === 'claude') await fs.writeFile(path.join(data, 'credentials.json'), JSON.stringify(credential), { mode: 0o600 });
  const pair = crypto.generateKeyPairSync('ed25519');
  const kid = common.sha256hex(pair.publicKey.export({ type: 'spki', format: 'der' })).slice(0, 16);
  await fs.writeFile(path.join(data, `public-keys.${common.sha256hex(endpoint).slice(0, 16)}.json`),
    JSON.stringify({ issued_at: null, keys: [{ kid, public_key_pem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] }), { mode: 0o600 });
  const snapshot = await fs.readFile(path.join(plugin(host), 'skills/meta-guidance/SKILL.md'), 'utf8');
  const body = snapshot.slice(snapshot.indexOf('# Kabo skill routing (meta-guidance)'));
  const fields = { format_version: 1, type: 'kabo.meta-guidance', guidance_version: 19, resource: `${endpoint}/mcp`,
    issued_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString() };
  const checksum = common.computeChecksum([
    { path: 'kabo.meta-guidance/header.txt', content: Buffer.from(common.buildGuidanceHeader(fields)) },
    { path: 'kabo.meta-guidance/content.md', content: Buffer.from(body) },
  ], 1);
  envelope = { ...fields, content: body, checksum, algorithm: 'ed25519', key_id: kid,
    signature: crypto.sign(null, Buffer.from(checksum), pair.privateKey).toString('base64') };
  return { data, peer, env, requests, queue, credential, common, body,
    setMode(value) { mode = value; }, appendDuringAck() { appendOnAck = true; },
    writeQueue: rows => fs.writeFile(queue, rows.map(row => JSON.stringify(row) + '\n').join(''), { mode: 0o600 }),
    readQueue: async () => (await fs.readFile(queue, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),
    run: (entry, args = [], input) => run(host, entry, args, env, input),
    assertRequests() { assert.ok(requests.every(request => !request.failure), JSON.stringify(requests.filter(request => request.failure))); },
  };
}

test('Claude relay prunes acknowledged batches, retains concurrent events and preserves header mode', async t => {
  const f = await fixture(t);
  await f.writeQueue([event(1, { prompt: 'must-not-send-content' })]);
  f.appendDuringAck();
  const relayed = await f.run('bin/kabo-headers', ['--relay']);
  assert.equal(relayed.code, 0, relayed.stderr);
  assert.equal(relayed.stdout, '');
  assert.doesNotMatch(relayed.stderr, /synthetic-skill|synthetic-access|must-not-send-content/);
  assert.deepEqual((await f.readQueue()).map(row => row.event_id), [event(2).event_id]);
  const call = f.requests.find(request => request.body?.method === 'tools/call');
  assert.equal(call.body.params.arguments.events.length, 1);
  assert.equal(call.body.params.arguments.events[0].prompt, undefined);
  f.setMode('duplicates');
  assert.equal((await f.run('bin/kabo-headers', ['--relay'])).code, 0);
  assert.deepEqual(await f.readQueue(), []);
  const count = f.requests.length;
  assert.deepEqual(await f.run('bin/kabo-headers', ['--relay']), { code: 0, stdout: '', stderr: '' });
  const ordinary = await f.run('bin/kabo-headers');
  assert.equal(ordinary.code, 0);
  assert.equal(ordinary.stdout, JSON.stringify({ Authorization: `Bearer ${accessToken}` }) + '\n');
  assert.equal(f.requests.length, count, 'An empty queue and a fresh header need no network');
  f.assertRequests();
});

test('Claude relay retains failures and never renews an expired access token', async t => {
  const f = await fixture(t);
  for (const mode of ['tool-error', 'rpc-error', 'unauthorized', 'wrong-id', 'invalid']) {
    await f.writeQueue([event(1)]);
    f.setMode(mode);
    const result = await f.run('bin/kabo-headers', ['--relay']);
    assert.notEqual(result.code, 0, mode);
    assert.equal(result.stdout, '', mode);
    assert.doesNotMatch(result.stderr, /synthetic-access|synthetic-refresh/);
    assert.deepEqual((await f.readQueue()).map(row => row.event_id), [event(1).event_id], mode);
  }
  const expired = { ...f.credential, access_expires_at: new Date(Date.now() - 60_000).toISOString() };
  const credentialBytes = JSON.stringify(expired);
  await fs.writeFile(path.join(f.data, 'credentials.json'), credentialBytes);
  const count = f.requests.length;
  assert.equal((await f.run('bin/kabo-headers', ['--relay'])).code, 3);
  assert.equal(f.requests.length, count);
  assert.equal(await fs.readFile(path.join(f.data, 'credentials.json'), 'utf8'), credentialBytes);
  f.assertRequests();
});

test('Claude SessionStart relays once while retaining complete v19 guidance and fast-path files', async t => {
  const f = await fixture(t);
  await f.writeQueue([event(1)]);
  const result = await f.run('scripts/hooks/session-start.js', [], '{}');
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const context = output.hookSpecificOutput.additionalContext;
  assert.ok(context.includes(f.body));
  assert.ok(context.length <= f.common.MAX_ADDITIONAL_CONTEXT_CHARS);
  assert.doesNotMatch(context, /Kabo events awaiting relay|synthetic-skill|synthetic-access/);
  assert.match(output.systemMessage, /relayed 1 buffered verification event/);
  assert.deepEqual(await f.readQueue(), []);
  assert.equal(f.requests.filter(request => request.body?.method === 'tools/call').length, 1);
  const conventions = await fs.readFile(path.join(f.data, 'execution-conventions.md'), 'utf8');
  assert.equal(conventions.trim(), f.common.extractGuidanceSection(f.body, 'C'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.data, 'revocation-sync.json'), 'utf8')).revocations, []);
  const again = JSON.parse((await f.run('scripts/hooks/session-start.js', [], '{}')).stdout);
  assert.doesNotMatch(again.systemMessage, /relayed|awaiting relay/);
  assert.equal(f.requests.filter(request => request.body?.method === 'tools/call').length, 1);
  f.assertRequests();
});

test('Codex verification failures stay local and SessionStart ignores legacy relay records', async t => {
  const f = await fixture(t, 'codex');
  const skill = path.join(f.data, 'skill-cache', 'broken', '1.0.0');
  await fs.mkdir(skill, { recursive: true });
  const failed = await f.run('bin/skill-verify', ['--local-only', skill]);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /KABO_VERIFY_FAIL/);
  await assert.rejects(fs.stat(f.queue), { code: 'ENOENT' });
  await f.writeQueue([event(1)]);
  const before = await fs.readFile(f.queue, 'utf8');
  const output = JSON.parse((await f.run('scripts/hooks/session-start.js', [], '{}')).stdout);
  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, /^Before using Kabo skills on Codex/);
  assert.ok(context.includes(f.body));
  assert.doesNotMatch(context, /Kabo events awaiting relay|synthetic-skill/);
  assert.doesNotMatch(output.systemMessage, /awaiting relay|injected this time/);
  assert.equal(await fs.readFile(f.queue, 'utf8'), before);
  assert.ok(f.requests.every(request => request.method === 'GET'));
  f.assertRequests();
});

for (const host of ['claude', 'codex']) {
  test(`${host}: local logout clears its data without contacting the platform or touching the other host`, async t => {
    const f = await fixture(t, host);
    await fs.mkdir(path.join(f.data, 'work', 'run', 'report'), { recursive: true });
    await fs.writeFile(path.join(f.data, 'work', 'run', 'report', 'REPORT.md'), 'synthetic output');
    await f.writeQueue([event(1)]);
    await fs.writeFile(path.join(f.peer, 'credentials.json'), 'other-host-sentinel');
    const result = await f.run('bin/kabo-auth', ['logout']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(f.requests.length, 0);
    await assert.rejects(fs.stat(path.join(f.data, 'work')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(f.queue), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(f.data, 'credentials.json')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(f.peer, 'credentials.json'), 'utf8'), 'other-host-sentinel');
  });
}
