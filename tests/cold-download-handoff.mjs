// Execute the documented cross-cell handoff with fresh JS globals per cell.
// No real credentials, hook settings, network, installer or signed-cache mutation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const guidance = await fs.readFile(new URL('../plugins/codex/kabo-alpha/skills/meta-guidance/SKILL.md', import.meta.url), 'utf8');
const section = guidance.split('### Retaining a cold download across hook and fallback cells\n')[1]?.split('- **Authorization**')[0];
assert.ok(section, 'cold download needs an explicit cross-cell handoff');
const snippets = [...section.matchAll(/```javascript\n([\s\S]*?)\n```/g)].map(match => match[1]);
assert.equal(snippets.length, 2, 'download-only and installer-only examples');
const [downloadCell, installerCell] = snippets;
const selectedId = 'large-unicode-fixture', selectedVersion = '1.0.0';
const downloadKey = `kabo.skill-download:${selectedId}@${selectedVersion}`;
const run = (source, bindings) => vm.runInNewContext(`(async () => {\n${source}\n})()`, bindings);

function fixture(result) {
  const storage = new Map(), output = [];
  let downloads = 0;
  const bindings = {
    selectedId, selectedVersion, downloadKey,
    store: (key, value) => storage.set(key, structuredClone(value)),
    load: key => structuredClone(storage.get(key)),
    text: value => output.push(structuredClone(value)),
    tools: { mcp__kabo__registry_skill_download: async input => {
      downloads += 1;
      assert.deepEqual(JSON.parse(JSON.stringify(input)), {id: selectedId, version: selectedVersion});
      return result;
    } },
  };
  return { storage, output, bindings, downloads: () => downloads };
}

test('complete package survives a fresh cell despite a truncated display and one download', async () => {
  const pkg = {id: selectedId, version: selectedVersion, description: '字幕 🦋', files: [
    {path: 'large.txt', content_base64: Buffer.from('字幕 🦋 '.repeat(180_000)).toString('base64')},
  ]};
  const f = fixture({structuredContent: pkg});
  await run(downloadCell, {...f.bindings});
  assert.equal(f.downloads(), 1);
  assert.deepEqual(f.output, [{id: selectedId, version: selectedVersion, retained_for_installation: true}]);
  assert.ok(JSON.stringify(f.output).length < 150);
  // Each cell receives different globals. Only documented store/load transfers bytes.
  let recovered;
  await run(`${installerCell}\ncapture(downloadedPackage);`, {...f.bindings, capture: value => {recovered = structuredClone(value);}});
  assert.deepEqual(recovered, pkg);
  assert.equal(f.downloads(), 1);
  // The bridge's ASCII exact-byte-count transform preserves the complete package.
  const payload = JSON.stringify(recovered).replace(/[\u0080-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  assert.equal(payload.length, Buffer.byteLength(payload));
  assert.deepEqual(JSON.parse(payload), pkg);
  f.bindings.store(downloadKey, null);
  assert.equal(f.storage.get(downloadKey), null);
});

test('missing, errored, empty or wrong-identity downloads never retain a usable package', async () => {
  for (const result of [
    {}, {isError: true, structuredContent: {id: selectedId, version: selectedVersion, files: [{}]}},
    {structuredContent: {id: 'wrong', version: selectedVersion, files: [{}]}},
    {structuredContent: {id: selectedId, version: '2.0.0', files: [{}]}},
    {structuredContent: {id: selectedId, version: selectedVersion, files: []}},
  ]) {
    const f = fixture(result);
    await assert.rejects(run(downloadCell, {...f.bindings}), /selected complete structured package/);
    assert.equal(f.downloads(), 1);
    assert.equal(f.storage.size, 0);
    assert.deepEqual(f.output, []);
  }
});

test('lost or mismatched retained state stops before claiming an installer attempt', async () => {
  const f = fixture({});
  for (const value of [null, {id: 'wrong', version: selectedVersion, files: [{}]}, {id: selectedId, version: selectedVersion, files: []}]) {
    f.bindings.store(downloadKey, value);
    await assert.rejects(run(installerCell, {...f.bindings}), /unavailable; no installer has been attempted/);
  }
  assert.equal(f.downloads(), 0);
  assert.deepEqual(f.output, []);
});
