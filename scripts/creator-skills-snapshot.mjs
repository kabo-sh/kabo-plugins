#!/usr/bin/env node
// Pin of the creator-skills content this plugin repository depends on, plus the offline check that
// keeps the shipped plugin trees in step with it.
//
// creator-skills owns skill logic; the plugins only host it. Three things therefore come from a
// fixed creator-skills commit instead of being edited here by hand:
//   * contract fixtures (host staging / outbox golden samples) the plugin tests read;
//   * the union of `required.tools` over every subagent-executed runtime package, which the Claude
//     skill-runner `tools:` frontmatter must cover;
//   * any file the plugin ships verbatim from creator-skills (listed with its shipped targets).
//
// --verify (CI, offline): every pinned file matches its sha256, every shipped target in both host
// variants is byte-identical to its pinned source, and the runner frontmatter is exactly the host
// base tools plus the pinned union.
// --refresh --commit <sha> --source <creator-skills git checkout>: re-read the listed paths at that
// commit with `git show`, rewrite the snapshot, the pin and every shipped target, then --verify.
// --write-runner-tools: regenerate the Claude runner frontmatter from the pinned union.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshot = path.join(root, 'contracts-snapshot/creator-skills');
const pinPath = path.join(snapshot, 'pin.json');
const repository = 'kabo-sh/creator-skills';
const HOSTS = ['claude', 'codex'];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * What is pinned. `name` is the file under contracts-snapshot/creator-skills/, `path` its source in
 * creator-skills, `targets` the plugin-relative paths (under plugins/<host>/kabo-alpha/) that ship it
 * verbatim in both variants. Directory sources (`dir: true`) pin every file below them.
 */
const SPEC = JSON.parse(fs.readFileSync(path.join(snapshot, 'spec.json'), 'utf8'));

/** Tools the runner holds as host mechanics, whatever packages declare. Order is the frontmatter order. */
const RUNNER_BASE_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Write'];
const KABO = 'mcp__plugin_kabo-alpha_kabo__';
const RUNNER_HOST_KABO_TOOLS = ['data_connector_catalog', 'data_connector_run', 'data_connector_batch_run', 'data_connector_job', 'data_connector_artifact'];
const RUNNER_TAIL_TOOLS = ['registry_skill_asset'];
const runnerFile = path.join(root, 'plugins/claude/kabo-alpha/agents/skill-runner.md');

function readPin() {
  return JSON.parse(fs.readFileSync(pinPath, 'utf8'));
}

function expectedRunnerTools(union) {
  const fixed = [...RUNNER_HOST_KABO_TOOLS, ...RUNNER_TAIL_TOOLS];
  const extra = union.map((tool) => tool.slice(KABO.length)).filter((name) => !fixed.includes(name)).sort();
  return [
    ...RUNNER_BASE_TOOLS,
    ...RUNNER_HOST_KABO_TOOLS.map((name) => KABO + name),
    ...extra.map((name) => KABO + name),
    ...RUNNER_TAIL_TOOLS.map((name) => KABO + name),
  ];
}

function runnerToolsLine(text) {
  const match = text.match(/^---\n[\s\S]*?^tools: (.*)$[\s\S]*?^---\n/m);
  assert.ok(match, 'skill-runner.md has no tools: frontmatter line');
  return match[1];
}

function verify() {
  const pin = readPin();
  assert.equal(pin.repository, repository);
  assert.match(pin.commit, /^[a-f0-9]{40}$/);
  const names = Object.keys(pin.files).sort();
  for (const name of names) {
    const entry = pin.files[name];
    const bytes = fs.readFileSync(path.join(snapshot, name));
    assert.equal(sha(bytes), entry.sha256, `${name}: snapshot bytes do not match the pin`);
    for (const target of entry.targets ?? []) {
      for (const host of HOSTS) {
        const shipped = path.join(root, 'plugins', host, 'kabo-alpha', target);
        assert.ok(fs.existsSync(shipped), `${host}: ${target} is pinned but not shipped`);
        assert.ok(fs.readFileSync(shipped).equals(bytes),
          `${host}: ${target} differs from creator-skills ${entry.path}@${pin.commit.slice(0, 9)}; edit it in creator-skills and refresh the pin, never here`);
      }
    }
  }
  // Every shipped file under a generated directory must come from the pin, so a hand-added file fails too.
  for (const dir of SPEC.generated_dirs ?? []) {
    const pinnedTargets = new Set(names.flatMap((name) => pin.files[name].targets ?? []));
    for (const host of HOSTS) {
      const base = path.join(root, 'plugins', host, 'kabo-alpha', dir);
      if (!fs.existsSync(base)) continue;
      for (const file of fs.readdirSync(base, { recursive: true })) {
        const rel = path.posix.join(dir, String(file).split(path.sep).join('/'));
        if (fs.statSync(path.join(base, String(file))).isDirectory()) continue;
        assert.ok(pinnedTargets.has(rel), `${host}: ${rel} sits in a generated directory but is not in the creator-skills pin`);
      }
    }
  }
  const union = JSON.parse(fs.readFileSync(path.join(snapshot, 'runner-tools.json'), 'utf8')).required_tools;
  assert.deepEqual(runnerToolsLine(fs.readFileSync(runnerFile, 'utf8')).split(', '), expectedRunnerTools(union),
    'Claude skill-runner tools: frontmatter is generated from the pinned required.tools union; run --write-runner-tools');
  console.log(`Verified ${names.length} pinned creator-skills files at ${pin.commit.slice(0, 9)}, both shipped variants and the runner tools.`);
}

