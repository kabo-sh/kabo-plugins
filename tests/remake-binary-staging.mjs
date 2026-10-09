import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = body => createHash('sha256').update(body).digest('hex');
const artifactPath=path.join(root,'contracts-snapshot/kabo/remake-artifact-v1.json');
const contract=JSON.parse(await fs.readFile(artifactPath,'utf8'));
const policy=contract['x-kabo-policy'];
const vector=contract.public_vector.result;
const body=Buffer.from(vector._meta[policy.host_meta_key].artifacts[0].body_base64,'base64');
function fixture() { return structuredClone(vector); }
const run = (file, args, env, input) => new Promise((resolve,reject) => {
  const proc = spawn(process.execPath, [file, ...args], { env, stdio: ['pipe','pipe','pipe'] });
  let stdout='',stderr='';
  proc.stdout.on('data', data => { stdout+=data; }); proc.stderr.on('data', data => { stderr+=data; });
  proc.on('error',reject); proc.on('close',code => resolve({ code, stdout, stderr }));
  proc.stdin.end(input);
});
for (const host of ['codex','claude']) {
  const plugin = path.join(root,'plugins',host,'kabo-alpha');
  const setup = async t => {
    const data = await fs.mkdtemp(path.join(os.tmpdir(),`remake-${host}-`));
    t.after(()=>fs.rm(data,{recursive:true,force:true}));
    const env={PATH:process.env.PATH,KABO_DATA_ROOT:data,KABO_CODEX_DATA:data};
    const staging=path.join(data,'envelope-staging','protocol-test');
    const hook = response => run(path.join(plugin,'scripts/hooks/persist-envelope.js'), [], env,
      JSON.stringify({ session_id:'protocol-test',tool_name:'mcp__kabo__creator_remake_artifact',
        hook_event_name:'PostToolUse',tool_use_id:'probe1',tool_response:response }));
    return {data,env,staging,hook};
  };
  for(const serialized of [false,true]) test(`${host}: host-only binary ${serialized?'serialized':'structured'} survives staging and drain`, async t=>{
    const {data,env,staging,hook}=await setup(t); const payload=fixture();
    const result=await hook(serialized?JSON.stringify(payload):payload);
    assert.equal(result.code,0,result.stderr); assert.equal(result.stderr,'');
    assert.ok(!result.stdout.includes(payload._meta['kabo/artifact-bodies.v1'].artifacts[0].body_base64));
    const files=await fs.readdir(staging); const part=files.find(f=>f.endsWith('.art'));
    assert.ok(part); assert.deepEqual(await fs.readFile(path.join(staging,part)),body);
    const stat=await fs.stat(path.join(staging,part)); assert.equal(stat.mode&0o777,0o600);
    const snapshot=path.join(data,'snapshot');
    const drained=await run(path.join(plugin,'bin/kabo-save-envelope'),['--from',staging,'--into',snapshot],env,'');
    assert.equal(drained.code,0,drained.stderr);
    assert.deepEqual(await fs.readFile(path.join(snapshot,'remakechunk-0001.bin')),body);
    const visible=JSON.parse(await fs.readFile(path.join(snapshot,'envelope-01.json'),'utf8'));
    assert.equal(visible.schema_version,'remake.artifact-chunks.v1');
    assert.equal('_meta' in visible,false,'宿主正文不进入证据信封');
  });
  test(`${host}: missing, mismatched, damaged or oversized metadata never stages a binary`,async t=>{
    const {staging,hook}=await setup(t);
    const mutations=[
      p=>delete p._meta,
      p=>{p._meta['kabo/artifact-bodies.v1'].job_id='00000000-0000-4000-8000-000000000002';},
      p=>{p._meta['kabo/artifact-bodies.v1'].artifacts[0].object_ref='wrong';},
      p=>{p._meta['kabo/artifact-bodies.v1'].artifacts[0].body_base64='!!!';},
      p=>{p._meta['kabo/artifact-bodies.v1'].artifacts[0].body_base64=Buffer.from('damaged').toString('base64');},
      p=>{const visible=JSON.parse(p.content[0].text);visible.artifacts[0].bytes=policy.chunk_bytes+1;p.content[0].text=JSON.stringify(visible);},
      p=>{p._meta['kabo/artifact-bodies.v1'].artifacts.push(p._meta['kabo/artifact-bodies.v1'].artifacts[0]);},
      p=>{const visible=JSON.parse(p.content[0].text);visible.artifacts[0].object_ref='../outside';p.content[0].text=JSON.stringify(visible);p._meta['kabo/artifact-bodies.v1'].artifacts[0].object_ref='../outside';},
    ];
    for(const mutate of mutations){const payload=fixture();mutate(payload);const r=await hook(payload);assert.equal(r.code,0);}
    assert.equal((await fs.readdir(staging)).some(f=>f.endsWith('.art')),false);
  });
  test(`${host}: corrupted pin refuses binary while existing envelope persistence still works`,async t=>{
    const {data,env,staging}=await setup(t);
    const isolated=path.join(data,'isolated-plugin');
    for(const relative of ['package.json','scripts/hooks/persist-envelope.js','scripts/lib/common.js',
      'scripts/lib/remake-artifact-contract.js','scripts/contracts/remake-artifact-v1.json','scripts/contracts/remake-artifact-v1.sha256']) {
      const target=path.join(isolated,relative);await fs.mkdir(path.dirname(target),{recursive:true});
      await fs.copyFile(path.join(plugin,relative),target);
    }
    await fs.appendFile(path.join(isolated,'scripts/contracts/remake-artifact-v1.json'),' ');
    const hook=response=>run(path.join(isolated,'scripts/hooks/persist-envelope.js'),[],env,
      JSON.stringify({session_id:'protocol-test',tool_name:'mcp__kabo__creator_remake_artifact',
        hook_event_name:'PostToolUse',tool_use_id:'probe1',tool_response:response}));
    const binary=await hook(fixture());assert.equal(binary.code,0);assert.equal(binary.stderr,'');
    assert.equal((await fs.readdir(staging)).some(f=>f.endsWith('.art')),false);
    const old={status:'completed',connector_id:'existing',operation:'read',limitations:[]};
    const saved=await hook({content:[{type:'text',text:JSON.stringify(old)}]});
    assert.equal(saved.code,0);assert.equal(saved.stderr,'');
    const jsons=(await fs.readdir(staging)).filter(f=>f.endsWith('.json'));
    const values=await Promise.all(jsons.map(f=>fs.readFile(path.join(staging,f),'utf8')));
    assert.ok(values.includes(JSON.stringify(old)));
  });
  test(`${host}: metadata alone cannot create evidence`,async t=>{
    const {staging,hook}=await setup(t);const payload=fixture();payload.content=[{type:'text',text:'No artifact manifest.'}];
    const r=await hook(payload);assert.equal(r.code,0);await assert.rejects(fs.stat(staging),{code:'ENOENT'});
  });
}

test('提供方钉制品和两端随包副本可离线核验，不查询远程发布状态', async()=>{
  const checked=await run(path.join(root,'scripts/remake-contract-snapshot.mjs'),['--verify'],{PATH:process.env.PATH},'');
  assert.equal(checked.code,0,checked.stderr);
  assert.match(checked.stdout,/offline/);
  const sources=await Promise.all(['codex','claude'].map(host=>fs.readFile(path.join(root,'plugins',host,'kabo-alpha/scripts/lib/remake-artifact-contract.js'),'utf8')));
  assert.equal(sources[0],sources[1]);
});
