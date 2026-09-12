// Main + fast-path compatibility checks, isolated from host state and production services.
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
function run(file, args, env, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

for (const host of ['claude', 'codex']) {
  test(`${host}: signed operation pipelines preserve envelopes, artifacts, permissions and verification`, async t => {
    const plugin = path.join(root, 'plugins', host, 'kabo-alpha');
    const common = await import(pathToFileURL(path.join(plugin, 'scripts/lib/common.js')));
    const data = await fs.mkdtemp(path.join(os.tmpdir(), `kabo integration ${host} `));
    t.after(() => fs.rm(data, { recursive: true, force: true }));
    let syncRequests = 0;
    const server = http.createServer((req, res) => {
      assert.equal(req.method, 'GET');
      assert.equal(req.headers.authorization, undefined);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/sync') {
        syncRequests++;
        res.end(JSON.stringify({ server_api_version: '1.0.0', catalog: [], revocations: [] }));
      } else { res.writeHead(404); res.end('{}'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const env = { PATH: process.env.PATH, KABO_DATA_ROOT: data, KABO_CODEX_DATA: data, KABO_API_ENDPOINT: endpoint };
    const bin = (name, args, input) => run(path.join(plugin, 'bin', name), args, env, input);
    const pair = crypto.generateKeyPairSync('ed25519');
    const kid = common.sha256hex(pair.publicKey.export({ type: 'spki', format: 'der' })).slice(0, 16);
    await fs.writeFile(path.join(data, `public-keys.${common.sha256hex(endpoint).slice(0, 16)}.json`),
      JSON.stringify({ issued_at: null, keys: [{ kid, public_key_pem: pair.publicKey.export({type:'spki',format:'pem'}).toString() }] }), { mode: 0o600 });
    const id = 'integration-fixture';
    const script = [
      'import argparse, json',
      'from pathlib import Path',
      'p = argparse.ArgumentParser()',
      'p.add_argument("--envelope", action="append", required=True)',
      'p.add_argument("--output", required=True)',
      'a = p.parse_args()',
      'assert all(json.loads(Path(f).read_text())["status"] == "completed" for f in a.envelope)',
      'Path(a.output).write_text("Synthetic integration fixture: " + str(len(a.envelope)) + " envelopes.")',
    ].join('\n');
    const files = [
      { path: 'manifest.json', content: Buffer.from(JSON.stringify({ name: id, version:'1.0.0', execution:'subagent', required:{tools:[]}, min_plugin_version:'0.21.0', pipeline:[{name:'default',cmd:'printf default > {report}/REPORT.md'}], pipeline_operations:{fixture:[{name:'check',cmd:'python3 {skill}/scripts/check.py {envelopes} --output {report}/REPORT.md'}], semantic:[]} })) },
      { path: 'SKILL.md', content: Buffer.from('Synthetic fixture: local output only.') },
      { path: 'scripts/check.py', content: Buffer.from(script) },
    ];
    const checksum = common.computeChecksum(files, 1);
    const pkg = { id, version:'1.0.0', format_version:1, checksum, key_id:kid,
      signature:crypto.sign(null, Buffer.from(checksum), pair.privateKey).toString('base64'),
      files:files.map(({path,content}) => ({path,content_base64:content.toString('base64')})) };
    const plain = await bin('skill-unpack', ['-'], JSON.stringify(pkg));
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(plain.stdout, /Unpack succeeded\. Next step:/);
    assert.equal(syncRequests, 0);
    const combined = await bin('skill-unpack', ['--verify', '-'], JSON.stringify(pkg));
    assert.equal(combined.code, 0, combined.stderr);
    assert.match(combined.stdout, /manifest: execution=subagent has_pipeline=true pipeline_operations=\{"fixture":1,"semantic":0\}/);
    assert.match(combined.stdout, /Verification passed:/);
    assert.equal(syncRequests, 1);
    const skill = path.join(data, 'skill-cache', id, '1.0.0');
    assert.equal((await bin('skill-verify', [skill])).code, 0);
    assert.equal(syncRequests, 1, 'The accepted revocation-cache strategy must remain intact');
    const reserved = await bin('kabo-run-dir', ['--skill', skill]);
    assert.equal(reserved.code, 0);
    const runId = reserved.stdout.trim();
    const snapshot = path.join(data, 'work', runId, 'snapshot');
    const envelopes = [1, 2].map(n => ({connector_id:'integration-fixture',operation:`request-${n}`,status:'completed',limitations:[],retrieved_at:new Date().toISOString(),data:{n}}));
    const pipelineArgs = ['--run-id',runId,'--skill',skill,'--report','REPORT.md',
      '--operation','fixture'];
    const frame = Buffer.from('89504e470d0a1a0a0001020300ff', 'hex');
    const transcript = 'WEBVTT\n\n00:00.000 --> 00:01.000\nSynthetic transcript.\n';
    const session = 'integration-session';
    const hook = (payload, toolId) => run(path.join(plugin,'scripts/hooks/persist-envelope.js'), [], env,
      JSON.stringify({session_id:session,hook_event_name:'PostToolUse',tool_use_id:toolId,tool_response:JSON.stringify(payload)}));
    const staged = await Promise.all(envelopes.map((envelope, i) => hook(envelope, `fixture-${i}`)));
    for (const result of staged) { assert.equal(result.code,0); assert.match(result.stdout,/kabo:/); }
    const artifacts = await hook({
      structuredContent:{job_id:'fixture-job',artifacts:[
        {object_ref:'fixture-frame',kind:'keyframes',sha256:common.sha256hex(frame),content_type:'image/png'},
        {object_ref:'fixture-transcript',kind:'transcript',sha256:common.sha256hex(transcript),content_type:'text/vtt'},
      ]},
      content:[{type:'image',mimeType:'image/png',data:frame.toString('base64')},{type:'text',text:transcript}],
    },'fixture-artifacts');
    assert.equal(artifacts.code,0);
    assert.match(artifacts.stdout,/keyframes/);
    assert.match(artifacts.stdout,/transcript/);
    pipelineArgs.push('--staging',path.join(data,'envelope-staging',session));
    const pipeline = await bin('kabo-run-pipeline',pipelineArgs);
    assert.equal(pipeline.code,0,pipeline.stderr);
    assert.match(pipeline.stdout,/creator_report:/);
    assert.equal(syncRequests,1,'The pipeline post-check must use local verification only');
    assert.equal(await fs.readFile(path.join(data,'work',runId,'report/REPORT.md'),'utf8'),'Synthetic integration fixture: 2 envelopes.');
    assert.deepEqual(await fs.readFile(path.join(snapshot,'frame-0001.png')),frame);
    assert.equal(await fs.readFile(path.join(snapshot,'transcript-0001.vtt'),'utf8'),transcript);
    assert.match(pipeline.stdout,/drained=2/);
    const defaultRun = (await bin('kabo-run-dir',['--skill',skill])).stdout.trim();
    const defaultResult = await bin('kabo-run-pipeline',['--run-id',defaultRun,'--skill',skill]);
    assert.equal(defaultResult.code,0,defaultResult.stderr);
    assert.equal(await fs.readFile(path.join(data,'work',defaultRun,'report/REPORT.md'),'utf8'),'default');
    const disabled = await bin('kabo-run-pipeline',['--run-id',defaultRun,'--skill',skill,'--operation','semantic']);
    assert.equal(disabled.code,1);
    assert.match(disabled.stderr,/no non-empty pipeline array/);
    const quoted = await bin('kabo-run-pipeline',['--run-id',defaultRun,'--skill',skill,'--param','handle=x','--step','printf "%s" "{param.handle}" > {report}/BAD.md']);
    assert.equal(quoted.code,1);
    assert.match(quoted.stderr,/nothing was run/);
    const literal = "a' b; $(touch INJECTED) `touch ALSO-INJECTED`";
    const safe = await bin('kabo-run-pipeline',['--run-id',defaultRun,'--skill',skill,'--param',`handle=${literal}`,'--step','printf "%s" {param.handle} > {report}/SAFE.md']);
    assert.equal(safe.code,0,safe.stderr);
    assert.equal(await fs.readFile(path.join(data,'work',defaultRun,'report/SAFE.md'),'utf8'),literal);
    const failed = await bin('kabo-run-pipeline',['--run-id',defaultRun,'--skill',skill,'--step','exit 7','--step','touch {report}/SHOULD-NOT-EXIST.md']);
    assert.equal(failed.code,1);
    await assert.rejects(fs.stat(path.join(data,'work',defaultRun,'report/SHOULD-NOT-EXIST.md')), {code:'ENOENT'});
    assert.equal(syncRequests,1);
    const record = JSON.parse(await fs.readFile(path.join(data,'work',runId,'run-manifest.json'),'utf8'));
    assert.equal(record.provider_requests.length,2);
    assert.equal(record.status,'ok');
    assert.equal(record.runtime.agent,host === 'claude' ? 'claude-code' : 'codex');
    assert.equal((await fs.stat(path.join(data,'work',runId,'report/REPORT.md'))).mode & 0o777,0o600);
  });
}

test('Codex hooks.json stages PostToolUse as command and never declares unknown events', async () => {
  const hooks = JSON.parse(await fs.readFile(path.join(root, 'plugins/codex/kabo-alpha/hooks/hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ['PostToolUse', 'SessionStart']);
  const persist = hooks.hooks.PostToolUse[0];
  assert.match(persist.matcher, /data_connector_\(run\|batch_run\|job\|artifact\)\$/);
  assert.equal(persist.hooks[0].type, 'command');
  assert.match(persist.hooks[0].command, /persist-envelope\.js/);
  const declared = JSON.stringify(hooks.hooks);
  assert.doesNotMatch(declared, /mcp_tool/);
  assert.doesNotMatch(declared, /PostToolUseFailure/);
});
