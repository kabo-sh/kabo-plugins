// A --skill path that is not a skill directory reserves nothing; a real one keeps its manifest record.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
for (const host of ['codex', 'claude']) {
  test(`${host}: kabo-run-dir refuses a --skill path without a named manifest`, t => {
    const plugin = path.join(root, 'plugins', host, 'kabo-alpha');
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'kabo-run-dir-'));
    t.after(() => fs.rmSync(data, { recursive: true, force: true }));
    const call = args => spawnSync(process.execPath, [path.join(plugin, 'bin/kabo-run-dir'), ...args], {
      env: { PATH: process.env.PATH, KABO_CODEX_DATA: data, KABO_DATA_ROOT: data }, encoding: 'utf8', timeout: 10_000,
    });
    const work = () => (fs.existsSync(path.join(data, 'work')) ? fs.readdirSync(path.join(data, 'work')) : []);
    const unnamed = path.join(data, 'unnamed');
    fs.mkdirSync(unnamed);
    fs.writeFileSync(path.join(unnamed, 'manifest.json'), '{"version":"1.0.0"}');
    for (const bad of [path.join(data, 'skill-cache/x/...'), path.join(data, 'missing'), unnamed]) {
      const result = call(['--skill', bad]);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /is not a skill directory/);
      assert.equal(result.stdout, '');
      assert.deepEqual(work(), []);
    }
    const skill = path.join(data, 'skill-cache/fixture/1.0.0');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'manifest.json'), '{"name":"fixture","version":"1.0.0"}');
    const reserved = call(['--skill', skill]);
    assert.equal(reserved.status, 0, reserved.stderr);
    const runId = reserved.stdout.trim();
    const record = JSON.parse(fs.readFileSync(path.join(data, 'work', runId, 'run-manifest.json'), 'utf8'));
    assert.equal(record.skill_id, 'fixture');
    assert.equal(record.status, 'running');
    const plain = call([]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(fs.existsSync(path.join(data, 'work', plain.stdout.trim(), 'run-manifest.json')), false);
  });
}
