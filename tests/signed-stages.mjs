import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import test from 'node:test';
const root=fileURLToPath(new URL('..',import.meta.url));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function run(file,args,env,input='') { return new Promise((resolve,reject)=>{
 const p=spawn(process.execPath,[file,...args],{env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
 const timer=setTimeout(()=>p.kill('SIGKILL'),15000);p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.once('error',reject);p.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr})});p.stdin.on('error',()=>{});p.stdin.end(input);
}); }
for(const host of ['codex','claude']) test(`${host}: real signed stages bind JSON and prevent bypass/replay`,async t=>{
 const plugin=path.join(root,'plugins',host,'kabo-alpha');const common=await import(pathToFileURL(path.join(plugin,'scripts/lib/common.js')));
 const {validateExecutionStages}=await import(pathToFileURL(path.join(plugin,'scripts/lib/signed-stages.js')));
 const data=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'signed-stage-')));t.after(()=>fs.rm(data,{recursive:true,force:true}));
 const server=http.createServer((req,res)=>{assert.equal(req.headers.authorization,undefined);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({revocations:[],catalog:[],server_api_version:'1.0.0'}))});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r))});
 const endpoint=`http://127.0.0.1:${server.address().port}`;const env={PATH:process.env.PATH,KABO_DATA_ROOT:data,KABO_CODEX_DATA:data,KABO_API_ENDPOINT:endpoint};
 const pair=crypto.generateKeyPairSync('ed25519'),kid=hash(pair.publicKey.export({type:'spki',format:'der'})).slice(0,16);
 await fs.writeFile(path.join(data,`public-keys.${hash(endpoint).slice(0,16)}.json`),JSON.stringify({keys:[{kid,public_key_pem:pair.publicKey.export({type:'spki',format:'pem'}).toString()}]}),{mode:0o600});
 const id='signed-stage-fixture',version='1.0.0';const node=JSON.stringify(process.execPath);
 const manifest={name:id,version,execution:'subagent',required:{tools:[]},min_plugin_version:'0.21.28',execution_stages:{format_version:1,stages:{
  prepare:{cmd:`${node} {skill}/scripts/stage.js prepare {stage_input}`,input:'json',after:[],final:false},
  finish:{cmd:`${node} {skill}/scripts/stage.js finish`,input:'none',after:['prepare'],final:true,report_file:'done.md'},
  fail:{cmd:`${node} {skill}/scripts/stage.js fail`,input:'none',after:[],final:false}
 }}};
 await t.test('signed stage capability floor rejects old, malformed and prerelease minima',()=>{
  for(const minimum of [undefined,'0.21.27','garbage','0.21.28-alpha','0.21.28-01','00.21.28']) assert.throws(()=>validateExecutionStages({...manifest,min_plugin_version:minimum}),/min_plugin_version/);
  assert.doesNotThrow(()=>validateExecutionStages(manifest));
 });
 const script=`import fs from 'node:fs';const stage=process.argv[2];if(stage==='prepare'){fs.writeFileSync('analysis/received.json',fs.readFileSync(process.argv[3]));}else if(stage==='finish'){JSON.parse(fs.readFileSync('analysis/received.json'));fs.writeFileSync('done.md','# Validated fixture\\n');}else process.exit(7);`;
 const files=[{path:'manifest.json',content:Buffer.from(JSON.stringify(manifest))},{path:'SKILL.md',content:Buffer.from('Synthetic signed stage fixture.')},{path:'scripts/stage.js',content:Buffer.from(script)}];
 const checksum=common.computeChecksum(files,1);const pkg={id,version,format_version:1,checksum,key_id:kid,signature:crypto.sign(null,Buffer.from(checksum),pair.privateKey).toString('base64'),files:files.map(f=>({path:f.path,content_base64:f.content.toString('base64')}))};
 const bin=(name,args,input)=>run(path.join(plugin,'bin',name),args,env,input);assert.equal((await bin('skill-unpack',['--verify','-'],JSON.stringify(pkg))).code,0);
 const skill=await fs.realpath(path.join(data,'skill-cache',id,version)),rawManifest=await fs.readFile(path.join(skill,'manifest.json'));
 const reserve=async()=>{const r=await bin('kabo-run-dir',['--skill',skill]);assert.equal(r.code,0,r.stderr);return r.stdout.trim()};
 const work=r=>path.join(data,'work',r),call=(r,args)=>bin('kabo-run-pipeline',['--run-id',r,'--skill',skill,...args]);
 const receipt=async(r,stage,body={literal:"引号' $() `not code`"})=>{const folder=path.join(work(r),'owner','stage-inputs');await fs.mkdir(folder,{recursive:true,mode:0o700});const input=path.join(folder,`${stage}.json`),out=path.join(folder,`${stage}.receipt.json`);const bytes=Buffer.from(JSON.stringify(body));await fs.writeFile(input,bytes,{flag:'wx',mode:0o600});await fs.writeFile(out,JSON.stringify({format_version:1,run_id:r,skill,checksum,manifest:hash(rawManifest),stage,input_file:input,input_sha256:hash(bytes)}),{flag:'wx',mode:0o600});return out;};
 const r=await reserve();
 await t.test('rejects caller commands, reports, continuation, missing stage/input and out-of-order final',async()=>{
  for(const flags of [['--step','touch BYPASS'],['--stage','prepare','--continue'],['--stage','finish','--report','done.md'],['--stage','prepare'],[],['--stage','finish']]){const result=await call(r,flags);assert.notEqual(result.code,0,result.stdout);}
  await assert.rejects(fs.stat(path.join(work(r),'BYPASS')));
 });
 const bound=await receipt(r,'prepare');
 await t.test('rejects receipt substitution, changed digest, and signed-cache modification',async()=>{
  const other=await reserve(),foreign=await receipt(other,'prepare');assert.notEqual((await call(r,['--stage','prepare','--input-receipt',foreign])).code,0);
  const file=path.join(work(r),'owner/stage-inputs/prepare.json'),bytes=await fs.readFile(file);await fs.writeFile(file,'{}');assert.notEqual((await call(r,['--stage','prepare','--input-receipt',bound])).code,0);await fs.writeFile(file,bytes);
  const cacheFile=path.join(skill,'SKILL.md'),original=await fs.readFile(cacheFile);await fs.writeFile(cacheFile,'tampered');const tamperRun=await reserve();const tamperReceipt=await receipt(tamperRun,'prepare');assert.notEqual((await call(tamperRun,['--stage','prepare','--input-receipt',tamperReceipt])).code,0);await assert.rejects(fs.stat(path.join(work(tamperRun),'analysis/received.json')));await fs.writeFile(cacheFile,original);
 });
 await t.test('preserves native JSON, keeps intermediate running, executes each stage once, and finalizes signed report',async()=>{
  let result=await call(r,['--stage','prepare']);assert.equal(result.code,0,result.stderr);assert.deepEqual(JSON.parse(await fs.readFile(path.join(work(r),'analysis/received.json'))),{literal:"引号' $() `not code`"});
  assert.equal(JSON.parse(await fs.readFile(path.join(work(r),'run-manifest.json'))).status,'running');assert.notEqual((await call(r,['--stage','prepare','--input-receipt',bound])).code,0);
  assert.notEqual((await call(r,['--stage','finish','--input-receipt',bound])).code,0);
  result=await call(r,['--stage','finish']);assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/creator_report: .* → done.md/);assert.equal(JSON.parse(await fs.readFile(path.join(work(r),'run-manifest.json'))).status,'ok');assert.notEqual((await call(r,['--stage','finish'])).code,0);
 });
 await t.test('failure closes the run and rejects later stages and explicit bypass',async()=>{
  const linked=await reserve(),outside=path.join(data,'outside-state.json');await fs.writeFile(outside,'{"sentinel":true}',{mode:0o600});await fs.symlink(outside,path.join(work(linked),'.pipeline-stages.json'));assert.notEqual((await call(linked,['--stage','fail'])).code,0);assert.equal(await fs.readFile(outside,'utf8'),'{"sentinel":true}');
  const failed=await reserve();let result=await call(failed,['--stage','fail']);assert.notEqual(result.code,0);assert.equal(JSON.parse(await fs.readFile(path.join(work(failed),'run-manifest.json'))).status,'failed');assert.notEqual((await call(failed,['--stage','finish'])).code,0);assert.notEqual((await call(failed,['--step','touch BYPASS'])).code,0);
 });
});
