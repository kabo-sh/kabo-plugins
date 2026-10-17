// The Codex PostToolUse hook installs a downloaded SkillPackage itself (unpack + signed verification),
// so package bytes never travel through terminal input. Isolated from host state and production.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = path.join(root, 'plugins', 'codex', 'kabo-alpha');
const hookFile = path.join(plugin, 'scripts/hooks/install-skill-package.js');

function run(file, args, env, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

async function fixture(t, { revoked = [] } = {}) {
  const common = await import(pathToFileURL(path.join(plugin, 'scripts/lib/common.js')));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'kabo hook install '));
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/sync') {
      res.end(JSON.stringify({ server_api_version: '1.0.0', catalog: [], revocations: revoked }));
    } else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const env = { PATH: process.env.PATH, KABO_CODEX_DATA: data, KABO_API_ENDPOINT: endpoint };
  const pair = crypto.generateKeyPairSync('ed25519');
  const kid = common.sha256hex(pair.publicKey.export({ type: 'spki', format: 'der' })).slice(0, 16);
  await fs.writeFile(path.join(data, `public-keys.${common.sha256hex(endpoint).slice(0, 16)}.json`),
    JSON.stringify({ issued_at: null, keys: [{ kid, public_key_pem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] }), { mode: 0o600 });
  const id = 'hook-install-fixture';
  const files = [
    { path: 'manifest.json', content: Buffer.from(JSON.stringify({ name: id, version: '1.0.0', execution: 'subagent', required: { tools: [] }, min_plugin_version: '0.21.0' })) },
    { path: 'SKILL.md', content: Buffer.from('Synthetic fixture.') },
    { path: 'references/large.jsonl', content: crypto.randomBytes(256 * 1024) },
  ];
  const checksum = common.computeChecksum(files, 1);
  const pkg = { id, version: '1.0.0', format_version: 1, checksum, key_id: kid,
    signature: crypto.sign(null, Buffer.from(checksum), pair.privateKey).toString('base64'),
    files: files.map(({ path: p, content }) => ({ path: p, content_base64: content.toString('base64') })) };
  const hook = (toolName, toolResponse) => run(hookFile, [], env, JSON.stringify({
    session_id: 'hook-install-session', hook_event_name: 'PostToolUse', tool_name: toolName, tool_use_id: 'call-1', tool_response: toolResponse,
  }));
  return { data, env, pkg, hook, skill: path.join(data, 'skill-cache', id, '1.0.0') };
}

const exists = p => fs.access(p).then(() => true, () => false);
const context = stdout => JSON.parse(stdout).hookSpecificOutput.additionalContext;

test('codex hook installs and verifies a downloaded package delivered in any host shape', async t => {
  const { data, env, pkg, hook, skill } = await fixture(t);
  const text = JSON.stringify(pkg);
  const shapes = [
    { structuredContent: pkg, content: [{ type: 'text', text }] },
    [{ type: 'text', text }],
    { content: [{ type: 'text', text: JSON.stringify({ content: [{ type: 'text', text }] }) }] },
    text,
  ];
  for (const shape of shapes) {
    await fs.rm(skill, { recursive: true, force: true });
    const result = await hook('mcp__kabo__registry_skill_download', shape);
    assert.equal(result.code, 0, result.stderr);
    const line = context(result.stdout);
    assert.match(line, /kabo: skill installed and verified by the plugin hook - hook-install-fixture@1\.0\.0/);
    assert.match(line, /Verification passed/);
    assert.match(line, /exit_code: 0/);
    assert.doesNotMatch(line, new RegExp(pkg.files[2].content_base64.slice(0, 40).replace(/[+/]/g, '\\$&')));
    assert.ok(await exists(path.join(skill, 'references/large.jsonl')));
  }
  // Nothing but the cache is left behind: no staged package copy, no temporary unpack root.
  assert.deepEqual(await fs.readdir(path.join(data, 'skill-staging')), []);
  const verify = await run(path.join(plugin, 'bin', 'skill-verify'), [skill], env);
  assert.equal(verify.code, 0, verify.stderr);
});

