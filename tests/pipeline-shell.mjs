import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

for (const host of ['claude', 'codex']) {
 const {resolvePipelineShell} = await import(`../plugins/${host}/kabo-alpha/scripts/lib/common.js`);
 test(`${host}: POSIX pipeline shell preserves command args; Windows only accepts bundled regular file`, t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pipeline-shell-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bin=path.join(root,'bin'),shell=path.join(root,'shell','busybox.exe');
  assert.deepEqual(resolvePipelineShell(bin,'darwin'),{executable:'/bin/sh',args:['-c']});
  assert.deepEqual(resolvePipelineShell(bin,'linux'),{executable:'/bin/sh',args:['-c']});
  assert.throws(()=>resolvePipelineShell(bin,'win32'),/shell is missing/);
  fs.mkdirSync(path.dirname(shell));fs.mkdirSync(shell);
  assert.throws(()=>resolvePipelineShell(bin,'win32'),/not a regular file/);
  fs.rmdirSync(shell);fs.writeFileSync(shell,'fixture, not executed');
  assert.deepEqual(resolvePipelineShell(bin,'win32'),{executable:shell,args:['sh','-c']});
  fs.renameSync(shell,shell+'.target');fs.symlinkSync(shell+'.target',shell);
  assert.throws(()=>resolvePipelineShell(bin,'win32'),/not a regular file/);
 });
}
