// Mechanism tests with disposable signing keys and loopback revocations, not model E2E.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareSkill, stageInput, handleRpc, requestLines, MAX_REQUEST_BYTES } from '../plugins/codex/kabo-alpha/scripts/runtime-server.js';
import * as common from '../plugins/codex/kabo-alpha/scripts/lib/common.js';

const plugin = fileURLToPath(new URL('../plugins/codex/kabo-alpha/', import.meta.url));
function runtimeRpc(data, endpoint, requests, host) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(`../plugins/${host}/kabo-alpha/scripts/runtime-server.js`, import.meta.url))], {
      env: { PATH: process.env.PATH, [host === 'codex' ? 'KABO_CODEX_DATA' : 'KABO_DATA_ROOT']: data, KABO_API_ENDPOINT: endpoint },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      try { assert.equal(code, 0, stderr); resolve(stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))); }
      catch (e) { reject(e); }
    });
    child.stdin.end(requests.map((args, n) => JSON.stringify({ jsonrpc: '2.0', id: n + 1, method: 'tools/call', params: { name: 'prepare_skill', arguments: args } })).join('\n') + '\n');
  });
}

for (const host of ['codex', 'claude']) test(`${host} layout native stdio package transport verifies real signatures, binds identity and preserves failed receipts`, async t => {
  const rpc = (data, endpoint, requests) => runtimeRpc(data, endpoint, requests, host);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'kabo-package-runtime-'));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  let revoked = [], syncs = 0;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/sync') { syncs++; res.end(JSON.stringify({ server_api_version: '1.0.0', catalog: [], revocations: revoked })); }
    else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const pair = crypto.generateKeyPairSync('ed25519');
  const kid = common.sha256hex(pair.publicKey.export({ type: 'spki', format: 'der' })).slice(0, 16);
  async function data(name) {
    const dir = path.join(scratch, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `public-keys.${common.sha256hex(endpoint).slice(0, 16)}.json`), JSON.stringify({ issued_at: null, keys: [{ kid, public_key_pem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] }));
    return dir;
  }
  function signed(id, version = '1.0.0') {
    const files = [
      { path: 'manifest.json', content: Buffer.from(JSON.stringify({ name: id, version, execution: 'subagent', required: { tools: [] }, min_plugin_version: '0.21.0' })) },
      { path: 'SKILL.md', content: Buffer.from('Synthetic local fixture.\n' + 'x'.repeat(1_500_000)) },
    ];
    const checksum = common.computeChecksum(files, 1);
    return { id, version, format_version: 1, key_id: kid, checksum,
      signature: crypto.sign(null, Buffer.from(checksum), pair.privateKey).toString('base64'),
      files: files.map(({ path, content }) => ({ path, content_base64: content.toString('base64') })) };
  }
  const id = 'runtime-fixture', version = '1.0.0', pkg = signed(id), dir = await data('valid');
  assert.ok(Buffer.byteLength(JSON.stringify(pkg)) > 1_950_751, 'exercises the actual failed bridge package size');
  const results = await rpc(dir, endpoint, [{ id, version }, { id, version, package: pkg }, { id, version }, { id, version, package: pkg }]);
  assert.equal(results.length, 4);
  assert.deepEqual(results.map(row => row.id), [1, 2, 3, 4]);
  assert.equal(results[0].result.structuredContent.status, 'download_required');
  for (const [n, source] of [[1, 'download'], [2, 'cache']]) {
    const value = results[n].result.structuredContent;
    assert.equal(value.verified, true);
    assert.equal(value.exit_code, 0);
    assert.equal(value.source, source);
    assert.equal(value.manifest.name, id);
    assert.match(value.diagnostics, /Verification passed:/);
    const receipt = JSON.parse(await fs.readFile(value.receipt, 'utf8'));
    assert.equal(receipt.verified, true);
    assert.equal((await fs.stat(value.receipt)).mode & 0o777, 0o600);
  }
  assert.equal(syncs, 1, 'retain original revocation TTL semantics');
  assert.equal(results[3].result.structuredContent.error, 'cache_exists_do_not_redownload');
  assert.equal(await fs.readFile(path.join(dir, 'skill-cache', id, version, 'SKILL.md'), 'utf8'), Buffer.from(pkg.files[1].content_base64, 'base64').toString());

  const tampered = structuredClone(pkg); tampered.files[1].content_base64 = Buffer.from('tampered').toString('base64');
  const bad = (await rpc(await data('tampered'), endpoint, [{ id, version, package: tampered }]))[0].result;
  assert.equal(bad.isError, true); assert.equal(bad.structuredContent.verified, false);
  assert.notEqual(bad.structuredContent.exit_code, 0);
  assert.match(bad.structuredContent.diagnostics, /checksum/i);
  assert.equal(JSON.parse(await fs.readFile(bad.structuredContent.receipt, 'utf8')).verified, false);
  assert.equal(bad.structuredContent.manifest, undefined);

  // Envelope version is unsigned. A valid old signature must not authenticate the requested new version.
  const relabelled = { ...pkg, version: '2.0.0' };
  const mismatchDir = await data('relabelled');
  const mismatch = await rpc(mismatchDir, endpoint, [{ id, version: '2.0.0', package: relabelled }, { id, version: '2.0.0' }]);
  for (const row of mismatch) {
    assert.equal(row.result.isError, true);
    assert.equal(row.result.structuredContent.error, 'signed_manifest_identity_mismatch');
    assert.equal(row.result.structuredContent.manifest, undefined);
  }
  revoked = [id];
  const revokeDir = await data('revoked');
  const revoke = await rpc(revokeDir, endpoint, [{ id, version, package: pkg }, { id, version }]);
  assert.equal(revoke[0].result.isError, true);
  assert.match(revoke[0].result.structuredContent.diagnostics, /revoked/i);
  assert.equal(revoke[1].result.structuredContent.error, 'skill_revoked');
  assert.ok(await fs.stat(path.join(revokeDir, 'skill-cache', `${id}.disabled`)));
});

