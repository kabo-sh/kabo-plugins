import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hostScopeFromParams, bindRunAttempt, assertRunAttempt } from '../plugins/codex/kabo-alpha/scripts/lib/host-attempt.js';

// These are native-metadata/state fixtures, not model E2E evidence.
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-attempt-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skill = path.join(root, 'skill'); fs.mkdirSync(skill, { mode: 0o700 });
  const receipts = path.join(root, 'runtime-preparations'); fs.mkdirSync(receipts, { mode: 0o700 });
  const prepared = { id: 'example', version: '1.0.0', verified: true, exit_code: 0,
    skill_directory: skill, checksum: 'fixture-checksum', manifest_sha256: 'fixture-manifest' };
  const file = path.join(receipts, '123-abcd.json'); fs.writeFileSync(file, JSON.stringify(prepared), { mode: 0o600 });
  prepared.host_scope = { session_id: 'native-session', turn_id: 'native-turn' };
  const run = id => { const dir = path.join(root, id); fs.mkdirSync(dir, { mode: 0o700 }); return dir; };
  const loaded = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  return { root, skill, file, prepared, run, loaded };
}

test('scope comes from native metadata, never arguments; missing or mismatched ids fail closed', t => {
  const f = fixture(t);
  const meta = { threadId: 'native-session', 'x-codex-turn-metadata': { thread_id: 'native-session', turn_id: 'native-turn' } };
  assert.deepEqual(hostScopeFromParams({ _meta: meta }), f.prepared.host_scope);
  assert.equal(hostScopeFromParams({ arguments: { _meta: meta } }), null);
  for (const invalid of [null, {}, { threadId: 'native-session' },
    { ...meta, threadId: '../escape' }, { ...meta, 'x-codex-turn-metadata': { thread_id: 'other', turn_id: 'native-turn' } }])
    assert.equal(hostScopeFromParams({ _meta: invalid }), null);
  assert.throws(() => bindRunAttempt({ prepared: { ...f.prepared, host_scope: null }, runDir: f.run('r1'), runId: 'r1', root: f.root }), /scope_missing/);
});

test('one host turn binds one run; replacement preparation/version/run cannot reset failure, later user turn can run', t => {
  const f = fixture(t);
  const prepared = f.prepared, runDir = f.run('r1'), root = f.root;
  const binding = bindRunAttempt({ prepared, runDir, runId: 'r1', root });
  assert.deepEqual(bindRunAttempt({ prepared, runDir, runId: 'r1', root }), binding);
  fs.writeFileSync(path.join(runDir, 'run-manifest.json'), '{"status":"failed"}');
  const replacement = f.run('replacement');
  for (const candidate of [prepared, { ...prepared, version: '2.0.0', checksum: 'new-version' }])
    assert.throws(() => bindRunAttempt({ prepared: candidate, runDir: replacement, runId: 'replacement', root }), /already_reserved/);
  assert.deepEqual(assertRunAttempt({ runDir, runId: 'r1', skillDir: f.skill,
    checksum: prepared.checksum, manifest: prepared.manifest_sha256, root }), binding);
  assert.throws(() => assertRunAttempt({ runDir: replacement, runId: 'replacement', skillDir: f.skill,
    checksum: prepared.checksum, manifest: prepared.manifest_sha256, root }), /ENOENT/);
  const later = { ...prepared, host_scope: { ...prepared.host_scope, turn_id: 'later-user-turn' } };
  assert.doesNotThrow(() => bindRunAttempt({ prepared: later, runDir: replacement, runId: 'replacement', root }));
});

test('attempt index changes and local binding substitutions are rejected before execution', t => {
  const f = fixture(t);
  const prepared = f.prepared, runDir = f.run('r1');
  bindRunAttempt({ prepared, runDir, runId: 'r1', root: f.root });
  const index = path.join(f.root, 'runtime-attempts', fs.readdirSync(path.join(f.root, 'runtime-attempts'))[0]);
  const expected = fs.readFileSync(index);
  fs.writeFileSync(index, JSON.stringify({ ...JSON.parse(expected), run_id: 'other' }));
  const check = () => assertRunAttempt({ runDir, runId: 'r1', skillDir: f.skill,
    checksum: prepared.checksum, manifest: prepared.manifest_sha256, root: f.root });
  assert.throws(check, /host_attempt_binding_mismatch/);
  fs.writeFileSync(index, expected);
  const local = path.join(runDir, '.pipeline-attempt.json'); fs.unlinkSync(local); fs.symlinkSync(index, local);
  assert.throws(check, /not_regular/);
});
