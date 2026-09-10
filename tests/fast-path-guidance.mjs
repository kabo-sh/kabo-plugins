import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
for (const host of ['claude', 'codex']) {
  test(`${host}: versioned guidance preserves legacy cache and signed rollback protection`, async t => {
    const plugin = path.join(root, 'plugins', host, 'kabo-alpha');
    const common = await import(pathToFileURL(path.join(plugin, 'scripts/lib/common.js')));
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'kabo-guidance-cohort-'));
    t.after(() => fs.rm(scratch, {recursive:true, force:true}));
    const source = await fs.readFile(path.join(plugin,'skills/meta-guidance/SKILL.md'),'utf8');
    const body = source.slice(source.indexOf('# Kabo skill routing (meta-guidance)'));
    assert.ok(body.length <= common.MAX_GUIDANCE_CONTENT_CHARS);
    const pair = crypto.generateKeyPairSync('ed25519');
    const kid = common.sha256hex(pair.publicKey.export({type:'spki',format:'der'})).slice(0,16);
    let current, offline = false;
    const requests = [];
    const server = http.createServer((req,res) => {
      requests.push(req.url);
      assert.equal(req.headers.authorization,undefined);
      res.setHeader('Content-Type','application/json');
      if (offline) {res.writeHead(503);res.end('{}');return;}
      if (req.url === '/api/sync') res.end(JSON.stringify({catalog:[],revocations:[],server_api_version:'1.0.0'}));
      else if (req.url === `/api/meta-guidance?plugin=${common.PLUGIN_VERSION}`) res.end(JSON.stringify(current));
      else {res.writeHead(404);res.end('{}');}
    });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    t.after(() => {server.closeAllConnections();return new Promise(resolve => server.close(resolve));});
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const bucket = common.sha256hex(endpoint).slice(0,16);
    const legacyCache = path.join(scratch,`meta-guidance.${bucket}.json`);
    const cohortCache = path.join(scratch,`meta-guidance.fast-path.${bucket}.json`);
    const signed = (version,content) => {
      const value = {format_version:1,type:'kabo.meta-guidance',guidance_version:version,
        issued_at:new Date(Date.now()-60000).toISOString(),expires_at:new Date(Date.now()+86400000).toISOString(),resource:`${endpoint}/mcp`,content};
      const checksum = common.computeChecksum([
        {path:'kabo.meta-guidance/header.txt',content:Buffer.from(common.buildGuidanceHeader(value))},
        {path:'kabo.meta-guidance/content.md',content:Buffer.from(content)},
      ],1);
      return {...value,checksum,signature:crypto.sign(null,Buffer.from(checksum),pair.privateKey).toString('base64'),algorithm:'ed25519',key_id:kid};
    };
    const legacy = JSON.stringify(signed(18,'# Original legacy cache\n'));
    await fs.writeFile(legacyCache,legacy,{mode:0o600});
    await fs.writeFile(path.join(scratch,`public-keys.${bucket}.json`),JSON.stringify({issued_at:null,keys:[{kid,public_key_pem:pair.publicKey.export({type:'spki',format:'pem'}).toString()}]}),{mode:0o600});
    const hook = () => new Promise((resolve,reject) => {
      const child = spawn(process.execPath,[path.join(plugin,'scripts/hooks/session-start.js')],{
        env:{PATH:process.env.PATH,KABO_DATA_ROOT:scratch,KABO_CODEX_DATA:scratch,KABO_API_ENDPOINT:endpoint},stdio:['pipe','pipe','pipe'],
      });
      let stdout='',stderr='';
      const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
      child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
      child.once('error',reject);
      child.once('close',code=>{clearTimeout(timer);try {assert.equal(code,0,stderr);resolve(JSON.parse(stdout));}catch(error){reject(error);}});
      child.stdin.end('{}');
    });
    const assertBody = (result,expected) => {
      const context=result.hookSpecificOutput?.additionalContext ?? '';
      assert.ok(context.length <= common.MAX_ADDITIONAL_CONTEXT_CHARS);
      const begin=context.indexOf(common.GUIDANCE_BEGIN)+common.GUIDANCE_BEGIN.length+1;
      const end=context.indexOf(common.GUIDANCE_END)-1;
      assert.equal(context.slice(begin,end),expected);
    };
    current=signed(19,body);
    assertBody(await hook(),body);
    assert.equal(await fs.readFile(legacyCache,'utf8'),legacy);
    assert.equal(JSON.parse(await fs.readFile(cohortCache,'utf8')).guidance_version,19);
    assert.equal((await fs.stat(cohortCache)).mode & 0o777,0o600);
    const conventions=await fs.readFile(path.join(scratch,'execution-conventions.md'),'utf8');
    assert.equal(conventions.trim(),common.extractGuidanceSection(body,'C'));
    offline=true;
    assertBody(await hook(),body);
    offline=false;current=signed(18,'# Older signed response\n');
    assertBody(await hook(),body);
    current={...signed(19,body),content:'# Tampered response\n'};
    assertBody(await hook(),body);
    assert.equal(await fs.readFile(legacyCache,'utf8'),legacy);
    assert.equal(requests.filter(url=>url.startsWith('/api/meta-guidance')).length,4);
    assert.ok(requests.every(url=>url !== '/api/meta-guidance'));
  });
}
