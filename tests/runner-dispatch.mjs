// Local signed fixtures: role guards must not replace signature/revocation checks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
for (const host of ['codex', 'claude']) {
  test(`${host}: only a known Codex main thread is refused semantic subagent execution`, async t => {
    const plugin = path.join(root, 'plugins', host, 'kabo-alpha');
    const common = await import(pathToFileURL(path.join(plugin, 'scripts/lib/common.js')));
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'kabo-role-'));
    t.after(() => fs.rmSync(data, { recursive: true, force: true }));
    const endpoint = 'https://fixture.invalid';
    const env = { PATH: process.env.PATH, KABO_CODEX_DATA: data, KABO_DATA_ROOT: data, KABO_API_ENDPOINT: endpoint };
    const call = (file, args, extra = {}, input = '') => spawnSync(process.execPath, [path.join(plugin, file), ...args], {
      env: { ...env, ...extra }, input, encoding: 'utf8', timeout: 10_000,
    });
    const pair = crypto.generateKeyPairSync('ed25519');
    const kid = common.sha256hex(pair.publicKey.export({ type: 'spki', format: 'der' })).slice(0, 16);
    fs.writeFileSync(path.join(data, `public-keys.${common.sha256hex(endpoint).slice(0, 16)}.json`), JSON.stringify({ keys: [{ kid,
      public_key_pem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }] }));
    const files = [{ path: 'manifest.json', content: Buffer.from(JSON.stringify({ name: 'role-fixture', version: '1.0.0',
      execution: 'subagent', required: { tools: [] }, min_plugin_version: '0.21.0',
      pipeline: [{ cmd: 'printf signed > {report}/REPORT.md' }], pipeline_operations: {
        judgment: [], planned: [{ cmd: 'printf planned > {report}/REPORT.md' }],
      },
    })) }, { path: 'SKILL.md', content: Buffer.from('Synthetic fixture.') }];
    const checksum = common.computeChecksum(files, 1);
    const pkg = { id: 'role-fixture', version: '1.0.0', format_version: 1, checksum, key_id: kid,
      signature: crypto.sign(null, Buffer.from(checksum), pair.privateKey).toString('base64'),
      files: files.map(({ path, content }) => ({ path, content_base64: content.toString('base64') })),
    };
    assert.equal(call('bin/skill-unpack', ['-'], {}, JSON.stringify(pkg)).status, 0);
    const skill = path.join(data, 'skill-cache/role-fixture/1.0.0');
    const hook = (session, agent) => call('scripts/hooks/persist-envelope.js', [], {}, JSON.stringify({
      session_id: session, ...(agent === undefined ? {} : { agent_id: agent }), hook_event_name: 'PostToolUse',
      transcript_path: '/must-not-be-read', tool_response: 'ordinary non-envelope result',
    }));
    const reserve = () => {
      const r = call('bin/kabo-run-dir', ['--skill', skill]);
      assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
    };
    const execute = (thread, operation, runId = reserve()) => ({ runId, result: call('bin/kabo-run-pipeline', [
      '--run-id', runId, '--skill', skill, ...(operation ? ['--operation', operation, '--step', 'printf judgment > {report}/REPORT.md'] : []),
    ], { CODEX_THREAD_ID: thread }) });
    assert.equal(hook('main-thread').status, 0);
    assert.equal(hook('main-thread', 'child-thread').status, 0);
    const main = execute('main-thread', 'judgment');
    if (host === 'codex') {
      assert.equal(main.result.status, 1, main.result.stderr);
      assert.match(main.result.stderr, /requires skill-runner/);
      assert.equal(fs.existsSync(path.join(data, 'work', main.runId, 'report/REPORT.md')), false);
      assert.equal(fs.existsSync(path.join(data, 'work', main.runId, '.pipeline-stages.json')), false);
      const contextDir = path.join(data, 'envelope-staging', '.executors');
      const saved = JSON.parse(fs.readFileSync(path.join(contextDir, 'child-thread.json'), 'utf8'));
      assert.deepEqual(saved, { session_id: 'main-thread', agent_id: 'child-thread' });
      assert.equal(fs.statSync(path.join(contextDir, 'child-thread.json')).mode & 0o777, 0o600);
      assert.equal(hook('bad/thread').stdout, '');
      assert.equal(hook('invalid-agent', '../bad').stdout, '');
      assert.equal(fs.existsSync(path.join(contextDir, 'invalid-agent.json')), false);
    } else assert.equal(main.result.status, 0, main.result.stderr);
    for (const [thread, operation] of [['child-thread', 'judgment'], ['unknown-thread', 'judgment'], ['main-thread', null]]) {
      const { result, runId } = execute(thread, operation);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(path.join(data, 'work', runId, 'report/REPORT.md'), 'utf8'), operation ? 'judgment' : 'signed');
    }
    const plannedId = reserve();
    const planned = call('bin/kabo-run-pipeline', ['--run-id', plannedId, '--skill', skill, '--operation', 'planned'], { CODEX_THREAD_ID: 'main-thread' });
    assert.equal(planned.status, 0, planned.stderr);
    assert.equal(fs.readFileSync(path.join(data, 'work', plannedId, 'report/REPORT.md'), 'utf8'), 'planned');
    const inline = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { runnerDispatchError } from ${JSON.stringify(pathToFileURL(path.join(plugin, 'scripts/lib/executor-context.js')).href)}; if (runnerDispatchError({ execution: 'inline' }, null) !== null) process.exit(1);`,
    ], { env: { ...env, CODEX_THREAD_ID: 'main-thread' }, encoding: 'utf8' });
    assert.equal(inline.status, 0, inline.stderr);
    // A permitted child still cannot execute a modified signed package successfully.
    fs.appendFileSync(path.join(skill, 'SKILL.md'), 'tampered');
    const tampered = execute('child-thread', 'judgment');
    assert.equal(tampered.result.status, 1);
    assert.match(tampered.result.stderr, /checksum|verification|went red/i);
  });
}
