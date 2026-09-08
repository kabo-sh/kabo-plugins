import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

// 执行真实 SessionStart hook，但所有网络与文件都隔离；这里验证缓存生命周期，
// 不把合成缓存误称为签名包执行或 Main Agent 端到端验收。
for (const host of ['claude', 'codex']) {
  test(`${host}: catalog removal retains caches; only explicit revocation disables a skill`, { timeout: 20_000 }, async (t) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `kabo-retirement-${host}-`));
    t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const old = 'retiring-skill';
    const keep = 'retained-skill';
    const cached = (id) => path.join(scratch, 'skill-cache', id, '1.0.0');
    const marker = (id) => path.join(scratch, 'skill-cache', `${id}.disabled`);
    for (const id of [old, keep]) {
      fs.mkdirSync(cached(id), { recursive: true });
      fs.writeFileSync(path.join(cached(id), '.meta.json'), JSON.stringify({ id, version: '1.0.0' }));
      fs.writeFileSync(path.join(cached(id), 'SKILL.md'), `Synthetic sentinel for ${id}\n`);
    }
    const snapshot = (id) => fs.readdirSync(cached(id)).sort().map((name) => [name, fs.readFileSync(path.join(cached(id), name), 'utf8')]);
    const oldBefore = snapshot(old);
    const keepBefore = snapshot(keep);
    let mode = 'listed';
    const requests = [];
    const server = http.createServer((request, response) => {
      requests.push({ path: request.url, method: request.method, authorization: request.headers.authorization });
      if (request.url !== '/api/sync' || mode === 'offline') {
        response.writeHead(503); response.end(); return;
      }
      const ids = mode === 'listed' ? [old, keep] : mode === 'empty' ? [] : [keep];
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ server_api_version: '1.0.0',
        catalog: ids.map((id) => ({ id, latest_version: id === keep ? '1.1.0' : '1.0.0' })),
        revocations: mode === 'revoked' ? [old] : [],
      }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'plugins', host, 'kabo-alpha/scripts/hooks/session-start.js')], {
        env: { PATH: process.env.PATH, KABO_DATA_ROOT: scratch, KABO_CODEX_DATA: scratch, KABO_API_ENDPOINT: endpoint },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timeout);
        try {
          assert.equal(code, 0, stderr);
          const output = JSON.parse(stdout);
          assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
          resolve(output);
        } catch (error) { reject(error); }
      });
      child.stdin.end('{}');
    });
    for (const next of ['listed', 'removed', 'empty', 'offline']) {
      mode = next;
      const output = await run();
      assert.deepEqual(snapshot(old), oldBefore, `${next}: catalog absence is not revocation`);
      assert.deepEqual(snapshot(keep), keepBefore);
      assert.equal(fs.existsSync(marker(old)), false);
      assert.equal(fs.existsSync(marker(keep)), false);
      assert.match(output.systemMessage, /built-in static version/);
      assert.equal(output.hookSpecificOutput.additionalContext, undefined);
      if (next === 'listed' || next === 'removed') assert.match(output.systemMessage, /1 skill\(s\) updatable/);
      if (next === 'offline') assert.match(output.systemMessage, /cannot reach the platform/);
    }
    mode = 'revoked';
    await run();
    assert.equal(fs.existsSync(cached(old)), false);
    assert.equal(fs.existsSync(marker(old)), true);
    assert.deepEqual(snapshot(keep), keepBefore);
    mode = 'offline';
    await run();
    assert.equal(fs.existsSync(marker(old)), true, 'offline sync must not clear a revocation');
    mode = 'removed';
    await run();
    assert.equal(fs.existsSync(marker(old)), false, 'explicit withdrawal clears the marker, not the absent cache');
    assert.equal(fs.existsSync(cached(old)), false);
    assert.deepEqual(snapshot(keep), keepBefore);
    assert.ok(requests.some((request) => request.path === '/api/sync'));
    assert.ok(requests.every((request) => request.method === 'GET' && request.authorization === undefined));
  });
}