test('codex hook installs nothing when the signature does not verify', async t => {
  const { data, pkg, hook, skill } = await fixture(t);
  const tampered = { ...pkg, files: pkg.files.map((f, i) => (i === 1 ? { ...f, content_base64: Buffer.from('tampered').toString('base64') } : f)) };
  const result = await hook('mcp__kabo__registry_skill_download', { structuredContent: tampered });
  assert.equal(result.code, 0);
  assert.match(context(result.stdout), /FAILED for hook-install-fixture@1\.0\.0/);
  assert.equal(await exists(skill), false);
  assert.equal((await records(data)).find(x => x.event === 'verify_finished').reason, 'checksum_mismatch');
  assert.deepEqual(await fs.readdir(path.join(data, 'skill-staging')), []);
});

test('codex hook installs nothing for a revoked skill', async t => {
  const { data, pkg, hook, skill } = await fixture(t, { revoked: ['hook-install-fixture'] });
  const result = await hook('mcp__kabo__registry_skill_download', { structuredContent: pkg });
  assert.equal(result.code, 0);
  assert.match(context(result.stdout), /FAILED/);
  assert.equal(await exists(skill), false);
  assert.equal((await records(data)).find(x => x.event === 'verify_finished').reason, 'revoked');
});

test('codex hook ignores other tools and reports non-package results', async t => {
  const { pkg, hook } = await fixture(t);
  assert.equal((await hook('mcp__kabo__registry_skill_search', { structuredContent: pkg })).stdout, '');
  assert.match(context((await hook('mcp__kabo__registry_skill_download', { structuredContent: { error: 'not found' } })).stdout), /package_not_found/);
});

test('codex hooks.json routes registry_skill_download to the install hook only', async () => {
  const hooks = JSON.parse(await fs.readFile(path.join(plugin, 'hooks/hooks.json'), 'utf8'));
  const entries = hooks.hooks.PostToolUse;
  const install = entries.find(e => e.hooks.some(h => /install-skill-package\.js/.test(h.command)));
  assert.ok(install);
  const matcher = new RegExp(install.matcher);
  assert.ok(matcher.test('mcp__kabo__registry_skill_download'));
  assert.ok(!matcher.test('mcp__kabo__registry_skill_search'));
  assert.ok(!new RegExp(entries[0].matcher).test('mcp__kabo__registry_skill_download'));
  assert.equal(install.hooks[0].type, 'command');
});

