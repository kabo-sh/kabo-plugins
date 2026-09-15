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

  test(`${host}: two subagents under one root session each drain only their own envelopes`, async t => {
    const { data, env, staging } = await setup(t);
    // Codex hands a spawned subagent's hook the *root* session id plus the subagent's own agent_id.
    const call = (agentId, requestId) => run(process.execPath, [hookFile], env, JSON.stringify({
      session_id: 'staging-session', agent_id: agentId, hook_event_name: 'PostToolUse',
      tool_use_id: `call-${requestId}`, tool_response: JSON.stringify(envelope(requestId)),
    }));
    const [a, b] = await Promise.all([call('agent-a', 'req-a'), call('agent-b', 'req-b')]);
    for (const result of [a, b]) assert.equal(result.code, 0, result.stderr);
    const dirOf = (result) => JSON.parse(result.stdout).hookSpecificOutput.additionalContext
      .split('\n').find(line => line.includes('--from')).match(/--from '([^']+)'/)[1];
    assert.equal(dirOf(a), path.join(staging, 'agent-a'));
    assert.equal(dirOf(b), path.join(staging, 'agent-b'));
    for (const [agent, requestId] of [['agent-a', 'req-a'], ['agent-b', 'req-b']]) {
      const snapshot = path.join(data, `run-${agent}`, 'snapshot');
      const drained = await run(process.execPath, [saveFile, '--from', path.join(staging, agent), '--into', snapshot], env);
      assert.equal(drained.code, 0, drained.stderr);
      assert.match(drained.stdout, /^staged=1$/m);
      assert.equal(JSON.parse(await fs.readFile(path.join(snapshot, 'envelope-01.json'), 'utf8')).request_id, requestId);
    }
    // The root session directory holds only the subagent folders; draining it takes nothing of theirs.
    const root = await run(process.execPath, [saveFile, '--from', staging, '--into', path.join(data, 'run-root', 'snapshot')], env);
    assert.equal(root.code, 0, root.stderr);
    assert.match(root.stdout, /^staged=0$/m);
  });

  test(`${host}: an incomplete staged entry is reported and left while complete ones still move`, async t => {
    const { data, staging, save } = await setup(t);
    const snapshot = path.join(data, 'snapshot');
    await fs.mkdir(staging, { recursive: true, mode: 0o700 });
    const done = JSON.stringify(envelope('req-done'));
    await fs.writeFile(path.join(staging, '01.json'), done, { mode: 0o600 });
    await fs.writeFile(path.join(staging, '01.meta'), `${JSON.stringify({
      connector_id: 'fixture', operation: 'search', status: 'completed',
      bytes: Buffer.byteLength(done), sha256: sha256(done), verbatim: true, request_id: 'req-done',
    })}\n`, { mode: 0o600 });
    // Another hook has written its body and not yet its sidecar.
    await fs.writeFile(path.join(staging, '02.json'), JSON.stringify(envelope('req-pending')), { mode: 0o600 });
    const result = await save('--from', staging, '--into', snapshot);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await fs.readFile(path.join(snapshot, 'envelope-01.json'), 'utf8'), done);
    assert.match(result.stderr, /02: envelope without sidecar/);
    assert.match(result.stdout, /^incomplete=1 /m);
    await fs.stat(path.join(staging, '02.json'));
  });

  test(`${host}: a stale lock is cleared at drain while a live one is kept`, async t => {
    const { data, staging, save } = await setup(t);
    await fs.mkdir(staging, { recursive: true, mode: 0o700 });
    const stale = path.join(staging, '05.lock');
    const live = path.join(staging, '06.lock');
    await fs.writeFile(stale, '', { mode: 0o600 });
    await fs.writeFile(live, '', { mode: 0o600 });
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    await fs.utimes(stale, tenMinutesAgo, tenMinutesAgo);
    const result = await save('--from', staging, '--into', path.join(data, 'snapshot'));
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(fs.stat(stale), { code: 'ENOENT' });
    await fs.stat(live);
  });

  test(`${host}: a batch whose later envelope cannot get a stem still reports the one it staged`, async t => {
    const { staging, hook } = await setup(t);
    await fs.mkdir(staging, { recursive: true, mode: 0o700 });
    // 99999999999999999999 reads back as 1e20, and 1e20 + 1 === 1e20: after the first envelope
    // takes stem "100000000000000000000", every retry for the second lands on that same stem, so
    // the retry budget is exhausted deterministically instead of by a real race.
    await fs.writeFile(path.join(staging, '99999999999999999999.lock'), '', { mode: 0o600 });
    const result = await hook({ results: [envelope('req-first'), envelope('req-second')] }, 'call-batch');
    assert.equal(result.code, 0, result.stderr);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /^kabo: /m);
    assert.match(context, /fixture\/search status=completed/);
    const meta = JSON.parse(await fs.readFile(path.join(staging, '100000000000000000000.meta'), 'utf8'));
    assert.equal(meta.request_id, 'req-first');
  });
}
