// Signed local fixtures exercise both hosts without installed-cache edits or production services.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
function run(file, args, env, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

for (const host of ['claude', 'codex']) {
  test(`${host}: staged execution preserves one run, native paths, evidence and terminal guards`, async t => {
    const plugin = path.join(root, 'plugins', host, 'kabo-alpha');
    const common = await import(pathToFileURL(path.join(plugin, 'scripts/lib/common.js')));
    const data = await fs.mkdtemp(path.join(os.tmpdir(), `kabo staged ${host} `));
    t.after(() => fs.rm(data, { recursive: true, force: true }));
    let syncRequests = 0;
    const server = http.createServer((req, res) => {
      assert.equal(req.headers.authorization, undefined);
      if (req.url !== '/api/sync') { res.writeHead(404); res.end('{}'); return; }
      syncRequests++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ server_api_version: '1.0.0', catalog: [], revocations: [] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const env = { PATH: process.env.PATH, KABO_DATA_ROOT: data, KABO_CODEX_DATA: data, KABO_API_ENDPOINT: endpoint };
    const bin = (name, args, input) => run(path.join(plugin, 'bin', name), args, env, input);
    const pair = crypto.generateKeyPairSync('ed25519');
    const kid = common.sha256hex(pair.publicKey.export({ type: 'spki', format: 'der' })).slice(0, 16);
    await fs.writeFile(path.join(data, `public-keys.${common.sha256hex(endpoint).slice(0, 16)}.json`),
      JSON.stringify({ keys: [{ kid, public_key_pem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] }), { mode: 0o600 });
    const id = 'staged-fixture';
    const script = `import argparse, json, os\nfrom pathlib import Path\np=argparse.ArgumentParser()\np.add_argument('stage')\np.add_argument('--run', required=True)\np.add_argument('--placed')\na=p.parse_args()\nr=Path(a.run)\nassert os.environ.get('PYTHONDONTWRITEBYTECODE') == '1'\nif a.stage == 'start':\n    assert sorted(x.name for x in r.iterdir()) == ['analysis','owner','report','run-manifest.json','snapshot']\n    (r/'request.json').write_text(json.dumps({'connector_id':'fixture','operation':'read'}))\n    print('hand-over: fetch fixture/read; repeat with --placed')\nelif a.stage == 'content':\n    e=json.loads(Path(a.placed).read_text())\n    assert e['status'] == 'completed_partial' and e['limitations'] == ['Missing one comment page']\n    (r/'placed.json').write_bytes(Path(a.placed).read_bytes())\n    (r/'analysis.json').write_text(json.dumps({'items':e['data']['items']}))\n    print('content complete; model judgment required')\nelif a.stage == 'report':\n    d=json.loads((r/'decision.json').read_text())\n    e=json.loads((r/'placed.json').read_text())\n    assert d == {'chosen':['account-a']}\n    text='# Fixture report\\n\\n[account-a](https://example.test/post/1)\\n\\nMissing one comment page.\\n'\n    (r/'creator-reply.md').write_text(text)\n    assert (r/'creator-reply.md').read_text() == text\nelse: raise ValueError(a.stage)\n`;
    const files = [
      { path: 'manifest.json', content: Buffer.from(JSON.stringify({ name: id, version: '1.0.0', execution: 'subagent', required: { tools: [] }, min_plugin_version: '0.21.9', pipeline: [{ name: 'fixed', cmd: 'printf fixed > {report}/FIXED.md' }], pipeline_operations: { staged: [] } })) },
      { path: 'SKILL.md', content: Buffer.from('Synthetic fixture: start -> fetch -> content -> model decision -> validated report.') },
      { path: 'scripts/drive.py', content: Buffer.from(script) },
    ];
    const checksum = common.computeChecksum(files, 1);
    const pkg = { id, version: '1.0.0', format_version: 1, checksum, key_id: kid,
      signature: crypto.sign(null, Buffer.from(checksum), pair.privateKey).toString('base64'),
      files: files.map(({ path, content }) => ({ path, content_base64: content.toString('base64') })) };
    const unpacked = await bin('skill-unpack', ['--verify', '-'], JSON.stringify(pkg));
    assert.equal(unpacked.code, 0, unpacked.stderr);
    const skill = path.join(data, 'skill-cache', id, '1.0.0');
    const reserve = async () => {
      const result = await bin('kabo-run-dir', ['--skill', skill]);
      assert.equal(result.code, 0, result.stderr);
      return result.stdout.trim();
    };
    const args = runId => ['--run-id', runId, '--skill', skill, '--operation', 'staged'];
    const record = async runId => JSON.parse(await fs.readFile(path.join(data, 'work', runId, 'run-manifest.json'), 'utf8'));
    const step = stage => `python3 {skill}/scripts/drive.py ${stage} --run {run}`;

    await t.test('fetch and judgment pauses keep the reservation running; only validated final output closes it', async () => {
      const runId = await reserve();
      const work = path.join(data, 'work', runId);
      const start = await bin('kabo-run-pipeline', [...args(runId), '--continue', '--step', step('start')]);
      assert.equal(start.code, 0, start.stderr);
      assert.match(start.stdout, /hand-over/);
      assert.doesNotMatch(start.stdout, /creator_report:/);
      const before = await record(runId);
      assert.equal(before.status, 'running');
      assert.equal(before.finished_at, null);
      assert.equal(before.duration_seconds, null);
      const envelope = JSON.stringify({ connector_id: 'fixture', operation: 'read', status: 'completed_partial', provider: 'synthetic-source', limitations: ['Missing one comment page'], retrieved_at: '2026-10-09T00:00:00Z', data: { items: [{ id: 'account-a', url: 'https://example.test/post/1' }] } });
      const session = 'staged-test';
      const hook = await run(path.join(plugin, 'scripts/hooks/persist-envelope.js'), [], env,
        JSON.stringify({ session_id: session, hook_event_name: 'PostToolUse', tool_use_id: 'stage-fetch', tool_response: envelope }));
      assert.equal(hook.code, 0, hook.stderr);
      assert.match(hook.stdout, /kabo:/);
      const content = await bin('kabo-run-pipeline', [...args(runId), '--continue', '--staging', path.join(data, 'envelope-staging', session), '--step', `${step('content')} --placed {snapshot}/envelope-01.json`]);
      assert.equal(content.code, 0, content.stderr);
      assert.doesNotMatch(content.stdout, /creator_report:/);
      assert.equal((await record(runId)).status, 'running');
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(work, 'placed.json'), 'utf8')), JSON.parse(envelope));
      await fs.writeFile(path.join(work, 'decision.json'), JSON.stringify({ chosen: ['account-a'] }), { mode: 0o600 });
      const absent = await bin('kabo-run-pipeline', [...args(runId), '--step', step('report')]);
      assert.equal(absent.code, 1);
      assert.match(absent.stderr, /final stage must name its report/);
      const finished = await bin('kabo-run-pipeline', [...args(runId), '--report-file', 'creator-reply.md', '--step', step('report')]);
      assert.equal(finished.code, 0, finished.stderr);
      assert.match(finished.stdout, new RegExp(`creator_report: ${runId} → creator-reply.md`));
      const final = await record(runId);
      assert.equal(final.status, 'ok');
      assert.equal(final.started_at, before.started_at);
      assert.ok(final.finished_at && final.duration_seconds >= 0);
      assert.deepEqual(final.provider_requests.map(x => x.status), ['completed_partial']);
      const artifact = final.artifacts.find(x => x.path_or_uri === 'creator-reply.md');
      assert.equal(artifact.kind, 'report');
      assert.equal(artifact.sha256, common.sha256hex(await fs.readFile(path.join(work, 'creator-reply.md'))));
      for (const name of ['creator-reply.md', 'decision.json', 'analysis.json', 'placed.json', 'run-manifest.json']) assert.equal((await fs.stat(path.join(work, name))).mode & 0o777, 0o600);
      assert.equal((await fs.stat(work)).mode & 0o777, 0o700);
      const closed = await bin('kabo-run-pipeline', [...args(runId), '--continue', '--step', 'touch {run}/AFTER-CLOSE']);
      assert.equal(closed.code, 1);
      await assert.rejects(fs.stat(path.join(work, 'AFTER-CLOSE')), { code: 'ENOENT' });
    });

    await t.test('failure stops later steps, ends the staged run and announces no report', async () => {
      const runId = await reserve();
      const failed = await bin('kabo-run-pipeline', [...args(runId), '--continue', '--step', 'exit 7', '--step', 'touch {run}/SHOULD-NOT-RUN']);
      assert.equal(failed.code, 1);
      assert.doesNotMatch(failed.stdout, /creator_report:/);
      assert.equal((await record(runId)).status, 'failed');
      assert.ok((await record(runId)).finished_at);
      const replay = await bin('kabo-run-pipeline', [...args(runId), '--continue', '--step', 'touch {run}/SHOULD-NOT-RUN']);
      assert.equal(replay.code, 1);
      await assert.rejects(fs.stat(path.join(data, 'work', runId, 'SHOULD-NOT-RUN')), { code: 'ENOENT' });
    });

    await t.test('selected signed pipelines keep their one-shot contract', async () => {
      const runId = await reserve();
      const override = await bin('kabo-run-pipeline', ['--run-id', runId, '--skill', skill, '--continue', '--step', 'touch {run}/OVERRIDE']);
      assert.equal(override.code, 1);
      assert.match(override.stderr, /selected signed pipeline must run once/);
      const fixed = await bin('kabo-run-pipeline', ['--run-id', runId, '--skill', skill]);
      assert.equal(fixed.code, 0, fixed.stderr);
      assert.equal(await fs.readFile(path.join(data, 'work', runId, 'report/FIXED.md'), 'utf8'), 'fixed');
    });

    await t.test('concurrent stages cannot share a run', async () => {
      const runId = await reserve();
      const lock = path.join(data, 'work', `.${runId}.pipeline-lock`);
      const first = bin('kabo-run-pipeline', [...args(runId), '--continue', '--step', 'sleep 1']);
      for (let i = 0; i < 100; i++) {
        try { await fs.stat(lock); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
      }
      const second = await bin('kabo-run-pipeline', [...args(runId), '--continue', '--step', 'touch {run}/COLLISION']);
      assert.equal(second.code, 1);
      assert.match(second.stderr, /another pipeline stage is running/);
      assert.equal((await first).code, 0);
      await assert.rejects(fs.stat(path.join(data, 'work', runId, 'COLLISION')), { code: 'ENOENT' });
    });

    await t.test('root report traversal and symlinks cannot be announced', async () => {
      const runId = await reserve();
      const traversal = await bin('kabo-run-pipeline', [...args(runId), '--report-file', '../outside.md', '--step', 'true']);
      assert.equal(traversal.code, 1);
      assert.match(traversal.stderr, /bare file name/);
      const link = await bin('kabo-run-pipeline', [...args(runId), '--report-file', 'reply.md', '--step', 'ln -s {skill}/SKILL.md {run}/reply.md']);
      assert.equal(link.code, 1);
      assert.match(link.stderr, /symlink/);
      assert.doesNotMatch(link.stdout, /creator_report:/);
      assert.equal((await record(runId)).status, 'failed');
    });

    await t.test('revocation and cache tampering between stages stop before execution', async () => {
      const revoked = await reserve();
      assert.equal((await bin('kabo-run-pipeline', [...args(revoked), '--continue', '--step', step('start')])).code, 0);
      const marker = path.join(data, 'skill-cache', `${id}.disabled`);
      await fs.writeFile(marker, '{}');
      const stop = await bin('kabo-run-pipeline', [...args(revoked), '--continue', '--step', 'touch {run}/UNTRUSTED']);
      assert.equal(stop.code, 1);
      assert.equal((await record(revoked)).status, 'failed');
      await assert.rejects(fs.stat(path.join(data, 'work', revoked, 'UNTRUSTED')), { code: 'ENOENT' });
      await fs.unlink(marker);
      const tampered = await reserve();
      assert.equal((await bin('kabo-run-pipeline', [...args(tampered), '--continue', '--step', step('start')])).code, 0);
      await fs.appendFile(path.join(skill, 'scripts/drive.py'), '\n# tampered\n');
      const rejected = await bin('kabo-run-pipeline', [...args(tampered), '--continue', '--step', 'touch {run}/UNTRUSTED']);
      assert.equal(rejected.code, 1);
      assert.equal((await record(tampered)).status, 'failed');
      await assert.rejects(fs.stat(path.join(data, 'work', tampered, 'UNTRUSTED')), { code: 'ENOENT' });
    });
    assert.equal(syncRequests, 1, 'Stage checks are local-only and never introduce a new authenticated fetch');
  });
}
