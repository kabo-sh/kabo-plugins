// Deferred skill assets (plugin 0.22.0): a package may leave assets/ files out of the download,
// list them in deferred_files, and have them fetched one at a time with registry_skill_asset.
// The signature still covers every file. Both plugin trees, isolated temp data roots, no network.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const golden = JSON.parse(await fs.readFile(path.join(root, 'tests/fixtures/plugin-artifact-v1.golden.json'), 'utf8'));
const vectorBytes = await fs.readFile(path.join(root, 'tests/fixtures/deferred-assets-v1.json'));
const vector = JSON.parse(vectorBytes);
const PKG = vector.skill_package;
const [ASSET_A, ASSET_B] = vector.asset_responses;
// Unreachable on purpose: verification must never need the network here (the revocation snapshot
// below is fresh, and the keyset is pinned).
const ENDPOINT = 'http://127.0.0.1:9';

function run(file, args, env, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(file.endsWith('.sh') ? 'sh' : process.execPath, [file, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.once('error', reject);
    child.once('close', (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

const exists = (p) => fs.access(p).then(() => true, () => false);
const clone = (v) => JSON.parse(JSON.stringify(v));
/** The full (non-deferred) form of the vector package: every file shipped, same checksum and signature. */
function fullPackage() {
  const pkg = clone(PKG);
  for (const asset of vector.asset_responses) {
    pkg.files.push({ path: asset.path, content_base64: Buffer.from(asset.content, 'utf8').toString('base64') });
  }
  delete pkg.deferred_files;
  return pkg;
}

async function fixture(t, host) {
  const plugin = path.join(root, 'plugins', host, 'kabo-alpha');
  const common = await import(pathToFileURL(path.join(plugin, 'scripts/lib/common.js')));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), `kabo deferred ${host} `));
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: data, KABO_DATA_ROOT: data, KABO_CODEX_DATA: data, KABO_API_ENDPOINT: ENDPOINT };
  const pem = golden.test_key.public_key_pem;
  const kid = common.sha256hex(crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' })).slice(0, 16);
  await fs.writeFile(path.join(data, `public-keys.${common.sha256hex(ENDPOINT).slice(0, 16)}.json`),
    JSON.stringify({ issued_at: null, keys: [{ kid, public_key_pem: pem }] }), { mode: 0o600 });
  await fs.writeFile(path.join(data, 'revocation-sync.json'),
    JSON.stringify({ synced_at: new Date().toISOString(), revocations: [], server_api_version: '1.0.0' }), { mode: 0o600 });
  const bin = (name, args, input) => run(path.join(plugin, 'bin', name), args, env, input);
  const skill = path.join(data, 'skill-cache', PKG.id, PKG.version);
  const unpack = async (pkg = PKG) => {
    const result = await bin('skill-unpack', ['--verify', '-'], JSON.stringify(pkg));
    assert.equal(result.code, 0, result.stderr);
    return result;
  };
  const verify = (...extra) => bin('skill-verify', [...extra, skill]);
  const install = (response) => bin('skill-asset-install', ['--response', '-'], typeof response === 'string' ? response : JSON.stringify(response));
  const hook = (event) => bin('skill-asset-install', ['--hook'], typeof event === 'string' ? event : JSON.stringify(event));
  return { plugin, common, data, env, bin, skill, unpack, verify, install, hook };
}

const failType = (result) => (result.stderr.match(/KABO_VERIFY_FAIL error_type=(\S+)/) || [])[1];

test('deferred-assets vector: signed over every file, pinned, and well-formed', async () => {
  assert.equal(crypto.createHash('sha256').update(vectorBytes).digest('hex'), '483ffa0cca62cb734c32463667c6b6b2ac722dc553be3cb55c10a1767189bb74');
  assert.equal(PKG.key_id, golden.test_key.key_id);
  // Ed25519 is deterministic: the golden test key reproduces the pinned signature byte for byte.
  assert.equal(crypto.sign(null, Buffer.from(PKG.checksum), golden.test_key.private_key_pem).toString('base64'), PKG.signature);
  assert.equal(crypto.verify(null, Buffer.from(PKG.checksum), golden.test_key.public_key_pem, Buffer.from(PKG.signature, 'base64')), true);
  for (const host of ['claude', 'codex']) {
    const common = await import(pathToFileURL(path.join(root, 'plugins', host, 'kabo-alpha/scripts/lib/common.js')));
    const shipped = PKG.files.map((f) => ({ path: f.path, content: Buffer.from(f.content_base64, 'base64') }));
    const full = fullPackage().files.map((f) => ({ path: f.path, content: Buffer.from(f.content_base64, 'base64') }));
    // The checksum is over files ∪ deferred, whether the deferred digests come from bytes or declarations.
    assert.equal(common.computeChecksum(full, 1), PKG.checksum);
    assert.equal(common.canonicalManifest(full, 1).toString('utf8'), vector.canonical_manifest_utf8);
    const merged = common.withDeferredFiles(shipped, PKG.deferred_files);
    assert.equal(merged.ok, true);
    assert.equal(merged.absent, 2);
    assert.equal(common.computeChecksum(merged.files, 1), PKG.checksum);
    assert.equal(common.deferredFilesProblem(PKG.deferred_files), null);
    for (const asset of vector.asset_responses) {
      const declared = PKG.deferred_files.find((d) => d.path === asset.path);
      const bytes = Buffer.from(asset.content, 'utf8');
      assert.equal(common.sha256hex(bytes), declared.sha256);
      assert.equal(bytes.length, declared.size);
      assert.equal(asset.sha256, declared.sha256);
    }
    const manifest = JSON.parse(shipped.find((f) => f.path === 'manifest.json').content);
    assert.deepEqual(manifest.deferred_files, { include: ['assets/knowledge/'], exclude: ['assets/knowledge/craft-index.md'] });
  }
});

for (const host of ['claude', 'codex']) {
  test(`${host}: a full package unpacks and verifies exactly as before`, async (t) => {
    const f = await fixture(t, host);
    const result = await f.unpack(fullPackage());
    assert.match(result.stdout, /\(5 file\(s\) \+ \.meta\.json\)\n/);
    assert.match(result.stdout, /Verification passed: deferred-skill@1\.0\.0 \(checksum and ed25519 signature are both valid; revocation list fresh \d+s ago\)\n/);
    const meta = JSON.parse(await fs.readFile(path.join(f.skill, '.meta.json'), 'utf8'));
    assert.equal('deferred_files' in meta, false);
    const local = await f.verify('--local-only');
    assert.equal(local.code, 0, local.stderr);
    assert.doesNotMatch(local.stdout, /not fetched yet/);
  });

  test(`${host}: a deferred package unpacks, verifies with assets absent, and keeps verifying as assets arrive`, async (t) => {
    const f = await fixture(t, host);
    const result = await f.unpack();
    assert.match(result.stdout, /\(3 file\(s\) \+ \.meta\.json; 2 deferred asset\(s\) fetched on demand\)/);
    assert.match(result.stdout, /Verification passed: deferred-skill@1\.0\.0 .*; 2 deferred asset\(s\) not fetched yet/);
    const meta = JSON.parse(await fs.readFile(path.join(f.skill, '.meta.json'), 'utf8'));
    assert.deepEqual(meta.deferred_files, PKG.deferred_files);
    assert.equal(await exists(path.join(f.skill, ASSET_A.path)), false);
    assert.ok(await exists(path.join(f.skill, 'assets/knowledge/craft-index.md')));

    const first = await f.install(ASSET_A);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stdout, `kabo: asset installed deferred-skill@1.0.0 ${ASSET_A.path}\n`);
    const written = path.join(f.skill, ASSET_A.path);
    assert.equal(await fs.readFile(written, 'utf8'), ASSET_A.content);
    assert.equal((await fs.stat(written)).mode & 0o777, 0o600);
    let local = await f.verify('--local-only');
    assert.equal(local.code, 0, local.stderr);
    assert.match(local.stdout, /; 1 deferred asset\(s\) not fetched yet/);

    const second = await f.install(ASSET_B);
    assert.equal(second.code, 0, second.stderr);
    assert.equal((await f.install(ASSET_B)).code, 0, 'installing the same asset again is idempotent');
    local = await f.verify('--local-only');
    assert.equal(local.code, 0, local.stderr);
    assert.doesNotMatch(local.stdout, /not fetched yet/);
    assert.equal((await f.verify()).code, 0);
    // No temporary file survives an install.
    const leftovers = (await fs.readdir(path.dirname(written))).filter((n) => n.startsWith('.'));
    assert.deepEqual(leftovers, []);
  });

  test(`${host}: kabo-run-pipeline runs on a partially fetched package`, async (t) => {
    const f = await fixture(t, host);
    await f.unpack();
    assert.equal((await f.install(ASSET_A)).code, 0);
    const reserved = await f.bin('kabo-run-dir', ['--skill', f.skill]);
    assert.equal(reserved.code, 0, reserved.stderr);
    const runId = reserved.stdout.trim();
    const pipeline = await f.bin('kabo-run-pipeline', ['--run-id', runId, '--skill', f.skill, '--report', 'REPORT.md',
      '--step', 'printf ok > {report}/REPORT.md']);
    assert.equal(pipeline.code, 0, pipeline.stderr);
    assert.match(pipeline.stdout, /creator_report:/);
  });

  test(`${host}: a tampered asset, a tampered declaration and an unlisted file all fail verification`, async (t) => {
    const f = await fixture(t, host);
    await f.unpack();
    assert.equal((await f.install(ASSET_A)).code, 0);
    const written = path.join(f.skill, ASSET_A.path);

    await fs.writeFile(written, `${ASSET_A.content}tampered`);
    let result = await f.verify('--local-only');
    assert.equal(result.code, 1);
    assert.equal(failType(result), 'deferred_mismatch');
    await fs.writeFile(written, ASSET_A.content);
    assert.equal((await f.verify('--local-only')).code, 0);

    // A forged digest for a file that is not on disk changes the rebuilt manifest.
    const metaPath = path.join(f.skill, '.meta.json');
    const original = await fs.readFile(metaPath, 'utf8');
    const forged = JSON.parse(original);
    forged.deferred_files[1].sha256 = 'f'.repeat(64);
    await fs.writeFile(metaPath, JSON.stringify(forged));
    result = await f.verify('--local-only');
    assert.equal(result.code, 1);
    assert.equal(failType(result), 'checksum_mismatch');
    // Dropping an absent entry from the declaration fails the same way.
    forged.deferred_files = forged.deferred_files.slice(0, 1);
    await fs.writeFile(metaPath, JSON.stringify(forged));
    assert.equal(failType(await f.verify('--local-only')), 'checksum_mismatch');
    // A malformed declaration is refused outright.
    await fs.writeFile(metaPath, JSON.stringify({ ...JSON.parse(original), deferred_files: [{ path: '../x', sha256: 'f'.repeat(64), size: 1 }] }));
    assert.equal(failType(await f.verify('--local-only')), 'meta_invalid');
    await fs.writeFile(metaPath, original);
    assert.equal((await f.verify('--local-only')).code, 0);

    await fs.writeFile(path.join(f.skill, 'assets/knowledge/extra.md'), 'not in the package');
    result = await f.verify('--local-only');
    assert.equal(result.code, 1);
    assert.equal(failType(result), 'checksum_mismatch');
  });

  test(`${host}: skill-unpack refuses malformed deferred_files lists before touching the cache`, async (t) => {
    const f = await fixture(t, host);
    const asset = PKG.deferred_files[0];
    const cases = {
      'shipped and deferred': [{ ...asset, path: 'assets/knowledge/craft-index.md' }, PKG.deferred_files[1]],
      'outside assets/': [{ ...asset, path: 'references/notes.md' }],
      traversal: [{ ...asset, path: 'assets/../SKILL.md' }],
      absolute: [{ ...asset, path: '/assets/x.md' }],
      'dot segment': [{ ...asset, path: 'assets/.hidden.md' }],
      'uppercase sha256': [{ ...asset, sha256: asset.sha256.toUpperCase() }],
      'bad size': [{ ...asset, size: -1 }],
      unsorted: [PKG.deferred_files[1], PKG.deferred_files[0]],
      repeated: [asset, asset],
      'not an array': { [asset.path]: asset },
    };
    for (const [name, deferred] of Object.entries(cases)) {
      const result = await f.bin('skill-unpack', ['--verify', '-'], JSON.stringify({ ...PKG, deferred_files: deferred }));
      assert.equal(result.code, 1, name);
      assert.match(result.stderr, /defer/, name);
      assert.equal(await exists(f.skill), false, name);
    }
  });

  test(`${host}: skill-asset-install rejects each failure with its code and leaves nothing behind`, async (t) => {
    const f = await fixture(t, host);
    const rejected = async (response, code) => {
      const result = await f.install(response);
      assert.equal(result.code, 1, `${code}: ${result.stdout}`);
      assert.equal(result.stdout, `kabo: asset rejected ${code}\n`);
      return result;
    };
    await rejected(ASSET_A, 'not_cached');
    await f.unpack(fullPackage());
    await rejected(ASSET_A, 'not_cached'); // cached, but nothing was deferred
    await f.unpack();

    await rejected('not json', 'bad_response');
    await rejected({ error: { code: 'version_superseded' } }, 'bad_response');
    await rejected({ ...ASSET_A, sha256: undefined }, 'bad_response');
    await rejected({ ...ASSET_A, id: '../escape' }, 'bad_response');
    await rejected({ ...ASSET_A, path: 'assets/../manifest.json' }, 'bad_response');
    await rejected({ ...ASSET_A, path: 'SKILL.md' }, 'bad_response');
    await rejected({ ...ASSET_A, encoding: 'base64' }, 'bad_response');
    await rejected({ ...ASSET_A, version: '9.9.9' }, 'not_cached');
    await rejected({ ...ASSET_A, path: 'assets/knowledge/craft-index.md' }, 'not_deferred');
    await rejected({ ...ASSET_A, path: 'assets/knowledge/unknown.md' }, 'not_deferred');

    const altered = `${ASSET_A.content}!`;
    const alteredSha = crypto.createHash('sha256').update(altered).digest('hex');
    await rejected({ ...ASSET_A, content: altered }, 'digest_mismatch');
    await rejected({ ...ASSET_A, content: altered, sha256: alteredSha, size: Buffer.byteLength(altered) }, 'digest_mismatch');
    await rejected({ ...ASSET_A, size: ASSET_A.size + 1 }, 'digest_mismatch');
    assert.equal(await exists(path.join(f.skill, ASSET_A.path)), false);

    // The asset itself is right, but the cache around it no longer verifies: the write is undone.
    await fs.writeFile(path.join(f.skill, 'assets/knowledge/extra.md'), 'not in the package');
    const failed = await rejected(ASSET_A, 'verify_failed');
    assert.match(failed.stderr, /checksum mismatch/);
    assert.equal(await exists(path.join(f.skill, ASSET_A.path)), false);
    await fs.rm(path.join(f.skill, 'assets/knowledge/extra.md'));
    // A revoked skill takes no assets either.
    await fs.writeFile(path.join(f.data, 'skill-cache', 'deferred-skill.disabled'), '{}');
    await rejected(ASSET_A, 'verify_failed');
    assert.equal(await exists(path.join(f.skill, ASSET_A.path)), false);
    await fs.rm(path.join(f.data, 'skill-cache', 'deferred-skill.disabled'));
    // A wrapped tool result (structured content, content blocks) is accepted on the CLI too.
    const wrapped = await f.install({ content: [{ type: 'text', text: JSON.stringify(ASSET_A) }] });
    assert.equal(wrapped.code, 0, wrapped.stderr);
    const leftovers = (await fs.readdir(path.join(f.skill, 'assets/knowledge'))).filter((n) => n.startsWith('.'));
    assert.deepEqual(leftovers, []);
  });

  test(`${host}: --hook installs on success and answers in this host's hook shape`, async (t) => {
    const f = await fixture(t, host);
    await f.unpack();
    const toolName = host === 'claude' ? 'mcp__plugin_kabo-alpha_kabo__registry_skill_asset' : 'mcp__kabo__registry_skill_asset';
    const event = (response, input = { id: ASSET_A.id, version: ASSET_A.version, path: ASSET_A.path }) => ({
      session_id: 's', hook_event_name: 'PostToolUse', tool_name: toolName, tool_input: input, tool_response: response,
    });

    const ok = await f.hook(event([{ type: 'text', text: JSON.stringify(ASSET_A) }]));
    assert.equal(ok.code, 0);
    assert.deepEqual(JSON.parse(ok.stdout), {
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `kabo: asset installed deferred-skill@1.0.0 ${ASSET_A.path}` },
    });
    assert.equal(await fs.readFile(path.join(f.skill, ASSET_A.path), 'utf8'), ASSET_A.content);

    const warning = 'kabo: asset rejected digest_mismatch — do not use this content';
    const bad = await f.hook(event({ structuredContent: { ...ASSET_B, content: `${ASSET_B.content}!` } },
      { id: ASSET_B.id, version: ASSET_B.version, path: ASSET_B.path }));
    assert.equal(bad.code, 0);
    const expected = host === 'claude'
      ? { hookEventName: 'PostToolUse', additionalContext: warning, updatedMCPToolOutput: { error: warning } }
      : { hookEventName: 'PostToolUse', additionalContext: warning };
    assert.deepEqual(JSON.parse(bad.stdout), { hookSpecificOutput: expected });
    assert.equal(await exists(path.join(f.skill, ASSET_B.path)), false);

    // A result that answers a different call than the one made is not trusted.
    const swapped = await f.hook(event(ASSET_B));
    assert.match(JSON.parse(swapped.stdout).hookSpecificOutput.additionalContext, /^kabo: asset rejected bad_response/);

    // Silence: another tool, a tool error, an unparseable event.
    assert.equal((await f.hook({ ...event(ASSET_A), tool_name: 'mcp__kabo__registry_skill_download' })).stdout, '');
    assert.equal((await f.hook(event({ error: { code: 'version_superseded', latest_version: '1.0.1' } }))).stdout, '');
    const garbage = await f.hook('not json');
    assert.equal(garbage.code, 0);
    assert.equal(garbage.stdout, '');
  });
}

