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
const body = Buffer.from([0x52,0x49,0x46,0x46,0x00,0xff,0x80,0x01]);
const job = '00000000-0000-4000-8000-000000000001';
function fixture() {
  const artifact = { object_ref: 'remake/output1/part0', kind: 'remakechunk', bytes: body.length,
    sha256: sha(body), content_type: 'application/octet-stream' };
  const visible = { schema_version: 'remake.artifact-chunks.v1', job_id: job, artifacts: [artifact] };
  return { content: [{ type: 'text', text: JSON.stringify(visible) }], structuredContent: visible,
    _meta: { 'kabo/artifact-bodies.v1': { schema_version: visible.schema_version, job_id: job,
      artifacts: [{ object_ref: artifact.object_ref, sha256: artifact.sha256, body_base64: body.toString('base64') }] } } };
}
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
      p=>{const visible=JSON.parse(p.content[0].text);visible.artifacts[0].bytes=4*1024*1024+1;p.content[0].text=JSON.stringify(visible);},
      p=>{p._meta['kabo/artifact-bodies.v1'].artifacts.push(p._meta['kabo/artifact-bodies.v1'].artifacts[0]);},
      p=>{const visible=JSON.parse(p.content[0].text);visible.artifacts[0].object_ref='../outside';p.content[0].text=JSON.stringify(visible);p._meta['kabo/artifact-bodies.v1'].artifacts[0].object_ref='../outside';},
    ];
    for(const mutate of mutations){const payload=fixture();mutate(payload);const r=await hook(payload);assert.equal(r.code,0);}
    assert.equal((await fs.readdir(staging)).some(f=>f.endsWith('.art')),false);
  });
  test(`${host}: metadata alone cannot create evidence`,async t=>{
    const {staging,hook}=await setup(t);const payload=fixture();payload.content=[{type:'text',text:'No artifact manifest.'}];
    const r=await hook(payload);assert.equal(r.code,0);await assert.rejects(fs.stat(staging),{code:'ENOENT'});
  });
}
