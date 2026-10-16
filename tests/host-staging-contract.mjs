// Host staging contract against creator-skills golden samples (contracts/host-fixtures, pinned in
// contracts-snapshot/creator-skills). Every sample is a real `NN.json` + `NN.meta` staging pair a
// host wrote for a published package run. Both plugin variants must
//   1. drain each sample with `kabo-save-envelope` into byte-identical `snapshot/envelope-NN.json`;
//   2. stage the same envelope bytes through the persist hook as a pair of the same shape: identical
//      body bytes, and a sidecar carrying every field the sample carries with the same meaning.
// A package-side or host-side format change then fails here instead of at a creator's run.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'contracts-snapshot/creator-skills/host-fixtures');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function run(command, args, env, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.once('error', reject);
    child.once('close', (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

/** Every staging directory in the pinned samples, with its sorted pairs. */
function samples() {
  const found = [];
  for (const skill of fsSync.readdirSync(fixtures).sort()) {
    const base = path.join(fixtures, skill, 'host-staging');
    if (!fsSync.existsSync(base)) continue;
    for (const file of fsSync.readdirSync(base, { recursive: true })) {
      if (!String(file).endsWith('.meta')) continue;
      const dir = path.dirname(path.join(base, String(file)));
      if (!found.some((entry) => entry.dir === dir)) found.push({ skill, dir });
    }
  }
  return found.map(({ skill, dir }) => {
    const names = fsSync.readdirSync(dir);
    const stems = [...new Set(names.map((name) => /^(\d{2,})\.(json|meta)$/.exec(name)?.[1]).filter(Boolean))].sort();
    const complete = stems.filter((stem) => names.includes(`${stem}.json`) && names.includes(`${stem}.meta`));
    return {
      skill, dir,
      // A sample may also hold half pairs (a body still being written, a sidecar whose body never
      // landed): the drain must leave those in staging and report them, never move or drop them.
      incomplete: stems.length - complete.length,
      pairs: complete.map((stem) => ({ stem, meta: JSON.parse(fsSync.readFileSync(path.join(dir, `${stem}.meta`), 'utf8')) })),
    };
  });
}

const all = samples();
test('pinned host staging samples are present and self-consistent', () => {
  assert.ok(all.length >= 1, 'no host-staging samples pinned');
  for (const { skill, dir, pairs } of all) {
    assert.ok(pairs.length >= 1, `${skill}: empty staging sample`);
    for (const { stem, meta } of pairs) {
      const body = fsSync.readFileSync(path.join(dir, `${stem}.json`));
      assert.equal(meta.sha256, sha256(body), `${skill} ${stem}: sidecar sha256`);
      assert.equal(meta.bytes, body.length, `${skill} ${stem}: sidecar bytes`);
    }
  }
});

for (const host of ['claude', 'codex']) {
  const plugin = path.join(root, 'plugins', host, 'kabo-alpha');
  const hookFile = path.join(plugin, 'scripts/hooks/persist-envelope.js');
  const saveFile = path.join(plugin, 'bin/kabo-save-envelope');

  for (const { skill, dir, pairs, incomplete } of all) {
    test(`${host}: kabo-save-envelope drains the ${skill} sample byte for byte`, async (t) => {
      const data = await fs.mkdtemp(path.join(os.tmpdir(), `kabo-contract-${host}-`));
      t.after(() => fs.rm(data, { recursive: true, force: true }));
      const env = { PATH: process.env.PATH, KABO_DATA_ROOT: data, KABO_CODEX_DATA: data };
      const staging = path.join(data, 'envelope-staging', 'contract-session');
      await fs.cp(dir, staging, { recursive: true });
      const listed = await run(process.execPath, [saveFile, '--list', '--from', staging], env);
      assert.equal(listed.code, 0, listed.stderr);
      const snapshot = path.join(data, 'work', 'run', 'snapshot');
      const drained = await run(process.execPath, [saveFile, '--from', staging, '--into', snapshot], env);
      assert.equal(drained.code, 0, drained.stderr || drained.stdout);
      assert.match(drained.stdout, new RegExp(`staged=${pairs.length}\\b`));
      if (incomplete) assert.match(drained.stdout, new RegExp(`incomplete=${incomplete}\\b`), 'half pairs must be reported, not drained');
      else assert.doesNotMatch(drained.stdout, /incomplete=/);
      const written = (await fs.readdir(snapshot)).filter((name) => /^envelope-\d{2,}\.json$/.test(name)).sort();
      assert.equal(written.length, pairs.length);
      // Complete pairs drain in staging-number order into consecutive envelope numbers.
      const expected = pairs.map(({ stem }) => sha256(fsSync.readFileSync(path.join(dir, `${stem}.json`))));
      const actual = await Promise.all(written.map(async (name) => sha256(await fs.readFile(path.join(snapshot, name)))));
      assert.deepEqual(actual, expected, 'drained envelopes must be the staged bytes, in staging order');
      // Half pairs stay in staging untouched.
      const complete = new Set(pairs.map(({ stem }) => stem));
      for (const name of fsSync.readdirSync(dir)) {
        const stem = /^(\d{2,})\.(json|meta)$/.exec(name)?.[1];
        if (!stem || complete.has(stem)) continue;
        assert.ok(fsSync.readFileSync(path.join(dir, name)).equals(fsSync.readFileSync(path.join(staging, name))),
          `${name}: a half pair must stay in staging unchanged`);
      }
    });

    test(`${host}: persist hook stages ${skill} envelopes in the sample's shape`, async (t) => {
      const data = await fs.mkdtemp(path.join(os.tmpdir(), `kabo-contract-${host}-`));
      t.after(() => fs.rm(data, { recursive: true, force: true }));
      const env = { PATH: process.env.PATH, KABO_DATA_ROOT: data, KABO_CODEX_DATA: data };
      const session = 'contract-session';
      const out = path.join(data, 'envelope-staging', session);
      for (const [index, { stem, meta: sample }] of pairs.entries()) {
        const text = fsSync.readFileSync(path.join(dir, `${stem}.json`), 'utf8');
        const result = await run(process.execPath, [hookFile], env, JSON.stringify({
          session_id: session, hook_event_name: 'PostToolUse', tool_use_id: `contract-${index}`,
          tool_response: text,
        }));
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /kabo:/, `${stem}: the hook did not stage the sample envelope`);
        const metas = fsSync.readdirSync(path.join(out)).filter((name) => /^\d{2,}\.meta$/.test(name)).sort();
        const mine = metas[metas.length - 1];
        const meta = JSON.parse(fsSync.readFileSync(path.join(out, mine), 'utf8'));
        const body = fsSync.readFileSync(path.join(out, mine.replace(/\.meta$/, '.json')));
        assert.equal(sha256(body), sample.sha256, `${stem}: staged body must be the sample bytes`);
        for (const key of Object.keys(sample)) assert.ok(key in meta, `${stem}: sidecar lost field ${key}`);
        // `verbatim` records how this host received the text (exact substring or re-serialized), so
        // only its presence is part of the contract, not its value.
        for (const key of ['connector_id', 'operation', 'status', 'schema_version', 'sha256', 'bytes']) {
          if (key in sample) assert.deepEqual(meta[key], sample[key], `${stem}: sidecar ${key}`);
        }
      }
    });
  }
}