test('claude: hooks.json routes registry_skill_asset through the node-resolving shim', async (t) => {
  const plugin = path.join(root, 'plugins/claude/kabo-alpha');
  const hooks = JSON.parse(await fs.readFile(path.join(plugin, 'hooks/hooks.json'), 'utf8'));
  const entry = hooks.hooks.PostToolUse.find((e) => e.hooks.some((h) => /skill-asset-install\.sh/.test(h.command)));
  assert.ok(entry);
  const matcher = new RegExp(entry.matcher);
  assert.ok(matcher.test('mcp__plugin_kabo-alpha_kabo__registry_skill_asset'));
  assert.ok(!matcher.test('mcp__plugin_kabo-alpha_kabo__registry_skill_download'));
  for (const other of hooks.hooks.PostToolUse.filter((e) => e !== entry)) {
    assert.ok(!new RegExp(other.matcher).test('mcp__plugin_kabo-alpha_kabo__registry_skill_asset'));
  }
  assert.equal(entry.hooks[0].type, 'command');
  assert.equal(entry.hooks[0].command, 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/hooks/skill-asset-install.sh"');
  const shim = path.join(plugin, 'scripts/hooks/skill-asset-install.sh');
  assert.ok((await fs.stat(shim)).mode & 0o111);
  // The shim end to end: it finds node and hands the event to bin/skill-asset-install --hook.
  const f = await fixture(t, 'claude');
  await f.unpack();
  const result = await run(shim, [], f.env, JSON.stringify({
    hook_event_name: 'PostToolUse', tool_name: 'mcp__plugin_kabo-alpha_kabo__registry_skill_asset', tool_response: ASSET_A,
  }));
  assert.equal(result.code, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /^kabo: asset installed /);
});

test('codex: hooks.json adds a command hook for registry_skill_asset and no unknown event', async () => {
  const hooks = JSON.parse(await fs.readFile(path.join(root, 'plugins/codex/kabo-alpha/hooks/hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ['PostToolUse', 'SessionStart']);
  const entry = hooks.hooks.PostToolUse.find((e) => e.hooks.some((h) => /skill-asset-install --hook/.test(h.command)));
  assert.ok(entry);
  assert.ok(new RegExp(entry.matcher).test('mcp__kabo__registry_skill_asset'));
  assert.ok(!new RegExp(entry.matcher).test('mcp__kabo__registry_skill_download'));
  assert.deepEqual(entry.hooks.map((h) => h.type), ['command']);
  assert.equal(entry.hooks[0].command, 'node ${PLUGIN_ROOT}/bin/skill-asset-install --hook');
});

test('both runners may call registry_skill_asset without declaring it', async () => {
  const claude = await fs.readFile(path.join(root, 'plugins/claude/kabo-alpha/agents/skill-runner.md'), 'utf8');
  const tools = claude.match(/^tools: (.*)$/m)[1].split(', ');
  assert.ok(tools.includes('mcp__plugin_kabo-alpha_kabo__registry_skill_asset'));
  assert.match(claude, /The other exception is `registry_skill_asset`/);
  assert.match(claude, /The result \*\*is\*\* the file's content/);
  const codex = await fs.readFile(path.join(root, 'plugins/codex/kabo-alpha/skills/skill-runner/SKILL.md'), 'utf8');
  assert.match(codex, /`mcp__kabo__registry_skill_asset`/);
  assert.match(codex, /The result \*\*is\*\* the file's content/);
});

test('codex: the download hook installs a deferred package and keeps its deferred_files', async (t) => {
  const f = await fixture(t, 'codex');
  const result = await run(path.join(f.plugin, 'scripts/hooks/install-skill-package.js'), [], f.env, JSON.stringify({
    session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'mcp__kabo__registry_skill_download', tool_response: { structuredContent: PKG },
  }));
  assert.equal(result.code, 0, result.stderr);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /2 deferred asset\(s\) fetched on demand/);
  assert.match(context, /Verification passed: deferred-skill@1\.0\.0 .*2 deferred asset\(s\) not fetched yet/);
  const meta = JSON.parse(await fs.readFile(path.join(f.skill, '.meta.json'), 'utf8'));
  assert.deepEqual(meta.deferred_files, PKG.deferred_files);
  assert.equal((await f.install(ASSET_B)).code, 0);
});
