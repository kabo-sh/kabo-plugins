import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Instruction-contract checks, not a model-routing or installation-state E2E test.
const root = fileURLToPath(new URL('..', import.meta.url));
const marker = '# Kabo skill routing (meta-guidance)';
const heading = '## Plugin cache-hit dispatch conventions';
const read = host => fs.readFile(`${root}/plugins/${host}/kabo-alpha/skills/meta-guidance/SKILL.md`, 'utf8');

test('both CLI clients read verified cache dispatch fields without changing signed guidance', async () => {
  const files = await Promise.all(['claude', 'codex'].map(read));
  const sections = files.map(source => {
    const start = source.indexOf(heading);
    const shared = source.indexOf(marker);
    assert.ok(start >= 0 && shared > start, 'local cache mechanics precede the shared signed snapshot');
    const section = source.slice(start, shared).trim();
    assert.match(section, /After `skill-verify <dir>` exits successfully on a cache hit, read that verified directory's `manifest\.json` once before dispatch/);
    assert.match(section, /Verification output alone is not a manifest digest/);
    for (const field of ['execution', 'pipeline', 'pipeline_operations', 'required.tools', 'min_plugin_version']) {
      assert.ok(section.includes(`\`${field}\``), `read the signed ${field} routing input`);
    }
    assert.match(section, /empty override disables the pipeline/);
    assert.match(section, /selected non-empty signed array runs in the main agent/);
    assert.match(section, /`subagent` goes to skill-runner, and `inline` follows the installed inline conventions/);
    assert.match(section, /If verification failed or the manifest cannot be read, stop without dispatch/);
    assert.match(section, /Do not redownload, unpack again, or perform a second verification/);
    assert.match(section, /cold download keeps its existing unpack-and-verify digest flow/);
    return {section, snapshot: source.slice(shared)};
  });
  assert.equal(sections[0].section, sections[1].section, 'cache dispatch semantics agree across CLI clients');
  assert.equal(sections[0].snapshot, sections[1].snapshot, 'signed shared body remains byte-identical across clients');
});
