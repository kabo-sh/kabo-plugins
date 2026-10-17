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

async function exitedPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => child.once('close', resolve));
  return child.pid;
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

  test(`${host}: an exact running managed run destination is normalized to its snapshot`, async t => {
    const { data, staging, hook, save } = await setup(t);
    const id = '20261017T184208Z-13ae36d8';
    const work = path.join(data, 'work', id);
    await fs.mkdir(path.join(work, 'snapshot'), { recursive: true });
    const manifest = JSON.stringify({ run_id: id, status: 'running', finished_at: null, skill_id: 'fixture' });
    await fs.writeFile(path.join(work, 'run-manifest.json'), manifest);
    const body = envelope('normalized-root');
    assert.equal((await hook(body, 'normalized-root')).code, 0);
    const result = await save('--from', staging, '--into', work);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`destination: ${id} -> snapshot/`));
    assert.ok(!result.stdout.includes(data));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(work, 'snapshot/envelope-01.json'))), body);
    await assert.rejects(fs.stat(path.join(work, 'envelope-01.json')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(work, 'run-manifest.json'), 'utf8'), manifest);
  });

  test(`${host}: explicit snapshot destination retains its path and output contract`, async t => {
    const { data, staging, hook, save } = await setup(t);
    const snapshot = path.join(data, 'work', '20261017T184208Z-13ae36d8', 'snapshot');
    const body = envelope('unchanged-snapshot');
    assert.equal((await hook(body, 'unchanged-snapshot')).code, 0);
    const result = await save('--from', staging, '--into', snapshot);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /destination:/);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(snapshot, 'envelope-01.json'))), body);
  });

  test(`${host}: empty staging does not excuse a closed managed root`, async t => {
    const { data, staging, save } = await setup(t);
    const id = '20261017T184208Z-13ae36d8';
    const work = path.join(data, 'work', id);
    await fs.mkdir(work, { recursive: true });
    await fs.writeFile(path.join(work, 'run-manifest.json'), JSON.stringify({ run_id: id,
      skill_id: 'fixture', status: 'failed', finished_at: '2026-10-17T18:45:00Z' }));
    const result = await save('--from', staging, '--into', work);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /running skill reservation/);
    await assert.rejects(fs.stat(path.join(work, 'snapshot')), { code: 'ENOENT' });
  });

  test(`${host}: managed root ambiguity fails before staging bytes move`, async t => {
    const variants = ['wrong-id', 'failed', 'ok', 'missing-manifest', 'bad-json', 'manifest-link',
      'unknown-skill', 'finished-running', 'snapshot-link', 'broken-snapshot-link', 'root-link', 'traversal', 'preexisting-root-envelope'];
    for (const variant of variants) await t.test(variant, async t => {
      const { data, staging, hook, save } = await setup(t);
      const id = '20261017T184208Z-13ae36d8';
      const work = path.join(data, 'work', id);
      await fs.mkdir(work, { recursive: true });
      const record = { run_id: id, status: 'running', finished_at: null, skill_id: 'fixture' };
      if (variant === 'wrong-id') record.run_id = 'another-run';
      if (['failed', 'ok'].includes(variant)) record.status = variant;
      if (variant === 'unknown-skill') record.skill_id = 'unknown';
      if (variant === 'finished-running') record.finished_at = '2026-10-17T18:45:00Z';
      const manifest = path.join(work, 'run-manifest.json');
      if (variant !== 'missing-manifest') await fs.writeFile(manifest, variant === 'bad-json' ? '{' : JSON.stringify(record));
      const outside = path.join(data, 'outside');
      await fs.mkdir(outside);
      if (variant === 'preexisting-root-envelope') await fs.writeFile(path.join(work, 'envelope-01.json'), JSON.stringify(envelope('previous-root')));
      if (variant === 'manifest-link') {
        await fs.rename(manifest, path.join(outside, 'manifest.json'));
        await fs.symlink(path.join(outside, 'manifest.json'), manifest);
      }
      if (variant.includes('snapshot-link')) await fs.symlink(variant === 'broken-snapshot-link' ? path.join(outside, 'absent') : outside, path.join(work, 'snapshot'));
      let destination = work;
      if (variant === 'root-link') {
        const alias = path.join(data, 'work', '20261017T184208Z-aaaaaaaa');
        await fs.symlink(work, alias); destination = alias;
      }
      if (variant === 'traversal') destination = path.join(work, 'child') + '/../';
      assert.equal((await hook(envelope(variant), variant)).code, 0);
      const before = await fs.readFile(path.join(staging, '01.json'));
      const result = await save('--from', staging, '--into', destination);
      assert.equal(result.code, 1, variant);
      assert.match(result.stderr, /managed|running skill reservation/);
      assert.deepEqual(await fs.readFile(path.join(staging, '01.json')), before);
      assert.ok((await fs.stat(path.join(staging, '01.meta'))).isFile());
      await assert.rejects(fs.stat(path.join(outside, 'envelope-01.json')), { code: 'ENOENT' });
    });
  });

  test(`${host}: complete structured results survive a truncated display`, async t => {
    const { env, staging } = await setup(t);
    const payload = envelope('req-large');
    payload.data.text = 'complete transcript '.repeat(5000);
    const result = await run(process.execPath, [hookFile], env, JSON.stringify({
      session_id: 'staging-session', tool_use_id: 'call-large',
      tool_response: { structuredContent: payload, content: [{ type: 'text', text: 'Output too large; preview omitted' }] },
    }));
    assert.match(result.stdout, /kabo:/);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(staging, '01.json'), 'utf8')), payload);
    assert.equal(JSON.parse(await fs.readFile(path.join(staging, '01.meta'), 'utf8')).verbatim, false);
  });

  test(`${host}: request URL binding is generic but limited to matching direct Kabo requests`, async t => {
    const {env,staging}=await setup(t);
    const payload={...envelope('req-share'),connector_id:'tiktok-search',operation:'get_video'};
    const event={session_id:'staging-session',tool_use_id:'call-share',tool_name:'mcp__kabo__data_connector_run',
      tool_input:{connector_id:'tiktok-search',operation:'get_video',params:{url:'https://vm.tiktok.com/abc/'}},tool_response:{structuredContent:payload}};
    const page={...envelope('req-page'),connector_id:'official-page-render',operation:'render_page'};
    const pageInput={connector_id:'official-page-render',operation:'render_page',params:{url:'https://support.example.test/rules'}};
    // [event override, expected requested_url]
    const cases=[
      [{tool_name:'mcp__other__data_connector_run'},undefined],
      [{tool_use_id:null},undefined],
      [{tool_input:{...event.tool_input,operation:'search'}},undefined],
      [{tool_input:{...event.tool_input,params:{url:'http://vm.tiktok.com/abc/'}}},undefined],
      [{tool_input:{...event.tool_input,params:{url:'https://user:pw@vm.tiktok.com/abc/'}}},undefined],
      [{tool_input:{...event.tool_input,params:{url:'https://vm.tiktok.com:8443/abc/'}}},undefined],
      [{tool_input:{...event.tool_input,params:{url:'https://vm.tiktok.com.example.test/abc/'}}},'https://vm.tiktok.com.example.test/abc/'],
      [{tool_input:pageInput,tool_response:{structuredContent:page}},pageInput.params.url],
      [{},event.tool_input.params.url],
    ];
    for(let i=0;i<cases.length;i++) {
      const result=await run(process.execPath,[hookFile],env,JSON.stringify({...event,...cases[i][0]}));
      assert.equal(result.code,0,result.stderr);
      const meta=JSON.parse(await fs.readFile(path.join(staging,String(i+1).padStart(2,'0')+'.meta'),'utf8'));
      assert.equal(meta.requested_url,cases[i][1],`case ${i}`);
    }
  });

  test(`${host}: host-owned saved results are recovered only within the current session`, async t => {
    const { data, env, staging } = await setup(t);
    const config = path.join(data, 'host-config');
    const dir = path.join(config, 'projects', '-fixture', 'staging-session', 'tool-results');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'call-large.txt');
    const bytes = JSON.stringify(envelope('req-saved'), null, 2);
    await fs.writeFile(file, bytes);
    const call = file => run(process.execPath, [hookFile], { ...env, CLAUDE_CONFIG_DIR: config }, JSON.stringify({
      session_id: 'staging-session', tool_use_id: 'call-large',
      tool_response: `Output too large (100.0KB). Full output saved to: ${file}\n\nPreview: omitted`,
    }));
    assert.match((await call(file)).stdout, /kabo:/);
    assert.equal(await fs.readFile(path.join(staging, '01.json'), 'utf8'), bytes);
    const outside = path.join(data, 'outside.json');
    await fs.writeFile(outside, bytes);
    assert.equal((await call(outside)).stdout, '');
    const other = file.replace('staging-session', 'other-session');
    await fs.mkdir(path.dirname(other), { recursive: true });
    await fs.writeFile(other, bytes);
    assert.equal((await call(other)).stdout, '');
    const link = path.join(dir, 'link.txt');
    await fs.symlink(outside, link);
    assert.equal((await call(link)).stdout, '');
    assert.equal((await call(path.join(dir, 'missing.txt'))).stdout, '');
  });

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

  for (const writer of ['json', 'art']) {
    test(`${host}: a stale ${writer} sequence cannot reuse a completed opposite-type stem`, async t => {
      const { data, env, staging, save } = await setup(t);
      await fs.mkdir(staging, { recursive: true, mode: 0o700 });
      const frame = Buffer.from('fixture frame bytes');
      const priorBody = writer === 'json' ? frame : Buffer.from(JSON.stringify(envelope('req-prior')));
      const priorMeta = writer === 'json'
        ? { artifact: true, kind: 'keyframes', object_ref: 'prior-frame', status: 'completed',
            bytes: priorBody.length, sha256: sha256(priorBody), content_type: 'image/png', verbatim: true }
        : { connector_id: 'fixture', operation: 'search', status: 'completed',
            bytes: priorBody.length, sha256: sha256(priorBody), request_id: 'req-prior', verbatim: true };
      const stem = writer === 'json' ? '01' : '02';
      const opposite = writer === 'json' ? 'art' : 'json';
      const preload = path.join(data, 'stale-sequence.mjs');
      // Another writer completes after nextSequence has read the directory but before this
      // writer takes the now-released lock. Force that schedule without changing the hook.
      await fs.writeFile(preload, `import fs from 'node:fs';
const original = fs.writeFileSync;
let injected = false;
fs.writeFileSync = function(file, ...args) {
  if (!injected && String(file).endsWith(${JSON.stringify(`/${stem}.lock`)})) {
    injected = true;
    original(${JSON.stringify(path.join(staging, `${stem}.${opposite}`))}, Buffer.from(${JSON.stringify([...priorBody])}), { mode: 0o600, flag: 'wx' });
    original(${JSON.stringify(path.join(staging, `${stem}.meta`))}, ${JSON.stringify(JSON.stringify(priorMeta) + '\n')}, { mode: 0o600, flag: 'wx' });
  }
  return original.call(this, file, ...args);
};
`);
      const payload = writer === 'json' ? envelope('req-new') : {
        structuredContent: { ...envelope('req-new'), job_id: 'fixture-job', artifacts: [{
          kind: 'keyframes', object_ref: 'new-frame', content_type: 'image/png', sha256: sha256(frame),
        }] },
        content: [{ type: 'image', data: frame.toString('base64'), mimeType: 'image/png' }],
      };
      const result = await run(process.execPath, ['--import', preload, hookFile], env, JSON.stringify({
        session_id: 'staging-session', tool_use_id: 'stale-call', tool_response: JSON.stringify(payload),
      }));
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(await fs.readFile(path.join(staging, `${stem}.${opposite}`)), priorBody);
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(staging, `${stem}.meta`), 'utf8')), priorMeta);
      await assert.rejects(fs.stat(path.join(staging, `${stem}.${writer}`)), { code: 'ENOENT' });
      const drained = await save('--from', staging, '--into', path.join(data, 'snapshot'));
      assert.equal(drained.code, 0, drained.stderr);
      assert.equal((await fs.readdir(staging)).length, 0, 'all intact evidence is drained');
    });
  }

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

  test(`${host}: the staged listing names each file's request so request order can be restored`, async t => {
    const { staging, hook, save } = await setup(t);
    // The second request is staged first: staging numbers carry no request order.
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
    await fs.writeFile(stale, `${await exitedPid()} crashed-writer\n`, { mode: 0o600 });
    await fs.writeFile(live, `${process.pid} live-writer\n`, { mode: 0o600 });
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    await fs.utimes(stale, tenMinutesAgo, tenMinutesAgo);
    const result = await save('--from', staging, '--into', path.join(data, 'snapshot'));
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(fs.stat(stale), { code: 'ENOENT' });
    await fs.stat(live);
  });

  test(`${host}: an old lock whose writer is still running is never reclaimed`, async t => {
    const { data, staging, save } = await setup(t);
    await fs.mkdir(staging, { recursive: true, mode: 0o700 });
    const held = path.join(staging, '07.lock');
    // Old by the clock, but its owner (this test process) is alive: it is being written, not orphaned.
    await fs.writeFile(held, `${process.pid} slow-writer\n`, { mode: 0o600 });
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    await fs.utimes(held, tenMinutesAgo, tenMinutesAgo);
    const result = await save('--from', staging, '--into', path.join(data, 'snapshot'));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await fs.readFile(held, 'utf8'), `${process.pid} slow-writer\n`);
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

test('codex runner instructions promise no staging order and keep partial evidence in fallback', async () => {
  for (const skill of ['skill-runner', 'analyze']) {
    const text = await fs.readFile(path.join(root, 'plugins/codex/kabo-alpha/skills', skill, 'SKILL.md'), 'utf8');
    const step = text.split('\n').find(line => /\*\*Drain or write/.test(line));
    assert.ok(step, skill);
    assert.doesNotMatch(step, /numbered in completion order/, skill);
    assert.match(step, /carry no request order/, skill);
    assert.match(step, /request_id/, skill);
    assert.match(step, /`completed`, `completed_partial` or `partial`/, skill);
  }
});
