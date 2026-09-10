import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const bytes=fs.readFileSync(new URL('./fixtures/plugin-artifact-v1.golden.json',import.meta.url));
const golden=JSON.parse(bytes);
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
test('the public artifact fixture stays pinned across producer and consumers',()=>{
  assert.equal(sha(bytes),'370a54b2df3b53e4de77abaca74598f15dab68508e1fb3a5f943b38e3bb61d78');
});
for(const host of ['claude','codex']) {
  test(`${host}: original, Unicode and optional pipeline vectors retain signed canonical bytes`,async()=>{
    const common=await import(new URL(`../plugins/${host}/kabo-alpha/scripts/lib/common.js`,import.meta.url));
    for(const block of [golden,golden.sort_conformance,golden.pipeline_conformance]) {
      const pkg=block.skill_package;
      const files=pkg.files.map(f=>({path:f.path,content:Buffer.from(f.content_base64,'base64')}));
      assert.equal(common.computeChecksum(files,pkg.format_version),pkg.checksum);
      assert.equal(crypto.verify(null,Buffer.from(pkg.checksum),golden.test_key.public_key_pem,Buffer.from(pkg.signature,'base64')),true);
      assert.deepEqual(JSON.parse(files.find(f=>f.path==='manifest.json').content),pkg.manifest);
    }
    assert.equal(golden.pipeline_conformance.skill_package.manifest.execution,'subagent');
  });
}
