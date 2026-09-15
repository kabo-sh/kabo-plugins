// Envelope-staging edge cases the integration run in fast-path.mjs does not reach: a stem another
// hook is still writing, artifact numbering across drains, a data root that needs shell quoting,
// and pairing drained files back to their requests.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

function run(command, args, env, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

const envelope = (requestId) => ({
  connector_id: 'fixture', operation: 'search', status: 'completed', limitations: [],
  retrieved_at: '2026-09-15T00:00:00Z', request_id: requestId, data: { requestId },
});

for (const host of ['claude', 'codex']) {
  const plugin = path.join(root, 'plugins', host, 'kabo-alpha');
  const hookFile = path.join(plugin, 'scripts/hooks/persist-envelope.js');
  const saveFile = path.join(plugin, 'bin/kabo-save-envelope');
  const setup = async (t, prefix = `kabo staging ${host} `) => {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rm(data, { recursive: true, force: true }));
    const env = { PATH: process.env.PATH, KABO_DATA_ROOT: data, KABO_CODEX_DATA: data };
    const session = 'staging-session';
    const staging = path.join(data, 'envelope-staging', session);
    const hook = (payload, toolId) => run(process.execPath, [hookFile], env, JSON.stringify({
      session_id: session, hook_event_name: 'PostToolUse', tool_use_id: toolId,
      tool_response: JSON.stringify(payload),
    }));
    const save = (...args) => run(process.execPath, [saveFile, ...args], env);
    return { data, env, staging, hook, save };
  };

  test(`${host}: a stem another hook is still writing is stepped over, not shared`, async t => {
    const { staging, hook } = await setup(t);
    await fs.mkdir(staging, { recursive: true, mode: 0o700 });
    // Another hook process holds 01 and has written its artifact body but not yet its sidecar.
    await fs.writeFile(path.join(staging, '01.lock'), '', { mode: 0o600 });
    await fs.writeFile(path.join(staging, '01.art'), Buffer.from('frame'), { mode: 0o600 });
    const result = await hook(envelope('req-1'), 'call-1');
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(fs.stat(path.join(staging, '01.json')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(staging, '01.meta')), { code: 'ENOENT' });
    const meta = JSON.parse(await fs.readFile(path.join(staging, '02.meta'), 'utf8'));
    assert.equal(meta.sha256, sha256(await fs.readFile(path.join(staging, '02.json'), 'utf8')));
    await assert.rejects(fs.stat(path.join(staging, '02.lock')), { code: 'ENOENT' });
  });

  test(`${host}: a keyframe drained into a snapshot that already has frame-0001 becomes frame-0002`, async t => {
    const { data, staging, save } = await setup(t);
    const snapshot = path.join(data, 'snapshot');
    await fs.mkdir(staging, { recursive: true, mode: 0o700 });
    await fs.mkdir(snapshot, { recursive: true, mode: 0o700 });
    const earlier = Buffer.from('earlier frame');
    await fs.writeFile(path.join(snapshot, 'frame-0001.png'), earlier, { mode: 0o600 });
    const frame = Buffer.from('89504e470d0a1a0a0001020300ff', 'hex');
    await fs.writeFile(path.join(staging, '01.art'), frame, { mode: 0o600 });
    await fs.writeFile(path.join(staging, '01.meta'), `${JSON.stringify({
      artifact: true, kind: 'keyframes', object_ref: 'frame-2', status: 'completed',
      bytes: frame.byteLength, sha256: sha256(frame), content_type: 'image/png', verbatim: true,
    })}\n`, { mode: 0o600 });
    const result = await save('--from', staging, '--into', snapshot);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await fs.readFile(path.join(snapshot, 'frame-0001.png')), earlier);
    assert.deepEqual(await fs.readFile(path.join(snapshot, 'frame-0002.png')), frame);
  });

  test(`${host}: the drain command in the kabo: line survives a data root that needs quoting`, async t => {
    const { data, env, hook } = await setup(t, `kabo quote ' ${host} `);
    const result = await hook(envelope('req-1'), 'call-1');
    assert.equal(result.code, 0, result.stderr);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    const command = context.split('\n').find(line => line.includes('--from')).trim();
    const snapshot = path.join(data, 'run dir', 'snapshot');
    const drain = await run('/bin/sh', ['-c', command.replace('<run dir>/snapshot', shellQuote(snapshot))], env);
    assert.equal(drain.code, 0, drain.stderr);
    assert.match(drain.stdout, /envelope-01\.json fixture\/search/);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(snapshot, 'envelope-01.json'), 'utf8')), envelope('req-1'));
  });

  test(`${host}: the staged listing names each file's request so completion order can be undone`, async t => {
    const { staging, hook, save } = await setup(t);
    // The second request finishes first: staging numbers follow completion, not request order.
    for (const [id, call] of [['req-b', 'call-2'], ['req-a', 'call-1']]) {
      const result = await hook(envelope(id), call);
      assert.equal(result.code, 0, result.stderr);
    }
    const listed = await save('--list', '--from', staging);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /^01 fixture\/search .* request_id=req-b$/m);
    assert.match(listed.stdout, /^02 fixture\/search .* request_id=req-a$/m);
  });
}
