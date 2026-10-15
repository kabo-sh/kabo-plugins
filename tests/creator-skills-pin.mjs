// Shipped copies of creator-skills content (account scripts, runner tool surface, contract fixtures)
// must match the pinned creator-skills commit in both host variants. Offline: reads only this repo.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('creator-skills pin: snapshot, both shipped variants and runner tools agree', () => {
  const run = spawnSync(process.execPath, [path.join(root, 'scripts/creator-skills-snapshot.mjs'), '--verify'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
});