test('invalid input, symlinks and concurrent preparation fail closed with corresponding request IDs', async t => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kabo-runtime-guards-'));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const root = path.join(dataRoot, 'skill-cache'), deps = { root, dataRoot };
  let calls = 0, release;
  const execute = async () => { calls++; await new Promise(resolve => { release = resolve; }); return { exit_code: 7, signal: null, diagnostics: 'synthetic terminal failure' }; };
  const args = { id: 'a-b', version: 'c', package: { id: 'a-b', version: 'c' } };
  const first = prepareSkill(args, { ...deps, execute });
  assert.equal(calls, 1);
  const busy = await prepareSkill(args, { ...deps, execute });
  assert.equal(busy.structuredContent.error, 'skill_preparation_busy');
  release(); const failed = await first;
  assert.equal(failed.isError, true); assert.equal(failed.structuredContent.exit_code, 7);
  assert.deepEqual(await fs.readdir(path.join(dataRoot, 'runtime-locks')), []);
  const other = await prepareSkill({ id: 'a', version: 'b-c' }, deps);
  assert.equal(other.structuredContent.status, 'download_required', 'hyphenated identities have independent lock keys');
  for (const invalid of [{}, { id: '../x', version: '1' }, { id: 'x', version: '1', command: 'anything' }])
    assert.equal((await prepareSkill(invalid, deps)).isError, true);
  await fs.symlink(root, path.join(root, 'symlink'));
  const rpcResult = await handleRpc({ id: 77, method: 'tools/call', params: { name: 'prepare_skill', arguments: { id: 'symlink', version: '1' } } }, deps);
  assert.equal(rpcResult.id, 77); assert.equal(rpcResult.result.isError, true);
  assert.equal(rpcResult.result.structuredContent.reason, 'symlinked_runtime_path');
  await fs.rm(path.join(dataRoot, 'runtime-locks'), { recursive: true });
  await fs.symlink(root, path.join(dataRoot, 'runtime-locks'));
  assert.equal((await handleRpc({ id: 78, method: 'tools/call', params: { name: 'prepare_skill', arguments: { id: 'x', version: '1' } } }, deps)).result.isError, true);
});

