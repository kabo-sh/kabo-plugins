import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = new URL('../', import.meta.url);
for (const host of ['claude', 'codex']) {
  test(`${host} public sync carries installed version without authentication`, async t => {
    const { fetchJsonSilent, PLUGIN_VERSION } = await import(`../plugins/${host}/kabo-alpha/scripts/lib/common.js`);
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push({ url: req.url, version: req.headers['x-kabo-plugin-version'],
        authenticationPresent: req.headers.authorization !== undefined, other: req.headers['x-fixture'] });
      res.setHeader('content-type', 'application/json');
      res.end('{"catalog":[],"revocations":[]}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const result = await fetchJsonSilent(`http://127.0.0.1:${server.address().port}/api/sync`, {
      headers: new Headers({ 'X-Kabo-Plugin-Version': '0.0.0', 'X-Fixture': 'preserved' }),
    });
    assert.deepEqual(result, { catalog: [], revocations: [] });
    assert.deepEqual(requests, [{ url: '/api/sync', version: PLUGIN_VERSION,
      authenticationPresent: false, other: 'preserved' }]);
  });
}

test('Codex native MCP config is generated from runtime version and rejects drift', async t => {
  const { PLUGIN_VERSION } = await import('../plugins/codex/kabo-alpha/scripts/lib/common.js');
  const config = JSON.parse(await fs.readFile(new URL('plugins/codex/kabo-alpha/.mcp.json', root), 'utf8'));
  assert.deepEqual(config.mcpServers.kabo, { url: 'https://kabo.sh/mcp', auth: 'oauth',
    http_headers: { 'X-Kabo-Plugin-Version': PLUGIN_VERSION } });
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'kabo-version-config-'));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const files = ['scripts/plugin-version.mjs', '.claude-plugin/marketplace.json',
    'plugins/claude/kabo-alpha/.claude-plugin/plugin.json', 'plugins/codex/kabo-alpha/.codex-plugin/plugin.json',
    ...['claude', 'codex'].flatMap(host => [`plugins/${host}/kabo-alpha/package.json`,
      `plugins/${host}/kabo-alpha/scripts/lib/common.js`]), 'plugins/codex/kabo-alpha/.mcp.json'];
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(scratch, file)), { recursive: true });
    await fs.copyFile(new URL(file, root), path.join(scratch, file));
  }
  const file = path.join(scratch, 'plugins/codex/kabo-alpha/.mcp.json');
  config.mcpServers.kabo.http_headers['X-Kabo-Plugin-Version'] = '0.0.0';
  await fs.writeFile(file, JSON.stringify(config));
  const run = args => spawnSync(process.execPath, ['scripts/plugin-version.mjs', ...args], { cwd: scratch, encoding: 'utf8' });
  const drift = run([]);
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /runtime hint differs/);
  const generated = run(['--write-mcp-config']);
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(run([]).status, 0);
  assert.equal(JSON.parse(await fs.readFile(file)).mcpServers.kabo.http_headers['X-Kabo-Plugin-Version'], PLUGIN_VERSION);
});
