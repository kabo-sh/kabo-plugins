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
 const {bindRunAttempt,readCompletedReport}=await import(pathToFileURL(path.join(plugin,'scripts/lib/host-attempt.js')));
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
  nested_report:{cmd:`${node} {skill}/scripts/stage.js finish report/RULE_CHECK.md`,input:'none',after:['prepare'],final:true,report_file:'report/RULE_CHECK.md'},
  nested_other:{cmd:`${node} {skill}/scripts/stage.js finish results/deep/FINAL.md`,input:'none',after:['prepare'],final:true,report_file:'results/deep/FINAL.md'},
  fail:{cmd:`${node} {skill}/scripts/stage.js fail`,input:'none',after:[],final:false}
 }}};
 await t.test('signed stage capability floor rejects old, malformed and prerelease minima',()=>{
  for(const minimum of [undefined,'0.21.27','garbage','0.21.28-alpha','0.21.28-01','00.21.28']) assert.throws(()=>validateExecutionStages({...manifest,min_plugin_version:minimum}),/min_plugin_version/);
  assert.doesNotThrow(()=>validateExecutionStages(manifest));
 });
 await t.test('report_file accepts only bounded safe run-relative segments',()=>{
  const candidate=report_file=>({...manifest,execution_stages:{format_version:1,stages:{final:{cmd:'true',input:'none',after:[],final:true,report_file}}}});
  for(const value of ['','/tmp/report.md','../report.md','report/../x','report/./x','report//x','report/','report\\x','.hidden', 'a'.repeat(65),'a/'.repeat(256)+'z']) assert.throws(()=>validateExecutionStages(candidate(value)),/report_file/);
  for(const value of ['done.md','report/RULE_CHECK.md','results/deep/FINAL.md','a'.repeat(64),Array(8).fill('a'.repeat(63)).join('/')+'x']) assert.doesNotThrow(()=>validateExecutionStages(candidate(value)));
 });
 const script=`import path from 'node:path';import fs from 'node:fs';const stage=process.argv[2];if(stage==='prepare'){fs.writeFileSync('analysis/received.json',fs.readFileSync(process.argv[3]));}else if(stage==='finish'){JSON.parse(fs.readFileSync('analysis/received.json'));const target=process.argv[3]||'done.md';fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});fs.writeFileSync(target,'# Validated fixture\\n');}else process.exit(7);`;
 const files=[{path:'manifest.json',content:Buffer.from(JSON.stringify(manifest))},{path:'SKILL.md',content:Buffer.from('Synthetic signed stage fixture.')},{path:'scripts/stage.js',content:Buffer.from(script)}];
 const checksum=common.computeChecksum(files,1);const pkg={id,version,format_version:1,checksum,key_id:kid,signature:crypto.sign(null,Buffer.from(checksum),pair.privateKey).toString('base64'),files:files.map(f=>({path:f.path,content_base64:f.content.toString('base64')}))};
 const bin=(name,args,input)=>run(path.join(plugin,'bin',name),args,env,input);assert.equal((await bin('skill-unpack',['--verify','-'],JSON.stringify(pkg))).code,0);
 const skill=await fs.realpath(path.join(data,'skill-cache',id,version)),rawManifest=await fs.readFile(path.join(skill,'manifest.json'));
 let fixtureTurn = 0;
 const reserve=async(scope)=>{const r=await bin('kabo-run-dir',['--skill',skill]);assert.equal(r.code,0,r.stderr);const runId=r.stdout.trim();bindRunAttempt({prepared:{id,verified:true,skill_directory:skill,checksum,manifest_sha256:hash(rawManifest),host_scope:scope??{session_id:'mechanism-fixture',turn_id:`independent-case-${++fixtureTurn}`}},runDir:path.join(data,'work',runId),runId,root:data});return runId;};
 const work=r=>path.join(data,'work',r),call=(r,args)=>bin('kabo-run-pipeline',['--run-id',r,'--skill',skill,...args]);
 const receipt=async(r,stage,body={literal:"引号' $() `not code`"})=>{const folder=path.join(work(r),'owner','stage-inputs');await fs.mkdir(folder,{recursive:true,mode:0o700});const input=path.join(folder,`${stage}.json`),out=path.join(folder,`${stage}.receipt.json`);const bytes=Buffer.from(JSON.stringify(body));await fs.writeFile(input,bytes,{flag:'wx',mode:0o600});await fs.writeFile(out,JSON.stringify({format_version:1,run_id:r,skill,checksum,manifest:hash(rawManifest),stage,input_file:input,input_sha256:hash(bytes)}),{flag:'wx',mode:0o600});return out;};
 const {checkReportDelivery}=await import(pathToFileURL(path.join(plugin,'scripts/hooks/report-delivery.js')));
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
 await t.test('final artifact handoff preserves full body and rejects stale, failed, changed or foreign reports',async()=>{
  const scope=JSON.parse(await fs.readFile(path.join(work(r),'.pipeline-attempt.json'))).host_scope;
  const read=()=>readCompletedReport({runDir:work(r),runId:r,hostScope:scope,root:data});
  const original=await fs.readFile(path.join(work(r),'done.md'));
  assert.equal(read().text,original.toString('utf8'));assert.equal(read().sha256,hash(original));
  const revoked=path.join(data,'skill-cache',id+'.disabled');await fs.writeFile(revoked,'revoked');assert.throws(read,/revoked/);await fs.unlink(revoked);
  const reportFile=path.join(work(r),'done.md'),saved=path.join(work(r),'saved.md');await fs.rename(reportFile,saved);await fs.symlink(saved,reportFile);assert.throws(read,/not_regular/);await fs.unlink(reportFile);await fs.link(saved,reportFile);assert.throws(read,/hardlinked/);await fs.unlink(reportFile);await fs.rename(saved,reportFile);
  assert.throws(()=>readCompletedReport({runDir:work(r),runId:r,hostScope:{...scope,turn_id:'foreign-turn'},root:data}),/scope/);
  const stateFile=path.join(work(r),'.pipeline-stages.json'),state=await fs.readFile(stateFile);
  for(const status of ['running','failed']){const value=JSON.parse(state);value.status=status;await fs.writeFile(stateFile,JSON.stringify(value));assert.throws(read,/not_completed/);}
  const value=JSON.parse(state);delete value.execution_stages.finish;await fs.writeFile(stateFile,JSON.stringify(value));assert.throws(read,/final_stage/);await fs.writeFile(stateFile,state);
  await fs.writeFile(path.join(work(r),'done.md'),'truncated');assert.throws(read,/digest/);
  await fs.writeFile(path.join(work(r),'done.md'),original);
  const recordFile=path.join(work(r),'run-manifest.json'),record=await fs.readFile(recordFile);
  const long=Buffer.from('\ufeff# Full report\n'+'完整交付与证据。\n'.repeat(3000));
  const modified=JSON.parse(record);modified.artifacts.find(a=>a.path_or_uri==='done.md').sha256=hash(long);
  await fs.writeFile(path.join(work(r),'done.md'),long);await fs.writeFile(recordFile,JSON.stringify(modified));
  assert.equal(read().text,long.toString('utf8'));assert.equal(read().bytes,long.length);assert.ok(long.length>32000);
  const invalid=Buffer.from([0xff,0xfe]);modified.artifacts.find(a=>a.path_or_uri==='done.md').sha256=hash(invalid);
  await fs.writeFile(path.join(work(r),'done.md'),invalid);await fs.writeFile(recordFile,JSON.stringify(modified));assert.throws(read,/encoded data|encoding/);
  await fs.writeFile(path.join(work(r),'done.md'),Buffer.alloc(256*1024+1,65));assert.throws(read,/too_large/);
  await fs.writeFile(path.join(work(r),'done.md'),original);await fs.writeFile(recordFile,record);
  const {handleRpc}=await import(pathToFileURL(path.join(plugin,'scripts/runtime-server.js')));
  const rpc=argumentsValue=>handleRpc({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read_report',arguments:argumentsValue,_meta:{threadId:scope.session_id,'x-codex-turn-metadata':{turn_id:scope.turn_id}}}},{dataRoot:data,workRoot:path.join(data,'work')});
  assert.equal((await rpc({run_id:r})).result.structuredContent.text,original.toString('utf8'));
  assert.equal((await rpc({run_id:r,path:'/etc/passwd'})).result.isError,true);
  const event={hook_event_name:'Stop',...scope,last_assistant_message:'Done.',stop_hook_active:false};
  assert.equal(checkReportDelivery(event,{root:data,workRoot:path.join(data,'work')}).decision,'block');
  assert.deepEqual(checkReportDelivery({...event,last_assistant_message:original.toString('utf8')},{root:data,workRoot:path.join(data,'work')}),{});
  assert.deepEqual(checkReportDelivery({...event,turn_id:'unrelated-clarification'},{root:data,workRoot:path.join(data,'work')}),{});
  const second=checkReportDelivery({...event,stop_hook_active:true},{root:data,workRoot:path.join(data,'work')});
  assert.equal(second.continue,false);assert.match(second.stopReason,/incomplete/);
  const failedRecord=JSON.parse(record);failedRecord.status='failed';await fs.writeFile(recordFile,JSON.stringify(failedRecord));
  assert.deepEqual(checkReportDelivery(event,{root:data,workRoot:path.join(data,'work')}),{});await fs.writeFile(recordFile,record);

 });
 await t.test('nested signed final reports preserve exact artifact identity and reject linked/non-private parents',async()=>{
  for(const [stage,relative] of [['nested_report','report/RULE_CHECK.md'],['nested_other','results/deep/FINAL.md']]) {
   const nested=await reserve();await receipt(nested,'prepare');assert.equal((await call(nested,['--stage','prepare'])).code,0);
   const result=await call(nested,['--stage',stage]);assert.equal(result.code,0,result.stderr);assert.ok(result.stdout.includes(`→ ${relative}`));
   const record=JSON.parse(await fs.readFile(path.join(work(nested),'run-manifest.json')));
   const artifacts=record.artifacts.filter(a=>a.path_or_uri===relative);assert.equal(artifacts.length,1);assert.equal(artifacts[0].kind,'report');
   const scope=JSON.parse(await fs.readFile(path.join(work(nested),'.pipeline-attempt.json'))).host_scope;
   const read=()=>readCompletedReport({runDir:work(nested),runId:nested,hostScope:scope,root:data});assert.equal(read().sha256,artifacts[0].sha256);assert.equal(read().text,'# Validated fixture\n');
   const parent=path.dirname(path.join(work(nested),relative)),saved=parent+'-saved';await fs.rename(parent,saved);await fs.symlink(saved,parent);assert.throws(read,/symlinked/);await fs.unlink(parent);await fs.rename(saved,parent);
   await fs.chmod(parent,0o755);assert.throws(read,/private/);await fs.chmod(parent,0o700);assert.equal(read().text,'# Validated fixture\n');
  }
 });
 await t.test('failure closes the run and rejects later stages and explicit bypass',async()=>{
  const linked=await reserve(),outside=path.join(data,'outside-state.json');await fs.writeFile(outside,'{"sentinel":true}',{mode:0o600});await fs.symlink(outside,path.join(work(linked),'.pipeline-stages.json'));assert.notEqual((await call(linked,['--stage','fail'])).code,0);assert.equal(await fs.readFile(outside,'utf8'),'{"sentinel":true}');
  const failed=await reserve();let result=await call(failed,['--stage','fail']);assert.notEqual(result.code,0);assert.equal(JSON.parse(await fs.readFile(path.join(work(failed),'run-manifest.json'))).status,'failed');assert.notEqual((await call(failed,['--stage','finish'])).code,0);assert.notEqual((await call(failed,['--step','touch BYPASS'])).code,0);
 });
 await t.test('a failed signed stage cannot be reset by a new reservation in the same native turn',async()=>{
  const scope={session_id:'mechanism-fixture',turn_id:'replacement-case'}, failed=await reserve(scope);
  assert.notEqual((await call(failed,['--stage','fail'])).code,0);
  await assert.rejects(reserve(scope),/host_attempt_already_reserved/);
  const candidate=(await bin('kabo-run-dir',['--skill',skill])).stdout.trim();
  const rejected=await call(candidate,['--stage','fail']);
  assert.notEqual(rejected.code,0);assert.match(rejected.stderr,/pipeline-attempt|ENOENT/);
  const later=await reserve({...scope,turn_id:'next-user-turn'});
  await receipt(later,'prepare');assert.equal((await call(later,['--stage','prepare'])).code,0);
 });

});