const records = async data => (await fs.readFile(path.join(data, 'logs/skill-install.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);

test('hook logs parse failures without recording payloads or identifiers', async t => {
  const { data, env } = await fixture(t);
  for (const input of ['secret-token-invalid-json', JSON.stringify({ tool_name: 'registry_skill_download', session_id: 'private-session' })]) {
    const result = await run(hookFile, [], env, input);
    assert.equal(result.code, 0);
    assert.match(context(result.stdout), /installation was not completed/);
    assert.doesNotMatch(result.stderr, /secret-token|private-session/);
  }
  const log = await records(data);
  assert.equal(log.filter(x => x.event === 'started').length, 2);
  assert.deepEqual(log.filter(x => x.event === 'input_rejected').map(x => x.reason), ['invalid_json', 'missing_tool_response']);
  assert.ok(log.filter(x => x.event === 'finished').every(x => x.outcome === 'failed'));
  assert.equal((await fs.stat(path.join(data, 'logs/skill-install.jsonl'))).mode & 0o777, 0o600);
});

test('hook reports staging failure and retains stderr diagnostics when log writes fail', async t => {
  const { data, pkg, hook } = await fixture(t);
  await fs.writeFile(path.join(data, 'skill-staging'), 'blocked');
  await fs.writeFile(path.join(data, 'logs'), 'blocked');
  const result = await hook('registry_skill_download', pkg);
  assert.match(context(result.stdout), /failed/);
  assert.match(result.stderr, /log_write_failed/);
  assert.match(result.stderr, /stage_failed.*EEXIST/);
  assert.doesNotMatch(result.stderr, new RegExp(pkg.signature.replace(/[+/?]/g, '\\$&')));
});

test('hook records verified installation stages and bounds existing log size', async t => {
  const { data, pkg, hook } = await fixture(t);
  await fs.mkdir(path.join(data, 'logs'));
  await fs.writeFile(path.join(data, 'logs/skill-install.jsonl'), 'x'.repeat(1024 * 1024), { mode: 0o600 });
  const result = await hook('registry_skill_download', pkg);
  assert.match(context(result.stdout), /installed and verified/);
  const log = await records(data);
  assert.deepEqual(log.map(x => x.event), ['started', 'input_received', 'event_parsed', 'package_found', 'verify_started', 'verify_finished', 'installed', 'finished']);
  assert.equal(log.at(-1).outcome, 'success');
  assert.equal(new Set(log.map(x => x.invocation)).size, 1);
  assert.ok(await exists(path.join(data, 'logs/skill-install.jsonl.1')));
  assert.ok((await fs.stat(path.join(data, 'logs/skill-install.jsonl'))).size < 10000);
});

const unpackRecords = async data => (await fs.readFile(path.join(data, 'logs/skill-unpack.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);

test('direct unpack logs malformed input without leaking its body', async t => {
  const { data, env } = await fixture(t);
  const result = await run(path.join(plugin, 'bin/skill-unpack'), ['--verify', '-'], env, 'private-token-malformed-json');
  assert.equal(result.code, 1);
  const log = await unpackRecords(data);
  assert.equal(log[0].event, 'started');
  assert.equal(log.find(x => x.event === 'failed').reason, 'invalid_json');
  assert.equal(log.at(-1).outcome, 'failed');
  assert.doesNotMatch(JSON.stringify(log) + result.stderr, /private-token/);
});

test('direct unpack logs file verification success and unverified stdin distinctly', async t => {
  const { data, env, pkg } = await fixture(t);
  const file = path.join(data, 'package.json');
  await fs.writeFile(file, JSON.stringify(pkg));
  for (const [args, input, expected] of [
    [['--verify', file], '', 'verified'],
    [['-'], JSON.stringify(pkg), 'unpacked_not_verified'],
  ]) {
    const result = await run(path.join(plugin, 'bin/skill-unpack'), args, env, input);
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await unpackRecords(data)).at(-1).outcome, expected);
  }
  assert.equal((await fs.stat(path.join(data, 'logs/skill-unpack.jsonl'))).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(await unpackRecords(data)), /content_base64|signature|package.json/);
});

test('direct unpack logs missing input, write failure and verification refusal', async t => {
  const { data, env, pkg } = await fixture(t, { revoked: ['hook-install-fixture'] });
  const bin = path.join(plugin, 'bin/skill-unpack');
  const missing = await run(bin, ['--verify', path.join(data, 'absent')], env);
  assert.equal(missing.code, 1);
  assert.equal((await unpackRecords(data)).find(x => x.event === 'failed').reason, 'ENOENT');
  const blocked = path.join(data, 'blocked');
  await fs.writeFile(blocked, 'file');
  const write = await run(bin, ['--verify', '-', blocked], env, JSON.stringify(pkg));
  assert.equal(write.code, 1);
  assert.equal((await unpackRecords(data)).at(-1).stage, 'write_files');
  const revoked = await run(bin, ['--verify', '-'], env, JSON.stringify(pkg));
  assert.equal(revoked.code, 1);
  const log = await unpackRecords(data);
  assert.equal(log.find(x => x.event === 'verify_finished').reason, 'revoked');
  assert.equal(log.at(-1).outcome, 'failed');
});

test('direct unpack still reports failures if its log directory is not writable', async t => {
  const { data, env } = await fixture(t);
  await fs.writeFile(path.join(data, 'logs'), 'blocked');
  const result = await run(path.join(plugin, 'bin/skill-unpack'), ['--verify', '-'], env, '{}');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /log_write_failed/);
  assert.match(result.stderr, /"event":"finished"/);
});