function writeRunnerTools() {
  const union = JSON.parse(fs.readFileSync(path.join(snapshot, 'runner-tools.json'), 'utf8')).required_tools;
  const text = fs.readFileSync(runnerFile, 'utf8');
  const line = runnerToolsLine(text);
  fs.writeFileSync(runnerFile, text.replace(`tools: ${line}\n`, `tools: ${expectedRunnerTools(union).join(', ')}\n`));
}

function gitShow(source, commit, file) {
  return execFileSync('git', ['-C', source, 'show', `${commit}:${file}`], { maxBuffer: 64 * 1024 * 1024 });
}

function gitList(source, commit, dir) {
  return execFileSync('git', ['-C', source, 'ls-tree', '-r', '--name-only', commit, '--', dir], { encoding: 'utf8' })
    .split('\n').filter(Boolean);
}

function refresh(commit, source) {
  const files = {};
  const fetched = {};
  for (const item of SPEC.files) {
    const sources = item.dir ? gitList(source, commit, item.path) : [item.path];
    assert.ok(sources.length, `${item.path} is empty at ${commit}`);
    for (const file of sources) {
      const rel = item.dir ? path.posix.relative(item.path, file) : path.posix.basename(file);
      const name = item.dir ? path.posix.join(item.name, rel) : item.name;
      const bytes = gitShow(source, commit, file);
      fetched[name] = bytes;
      files[name] = { path: file, sha256: sha(bytes) };
      if (item.targets) files[name].targets = item.targets.map((target) => (item.dir ? path.posix.join(target, rel) : target));
    }
  }
  // Union of required.tools over the subagent-executed runtime packages at that commit.
  const tools = new Set();
  const manifests = gitList(source, commit, SPEC.runtime_root).filter((file) => /^[^/]+\/manifest\.json$/.test(path.posix.relative(SPEC.runtime_root, file)));
  for (const file of manifests) {
    const manifest = JSON.parse(gitShow(source, commit, file).toString('utf8'));
    if (manifest.execution !== 'subagent') continue;
    for (const tool of manifest.required?.tools ?? []) {
      assert.ok(tool.startsWith(KABO), `${file}: required tool ${tool} is outside the Kabo namespace`);
      tools.add(tool);
    }
  }
  for (const name of Object.keys(readPinSafe().files ?? {})) {
    if (!(name in files)) fs.rmSync(path.join(snapshot, name), { force: true });
  }
  for (const [name, bytes] of Object.entries(fetched)) {
    fs.mkdirSync(path.dirname(path.join(snapshot, name)), { recursive: true });
    fs.writeFileSync(path.join(snapshot, name), bytes);
    for (const target of files[name].targets ?? []) {
      for (const host of HOSTS) {
        const shipped = path.join(root, 'plugins', host, 'kabo-alpha', target);
        fs.mkdirSync(path.dirname(shipped), { recursive: true });
        fs.writeFileSync(shipped, bytes);
      }
    }
  }
  fs.writeFileSync(path.join(snapshot, 'runner-tools.json'),
    JSON.stringify({ source: `${repository}@${commit}:${SPEC.runtime_root}`, execution: 'subagent', required_tools: [...tools].sort() }, null, 2) + '\n');
  fs.writeFileSync(pinPath, JSON.stringify({ repository, commit, files }, null, 2) + '\n');
  writeRunnerTools();
  verify();
}

function readPinSafe() {
  try { return readPin(); } catch { return {}; }
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--verify') verify();
else if (args.length === 1 && args[0] === '--write-runner-tools') { writeRunnerTools(); verify(); }
else if (args.length === 5 && args[0] === '--refresh' && args[1] === '--commit' && /^[a-f0-9]{40}$/.test(args[2]) && args[3] === '--source') refresh(args[2], args[4]);
else {
  console.error('Usage: node scripts/creator-skills-snapshot.mjs --verify | --write-runner-tools | --refresh --commit <40-char creator-skills commit> --source <creator-skills checkout>');
  process.exitCode = 1;
}
