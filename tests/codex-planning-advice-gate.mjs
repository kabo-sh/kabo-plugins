import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Instruction-contract checks, not a model-routing E2E: the Codex delivery rule is injected at session
// start, before any skill flow, so it must not read as permission to answer without the catalog search.
const root = fileURLToPath(new URL('..', import.meta.url));
const read = file => fs.readFile(`${root}/plugins/codex/kabo-alpha/skills/${file}/SKILL.md`, 'utf8');

test('Codex general planning advice only follows the catalog search and confirm step', async () => {
  const delivery = (await read('meta-guidance')).split('\n')
    .find(line => line.startsWith('- **Validated report passthrough**:'));
  assert.ok(delivery, 'the session-start hook injects this line by its prefix');
  assert.doesNotMatch(delivery, /needs no account evidence but must be labeled advice/);
  // This line shares the session-start context cap with the signed guidance, so it stays terse;
  // analyze step 4 carries the full wording.
  assert.match(delivery, /Labeled planning advice only follows this turn's catalog search \(confirming any match\), fictional creators included\./);

  const step = (await read('analyze')).split('\n').find(line => line.startsWith('4. '));
  assert.ok(step, 'analyze keeps its no-match step');
  const search = step.indexOf("runs step 1's catalog search before anything is answered, then meta-guidance's confirm step when the search matches a skill");
  const advice = step.indexOf('general planning advice');
  assert.ok(search >= 0 && advice > search, 'the search and confirm step come before any planning advice');
  assert.match(step, /fictional or hypothetical creators/);
  assert.match(step, /\*\*Validated report passthrough\*\* line in meta-guidance/, 'the delivery rule is named, not left dangling');
});
