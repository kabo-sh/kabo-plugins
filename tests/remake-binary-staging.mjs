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
    for(const mutate of mutations){
      const payload=fixture();mutate(payload);
      // Both visible representations must carry the deliberately invalid test manifest.
      if(payload.structuredContent) payload.structuredContent=JSON.parse(payload.content[0].text);
      const r=await hook(payload);assert.equal(r.code,0);
    }
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
  test(`${host}: complete structured manifest survives a truncated display`,async t=>{
    const {staging,hook}=await setup(t);const payload=fixture();
    payload.content=[{type:'text',text:'Display omitted; use the complete structured result.'}];
    const result=await hook(payload);assert.equal(result.code,0);
    const files=await fs.readdir(staging);const part=files.find(f=>f.endsWith('.art'));
    assert.ok(part);assert.deepEqual(await fs.readFile(path.join(staging,part)),body);
  });
  test(`${host}: metadata alone cannot create evidence`,async t=>{
    const {staging,hook}=await setup(t);const payload=fixture();payload.content=[{type:'text',text:'No artifact manifest.'}];delete payload.structuredContent;
    const r=await hook(payload);assert.equal(r.code,0);await assert.rejects(fs.stat(staging),{code:'ENOENT'});
  });
  test(`${host}: cloud delivery files and raw video retain distinct bounded types`,async t=>{
    const {staging,hook}=await setup(t);
    for (const [kind,mime,index,size] of [['source_video','video/mp4',13,policy.source_video_bytes],
      ['voice_sample','audio/wav',0,body.length],['first_frame','image/png',0,body.length],
      ['speech_audio','audio/wav',0,body.length],['word_timings','application/json',0,body.length],
      ['generated_video','video/mp4',0,body.length],
      ['final_video','video/mp4',255,200*1024*1024],
      ['editable_pack','application/zip',255,200*1024*1024],
      ['image','image/png',255,policy.file_bytes],
      ['image','image/jpeg',255,policy.file_bytes],
      ['report','text/plain',255,policy.file_bytes]]) {
      // This is a single-chunk manifest check, not whole-video validation.
      const payload=fixture();const visible=payload.structuredContent;
      Object.assign(visible.file,{kind,content_type:mime,index,bytes:size});
      visible.artifacts[0].object_ref=`remake/${index}/0`;
      payload._meta[policy.host_meta_key].artifacts[0].object_ref=`remake/${index}/0`;
      payload.content[0].text=JSON.stringify(visible);
      const result=await hook(payload);assert.equal(result.code,0,result.stderr);
    }
    assert.equal((await fs.readdir(staging)).filter(f=>f.endsWith('.art')).length,11);
  });
  test(`${host}: raw-video bounds do not widen legacy types, indexes or task pairing`,async t=>{
    const {staging,hook}=await setup(t);
    const invalid=[
      ['source_video','video/mp4',13,policy.source_video_bytes+1],
      ['image','image/png',0,policy.file_bytes+1],
      ['report','text/plain',0,policy.file_bytes+1],
      ['image','text/plain',0,body.length],
      ['report','image/png',0,body.length],
      ['report','application/json',0,body.length],
      ['final_video','video/mp4',0,200*1024*1024+1],
      ['editable_pack','application/zip',0,200*1024*1024+1],
      ['final_video','application/zip',0,body.length],
      ['editable_pack','video/mp4',0,body.length],
      ['final_video','video/mp4',256,body.length],
      ['editable_pack','application/zip',256,body.length],
      ['source_video','audio/wav',13,body.length],['source_video','video/mp4',14,body.length],
      ['generated_video','video/mp4',0,policy.file_bytes+1],
      ['voice_sample','audio/wav',0,policy.file_bytes+1],['first_frame','image/png',0,policy.file_bytes+1],
      ['speech_audio','audio/wav',0,policy.file_bytes+1],['word_timings','application/json',0,policy.file_bytes+1],
      ['voice_sample','video/mp4',0,body.length],['first_frame','audio/wav',0,body.length],
      ['unknown_video','video/mp4',0,body.length],
    ];
    for(const [kind,mime,index,size] of invalid){
      const payload=fixture();const visible=payload.structuredContent;
      Object.assign(visible.file,{kind,content_type:mime,index,bytes:size});
      visible.artifacts[0].object_ref=`remake/${index}/0`;
      payload._meta[policy.host_meta_key].artifacts[0].object_ref=`remake/${index}/0`;
      payload.content[0].text=JSON.stringify(visible);
      const r=await hook(payload);assert.equal(r.code,0,r.stderr);
    }
    const crossed=fixture();crossed.structuredContent.file.kind='source_video';
    crossed.structuredContent.file.content_type='video/mp4';
    crossed.content[0].text=JSON.stringify(crossed.structuredContent);
    crossed._meta[policy.host_meta_key].job_id='00000000-0000-4000-8000-000000000002';
    assert.equal((await hook(crossed)).code,0);
    assert.equal((await fs.readdir(staging)).some(f=>f.endsWith('.art')),false);
  });
  test(`${host}: ambiguous unions and unknown branch keywords remain fail closed`,async t=>{
    const {data,env,staging}=await setup(t);
    for(const mutation of ['ambiguous','unknown']) {
      const isolated=path.join(data,mutation);
      for(const relative of ['package.json','scripts/hooks/persist-envelope.js','scripts/lib/common.js',
        'scripts/lib/remake-artifact-contract.js','scripts/contracts/remake-artifact-v1.json','scripts/contracts/remake-artifact-v1.sha256']) {
        const target=path.join(isolated,relative);await fs.mkdir(path.dirname(target),{recursive:true});
        await fs.copyFile(path.join(plugin,relative),target);
      }
      const changed=structuredClone(contract);
      const variants=changed.output_schema.properties.file.oneOf;
      const sample=variants.find(branch=>branch.properties.kind.const===vector.structuredContent.file.kind ||
        branch.properties.kind.enum?.includes(vector.structuredContent.file.kind));
      assert.ok(sample,'The provider sample must have a matching file variant.');
      if(mutation==='ambiguous') variants.push(structuredClone(sample));
      else sample.not={};
      const bytes=Buffer.from(JSON.stringify(changed));
      await fs.writeFile(path.join(isolated,'scripts/contracts/remake-artifact-v1.json'),bytes);
      await fs.writeFile(path.join(isolated,'scripts/contracts/remake-artifact-v1.sha256'),sha(bytes)+'\n');
      const result=await run(path.join(isolated,'scripts/hooks/persist-envelope.js'),[],env,
        JSON.stringify({session_id:'protocol-test',tool_name:'mcp__kabo__creator_remake_artifact',
          hook_event_name:'PostToolUse',tool_use_id:'probe1',tool_response:fixture()}));
      assert.equal(result.code,0,result.stderr);
    }
    assert.equal((await fs.readdir(staging)).some(f=>f.endsWith('.art')),false);
  });
}

test('提供方钉制品和两端随包副本可离线核验，不查询远程发布状态', async()=>{
  const checked=await run(path.join(root,'scripts/remake-contract-snapshot.mjs'),['--verify'],{PATH:process.env.PATH},'');
  assert.equal(checked.code,0,checked.stderr);
  assert.match(checked.stdout,/offline/);
  const sources=await Promise.all(['codex','claude'].map(host=>fs.readFile(path.join(root,'plugins',host,'kabo-alpha/scripts/lib/remake-artifact-contract.js'),'utf8')));
  assert.equal(sources[0],sources[1]);
});
