import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
for (const layout of ['codex', 'claude']) {
  test(`${layout} readonly snapshot: scope-only, no report demand, corruption fails closed`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-snapshot-'));
    const script = path.resolve(`plugins/${layout}/kabo-alpha/scripts/report-delivery-snapshot.js`);
    const scope = { session_id: 'thread-1', turn_id: 'turn-1' };
    const run = (input, args = []) => spawnSync(process.execPath, [script, ...args], { env: { KABO_DATA_ROOT: root, KABO_CODEX_DATA: root }, input: JSON.stringify(input), encoding: 'utf8' });
    try {
      const empty = run(scope); assert.equal(empty.status, 0); assert.deepEqual(JSON.parse(empty.stdout), { reports: [] });
      assert.notEqual(run({ ...scope, path: '/arbitrary/report' }).status, 0);
      assert.notEqual(run(scope, ['/arbitrary/path']).status, 0);
      assert.notEqual(run({ session_id: '../outside', turn_id: 'turn' }).status, 0);
      const base = path.join(root, 'runtime-attempts', createHash('sha256').update(JSON.stringify([scope.session_id, scope.turn_id])).digest('hex'));
      fs.mkdirSync(base, { recursive: true, mode: 0o700 }); fs.mkdirSync(path.join(root, 'work'), { mode: 0o700 });
      fs.writeFileSync(path.join(base, `${'a'.repeat(64)}.json`), '{invalid', { mode: 0o600 });
      const broken = run(scope); assert.notEqual(broken.status, 0); assert.equal(broken.stdout, '');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
