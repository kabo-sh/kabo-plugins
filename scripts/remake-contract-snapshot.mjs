#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const snapshot=path.join(root,'contracts-snapshot/kabo');
const repository='kabo-sh/kabo';
const names=['remake-artifact-v1.json','remake-artifact-v1.sha256'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const shipped=host=>path.join(root,'plugins',host,'kabo-alpha/scripts/contracts');
const args=process.argv.slice(2);
function verify() {
  const pin=JSON.parse(fs.readFileSync(path.join(snapshot,'pin.json'),'utf8'));
  assert.equal(pin.repository,repository);
  assert.match(pin.commit,/^[a-f0-9]{40}$/);
  for (const name of names) {
    const bytes=fs.readFileSync(path.join(snapshot,name));
    assert.equal(pin.files[name].path,`docs/contracts/${name}`);
    assert.equal(sha(bytes),pin.files[name].sha256);
    for (const host of ['codex','claude']) assert.deepEqual(fs.readFileSync(path.join(shipped(host),name)),bytes);
  }
  assert.equal(fs.readFileSync(path.join(snapshot,names[1]),'utf8').trim(),sha(fs.readFileSync(path.join(snapshot,names[0]))));
  console.log('Verified pinned remake contract and both shipped copies offline.');
}
if (args.length===1 && args[0]==='--verify') verify();
else if (args.length===3 && args[0]==='--refresh' && args[1]==='--commit' && /^[a-f0-9]{40}$/.test(args[2])) {
  // 只有显式刷新访问提供方；普通构建不读取其他仓源码、Actions 或部署状态。
  const commit=args[2]; const files={}; const fetched={};
  for(const name of names) {
    const source=`docs/contracts/${name}`;
    const response=spawnSync('gh',['api',`repos/${repository}/contents/${source}?ref=${commit}`,'--jq','.content'],{encoding:'utf8',maxBuffer:2*1024*1024});
    if(response.error || response.status!==0) throw new Error('Could not fetch the fixed provider artifact.');
    const bytes=Buffer.from(response.stdout.replace(/\s/g,''),'base64');
    if(!bytes.length || bytes.length>1024*1024) throw new Error('Provider artifact size is invalid.');
    fetched[name]=bytes; files[name]={path:source,sha256:sha(bytes)};
  }
  assert.equal(fetched[names[1]].toString().trim(),sha(fetched[names[0]]));
  assert.equal(JSON.parse(fetched[names[0]]).schema_version,'kabo.remake-artifact-contract.v1');
  fs.mkdirSync(snapshot,{recursive:true});
  for(const name of names) {
    fs.writeFileSync(path.join(snapshot,name),fetched[name]);
    for(const host of ['codex','claude']) {fs.mkdirSync(shipped(host),{recursive:true});fs.writeFileSync(path.join(shipped(host),name),fetched[name]);}
  }
  fs.writeFileSync(path.join(snapshot,'pin.json'),JSON.stringify({repository,commit,files},null,2)+'\n');
  verify();
} else {
  console.error('Usage: node scripts/remake-contract-snapshot.mjs --verify | --refresh --commit <40-char provider commit>');
  process.exitCode=1;
}