test('byte-bounded framing accepts split UTF-8, drains oversize and resumes at the next request', async () => {
  const text = JSON.stringify({ value: '测试' });
  const bytes = Buffer.from(text + '\n');
  async function* input() {
    for (let n = 0; n < bytes.length; n++) yield bytes.subarray(n, n + 1);
    for (let n = 0; n < 33; n++) yield Buffer.alloc(1024 * 1024, 120);
    yield Buffer.from('\n{"next":true}\n');
  }
  const lines = [];
  for await (const line of requestLines(Readable.from(input()))) lines.push(line);
  assert.deepEqual(lines, [text, null, '{"next":true}']);
  assert.equal(MAX_REQUEST_BYTES, 32 * 1024 * 1024);
});

test('data-only stage input binds native JSON to a running reservation without executing code', async t => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kabo-stage-input-'));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const root = path.join(dataRoot, 'skill-cache'), workRoot = path.join(dataRoot, 'work');
  const skill = path.join(root, 'fixture', '1'), run = path.join(workRoot, 'run-1');
  for (const dir of [skill, path.join(run, 'owner'), path.join(dataRoot, 'runtime-preparations')]) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const manifest = { name: 'fixture', version: '1', min_plugin_version: '0.21.28', execution_stages: { format_version: 1, stages: {
    prepare: { cmd: 'python3 {skill}/prepare.py {stage_input}', input: 'json', after: [], final: false },
    report: { cmd: 'python3 {skill}/report.py {stage_input}', input: 'json', after: ['prepare'], final: true, report_file: 'reply.md' },
  } } };
  const manifestBytes = JSON.stringify(manifest), hash = common.sha256hex(manifestBytes);
  await fs.writeFile(path.join(skill, 'manifest.json'), manifestBytes);
  await fs.writeFile(path.join(skill, '.meta.json'), JSON.stringify({ checksum: 'synthetic-binding-fixture' }));
  await fs.writeFile(path.join(run, 'run-manifest.json'), JSON.stringify({ skill_id: 'fixture', status: 'running' }));
  const preparation = '123-abcdef.json';
  const realSkill = await fs.realpath(skill);
  await fs.writeFile(path.join(dataRoot, 'runtime-preparations', preparation), JSON.stringify({ id: 'fixture', version: '1', verified: true, skill_directory: realSkill, checksum: 'synthetic-binding-fixture', manifest_sha256: hash }));
  const deps = { root, dataRoot, workRoot };
  await assert.rejects(stageInput({ run_id: 'run-1', stage: 'report', preparation, input: {} }, deps), /predecessors/);
  const value = { user_request: '保持原文', groups: [{ label: 'earlier', values: [1, 2] }] };
  const staged = await stageInput({ run_id: 'run-1', stage: 'prepare', preparation, input: value }, deps);
  assert.equal(staged.structuredContent.staged, true);
  const receipt = JSON.parse(await fs.readFile(staged.structuredContent.input_receipt, 'utf8'));
  const bytes = await fs.readFile(receipt.input_file);
  assert.deepEqual(JSON.parse(bytes), value);
  assert.equal(receipt.input_sha256, common.sha256hex(bytes));
  assert.equal(receipt.skill, realSkill); assert.equal(receipt.manifest, hash);
  assert.equal((await fs.stat(receipt.input_file)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(workRoot), ['run-1'], 'no business command or extra reservation');
  await assert.rejects(stageInput({ run_id: 'run-1', stage: 'prepare', preparation, input: value }, deps), { code: 'EEXIST' });
  assert.equal((await stageInput({ run_id: 'run-1', stage: 'prepare', preparation, input: { connector_id: 'x', status: 'completed' } }, deps)).isError, true);
  await fs.writeFile(path.join(run, '.pipeline-stages.json'), JSON.stringify({ skill: realSkill, manifest: hash, checksum: 'synthetic-binding-fixture', status: 'running', execution_stages: { prepare: { status: 'started' } } }));
  await assert.rejects(stageInput({ run_id: 'run-1', stage: 'report', preparation, input: {} }, deps), /unfinished/);
  await fs.writeFile(path.join(run, 'run-manifest.json'), JSON.stringify({ skill_id: 'fixture', status: 'failed' }));
  await assert.rejects(stageInput({ run_id: 'run-1', stage: 'report', preparation, input: {} }, deps), /run_closed/);
});
