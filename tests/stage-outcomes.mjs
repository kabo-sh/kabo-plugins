// Real signed-package/native pipeline with synthetic hook events, not native model E2E.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const repository = fileURLToPath(new URL('..',import.meta.url));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function run(file,args,env,input='') { return new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,[file,...args],{env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
 const timer=setTimeout(()=>child.kill('SIGKILL'),15000);child.on('error',reject);child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.stdin.on('error',()=>{});child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});child.stdin.end(input);
}); }
for(const host of ['codex','claude']) test(`${host} V2 machine pause resumes only normal same-turn exact connector proof`,async t=>{
 const plugin=path.join(repository,'plugins',host,'kabo-alpha');
 const nativePrefix = host === 'codex' ? 'mcp__kabo__' : 'mcp__plugin_kabo-alpha_kabo__';
 const otherPrefix = host === 'codex' ? 'mcp__plugin_kabo-alpha_kabo__' : 'mcp__kabo__';
 const {computeChecksum,NATIVE_KABO_MCP_PREFIX}=await import(pathToFileURL(path.join(plugin,'scripts/lib/common.js')));
 assert.equal(NATIVE_KABO_MCP_PREFIX,nativePrefix);
 const {validateExecutionStages}=await import(pathToFileURL(path.join(plugin,'scripts/lib/signed-stages.js')));
 const {bindRunAttempt,readCompletedReport}=await import(pathToFileURL(path.join(plugin,'scripts/lib/host-attempt.js')));
 const {flattenStageRequests}=await import(pathToFileURL(path.join(plugin,'scripts/lib/stage-outcomes.js')));
 const data=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'stage-outcome-fixture-')));t.after(()=>fs.rm(data,{recursive:true,force:true}));
 const server=http.createServer((req,res)=>{assert.equal(req.headers.authorization,undefined);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({revocations:[],catalog:[],server_api_version:'1.0.0'}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
 const endpoint=`http://127.0.0.1:${server.address().port}`,env={PATH:process.env.PATH,KABO_DATA_ROOT:data,KABO_CODEX_DATA:data,KABO_API_ENDPOINT:endpoint};
 const keys=crypto.generateKeyPairSync('ed25519'),kid=sha(keys.publicKey.export({type:'spki',format:'der'})).slice(0,16);
 await fs.writeFile(path.join(data,`public-keys.${sha(endpoint).slice(0,16)}.json`),JSON.stringify({keys:[{kid,public_key_pem:keys.publicKey.export({type:'spki',format:'pem'}).toString()}]}),{mode:0o600});
 const manifest={name:'outcome-fixture',version:'1.0.0',min_plugin_version:'0.21.29',execution:'subagent',required:{tools:[]},execution_stages:{format_version:2,stages:{execute:{cmd:`${JSON.stringify(process.execPath)} {skill}/scripts/stage.js {stage_input} {stage_outcome}`,input:'json',after:[],final:true,report_file:'report/DONE.md'},no_input:{cmd:`${JSON.stringify(process.execPath)} {skill}/scripts/stage.js --none {stage_outcome}`,input:'none',after:[],final:true,report_file:'report/DONE.md'}}}};
 await t.test('honest floor and bounded connector-only requests',()=>{
  assert.throws(()=>validateExecutionStages({...manifest,min_plugin_version:'0.21.28'}),/0.21.29/);
  assert.throws(()=>validateExecutionStages({...manifest,execution_stages:{...manifest.execution_stages,stages:{execute:{...manifest.execution_stages.stages.execute,cmd:'true {stage_input}'}}}}),/stage_outcome/);
  assert.throws(()=>flattenStageRequests([{tool:'exec_command',arguments:{cmd:'true'}}]),/batch/);
  assert.throws(()=>flattenStageRequests([{tool:'data_connector_batch_run',arguments:{requests:Array(5).fill({})}}]),/batch/);
 });
 const script=`import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';const [inputFile,out]=process.argv.slice(2);if(inputFile==='--none'){fs.writeFileSync('report/DONE.md','# No-input signed report\\n');fs.writeFileSync(out,JSON.stringify({format_version:1,status:'completed',input_sha256:null,requests:[]}));process.exit(0);}const bytes=fs.readFileSync(inputFile),input=JSON.parse(bytes),input_sha256=crypto.createHash('sha256').update(bytes).digest('hex');const reservation=JSON.parse(fs.readFileSync('owner/reservation.json'));if(reservation.run!==fs.realpathSync('.')||reservation.attempt_id!==path.basename(fs.realpathSync('.')))process.exit(9);fs.appendFileSync('analysis/calls.txt','x');if(input.mode==='crash')process.exit(7);if(input.mode==='missing')process.exit(0);const receipt='owner/stage-receipts/execute.json';let round=1;if(fs.existsSync(receipt)){const previous=fs.readFileSync(out),r=JSON.parse(fs.readFileSync(receipt));if(r.input_sha256!==input_sha256||r.outcome_sha256!==crypto.createHash('sha256').update(previous).digest('hex'))process.exit(8);round=r.envelopes[0].data.round+1;if(['complete','batch'].includes(input.mode)||(input.mode==='eight'&&round===9)){fs.writeFileSync('report/DONE.md','# Full signed report\\n');fs.writeFileSync(out,JSON.stringify({format_version:1,status:'completed',input_sha256,requests:[]}));process.exit(0);}}fs.writeFileSync(out,JSON.stringify({format_version:1,status:'awaiting_connector',input_sha256,requests:input.mode==='batch'?[{tool:'data_connector_batch_run',arguments:{requests:[{connector_id:'fixture',operation:'read',params:{round:1}},{connector_id:'fixture',operation:'read',params:{round:2}}]}}]:[{tool:'data_connector_run',arguments:{connector_id:'fixture',operation:'read',params:{round}}}]}));`;
 const files=[{path:'manifest.json',content:Buffer.from(JSON.stringify(manifest))},{path:'SKILL.md',content:Buffer.from('Synthetic V2 fixture')},{path:'scripts/stage.js',content:Buffer.from(script)}],checksum=computeChecksum(files,1);
 const pkg={id:manifest.name,version:manifest.version,format_version:1,checksum,key_id:kid,signature:crypto.sign(null,Buffer.from(checksum),keys.privateKey).toString('base64'),files:files.map(f=>({path:f.path,content_base64:f.content.toString('base64')}))};
 const bin=(name,args,input)=>run(path.join(plugin,'bin',name),args,env,input);
 assert.equal((await bin('skill-unpack',['--verify','-'],JSON.stringify(pkg))).code,0);
 const skill=await fs.realpath(path.join(data,'skill-cache',manifest.name,manifest.version)),manifestSha=sha(await fs.readFile(path.join(skill,'manifest.json')));let turn=0;
 async function reserve(mode){const result=await bin('kabo-run-dir',['--skill',skill]);assert.equal(result.code,0,result.stderr);const id=result.stdout.trim(),dir=path.join(data,'work',id),scope={session_id:'normal-fixture',turn_id:`turn-${++turn}`};bindRunAttempt({prepared:{id:manifest.name,verified:true,skill_directory:skill,checksum,manifest_sha256:manifestSha,host_scope:scope},runDir:dir,runId:id,root:data});const folder=path.join(dir,'owner/stage-inputs');await fs.mkdir(folder,{mode:0o700});const input=path.join(folder,'execute.json'),bytes=Buffer.from(JSON.stringify({mode}));await fs.writeFile(input,bytes,{mode:0o600});await fs.writeFile(path.join(folder,'execute.receipt.json'),JSON.stringify({format_version:1,run_id:id,skill,checksum,manifest:manifestSha,stage:'execute',input_file:input,input_sha256:sha(bytes)}),{mode:0o600});return {id,dir,scope};}
 const call=(r,extra=[])=>bin('kabo-run-pipeline',['--run-id',r.id,'--skill',skill,'--stage','execute',...extra]);
 const record=async r=>JSON.parse(await fs.readFile(path.join(r.dir,'run-manifest.json'))),state=async r=>JSON.parse(await fs.readFile(path.join(r.dir,'.pipeline-stages.json')));
 async function hook(r,overrides={}){let outcome;try{outcome=JSON.parse(await fs.readFile(path.join(r.dir,'owner/stage-outcomes/execute.json')));}catch{outcome={requests:[{arguments:{connector_id:'fixture',operation:'read',params:{round:1}}}]};}const request=outcome.requests[0].arguments;const envelope={connector_id:request.connector_id,operation:request.operation,status:'completed',limitations:[],request_id:crypto.randomUUID(),data:{round:request.params.round}};return run(path.join(plugin,'scripts/hooks/persist-envelope.js'),[],env,JSON.stringify({hook_event_name:'PostToolUse',session_id:r.scope.session_id,turn_id:r.scope.turn_id,tool_use_id:crypto.randomUUID(),tool_name:nativePrefix+'data_connector_run',tool_input:request,tool_response:[{type:'text',text:JSON.stringify(envelope)}],...overrides}));}
 await t.test('exit0 pause is not final; missing/foreign/namespace/params proof refuses without rerunning',async()=>{
  const r=await reserve('complete');let result=await call(r);assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/awaiting_connector/);assert.doesNotMatch(result.stdout,/creator_report/);assert.equal((await record(r)).status,'running');
  for(const overrides of [null,{turn_id:undefined},{turn_id:'foreign-turn'},{tool_name:'mcp__other__data_connector_run'},{tool_name:otherPrefix+'data_connector_run'},{tool_response:[{type:'text',text:JSON.stringify({connector_id:'fixture',operation:'read',status:'completed',limitations:[],request:{round:999},data:{round:1}})}]},{tool_input:{connector_id:'fixture',operation:'read',params:{round:999}}}]){const rejected=await reserve('complete');assert.equal((await call(rejected)).code,0);if(overrides)await hook(rejected,overrides);result=await call(rejected);assert.notEqual(result.code,0);assert.match(result.stderr,/receipt_missing|params_mismatch/);assert.equal(await fs.readFile(path.join(rejected.dir,'analysis/calls.txt'),'utf8'),'x');assert.equal((await state(rejected)).execution_stages.execute.status,'awaiting_connector');}
  await hook(r);result=await call(r);assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/creator_report/);assert.equal((await record(r)).status,'ok');assert.equal(readCompletedReport({runDir:r.dir,runId:r.id,hostScope:r.scope,root:data}).text,'# Full signed report\n');assert.notEqual((await call(r)).code,0);
 });
 await t.test('pre-pause exact response, caller snapshot/receipt and changed language/input/outcome cannot resume',async()=>{
  const stale=await reserve('complete');await hook(stale);assert.equal((await call(stale)).code,0);assert.notEqual((await call(stale)).code,0);assert.equal(await fs.readFile(path.join(stale.dir,'analysis/calls.txt'),'utf8'),'x');
  const caller=await reserve('complete');assert.equal((await call(caller)).code,0);await fs.writeFile(path.join(caller.dir,'snapshot/envelope-01.json'),JSON.stringify({connector_id:'fixture',operation:'read',status:'completed',params:{round:1}}),{mode:0o600});await fs.mkdir(path.join(caller.dir,'owner/stage-receipts'),{mode:0o700});await fs.writeFile(path.join(caller.dir,'owner/stage-receipts/execute.json'),JSON.stringify({format_version:1,envelopes:[{}]}),{mode:0o600});assert.notEqual((await call(caller)).code,0);assert.equal(await fs.readFile(path.join(caller.dir,'analysis/calls.txt'),'utf8'),'x');
  for(const changed of ['language','input','outcome']){const r=await reserve('complete');assert.equal((await call(r)).code,0);await hook(r);if(changed==='input')await fs.appendFile(path.join(r.dir,'owner/stage-inputs/execute.json'),' ');if(changed==='outcome')await fs.appendFile(path.join(r.dir,'owner/stage-outcomes/execute.json'),' ');assert.notEqual((await call(r,changed==='language'?['--language','zh']:[])).code,0);assert.equal(await fs.readFile(path.join(r.dir,'analysis/calls.txt'),'utf8'),'x');}
 });
 await t.test('normal layout-specific Kabo batch proof keeps request order and child native scope',async()=>{
  const r=await reserve('batch');assert.equal((await call(r)).code,0);const outcome=JSON.parse(await fs.readFile(path.join(r.dir,'owner/stage-outcomes/execute.json')));assert.equal(outcome.requests[0].tool,'data_connector_batch_run');const args=outcome.requests[0].arguments;
  const results=args.requests.map(request=>({connector_id:request.connector_id,operation:request.operation,status:'completed',limitations:[],request_id:crypto.randomUUID(),data:{round:request.params.round}}));
  const staged=await run(path.join(plugin,'scripts/hooks/persist-envelope.js'),[],env,JSON.stringify({hook_event_name:'PostToolUse',session_id:'parent-native-fixture',agent_id:r.scope.session_id,turn_id:r.scope.turn_id,tool_use_id:crypto.randomUUID(),tool_name:nativePrefix+'data_connector_batch_run',tool_input:args,tool_response:[{type:'text',text:JSON.stringify({results})}]}));assert.equal(staged.code,0,staged.stderr);
  const result=await call(r);assert.equal(result.code,0,result.stderr);const receipt=JSON.parse(await fs.readFile(path.join(r.dir,'owner/stage-receipts/execute.json')));assert.deepEqual(receipt.envelopes.map(e=>e.data.round),[1,2]);assert.deepEqual(receipt.envelopes.map(e=>e.request),args.requests.map(r=>r.params));assert.equal((await record(r)).status,'ok');
 });
 await t.test('none-input V2 uses null digest and completes only its declared final',async()=>{
  const r=await reserve('unused');const result=await bin('kabo-run-pipeline',['--run-id',r.id,'--skill',skill,'--stage','no_input']);assert.equal(result.code,0,result.stderr);assert.equal((await state(r)).execution_stages.no_input.input_sha256,null);assert.equal(readCompletedReport({runDir:r.dir,runId:r.id,hostScope:r.scope,root:data}).text,'# No-input signed report\n');
 });
 await t.test('missing machine result and crash close failed, never rerun',async()=>{
  for(const mode of ['missing','crash']){const r=await reserve(mode);assert.notEqual((await call(r)).code,0);assert.equal((await record(r)).status,'failed');assert.notEqual((await call(r)).code,0);assert.equal(await fs.readFile(path.join(r.dir,'analysis/calls.txt'),'utf8'),'x');}
 });
 await t.test('eight handoffs allow final ninth execution; ninth awaiting becomes failed without requesting fetch',async()=>{
  for(const mode of ['eight','overflow']){const r=await reserve(mode);let result=await call(r);assert.equal(result.code,0,result.stderr);for(let round=1;round<=8;round++){assert.equal((await state(r)).execution_stages.execute.rounds,round);await hook(r);result=await call(r);if(round<8)assert.equal(result.code,0,result.stderr);}
   assert.equal(await fs.readFile(path.join(r.dir,'analysis/calls.txt'),'utf8'),'x'.repeat(9));
   if(mode==='eight'){assert.equal(result.code,0,result.stderr);assert.equal((await record(r)).status,'ok');}
   else{assert.notEqual(result.code,0);assert.match(result.stderr,/ninth batch/);assert.doesNotMatch(result.stdout,/stage-outcome:|creator_report/);assert.equal((await record(r)).status,'failed');assert.notEqual((await call(r)).code,0);}
  }
 });
});
