#!/usr/bin/env node
// plugin-version.mjs - the one place that knows every file carrying the plugin version, and the
// rules that keep them honest. CI runs it on every pull request and on every push to main.
//
// Why this exists: the host installs whatever `main` holds, the skill registry's release gate
// validates skills against the `main` commit, and skills declare `min_plugin_version` against the
// semantic version string in plugin.json. None of those look at git tags, so a tag cannot stop a
// wrong version from reaching users - only a check that runs before the merge can. Two things went
// wrong before this file existed: the public line skipped from 0.18.4 straight to 0.19.0 while
// skills already required 0.18.5-0.18.9, and shipped files changed without any version bump.
//
// Rules (each one is a sentence on failure, never a stack trace):
//   1. The seven version fields agree and are plain x.y.z (no pre-release suffix: the plugin's
//      compareSemver reads "0-alpha" as 0, so 1.0.0-alpha and 1.0.0 compare equal).
//   2. With --base <ref>: any change under a shipped path requires a bump, and the bump must go up.
//   3. With --tags: the version is never below the highest existing v* tag.
//
// Output: the version on stdout (one line) so the workflow can tag with it. Exit 1 on any failure.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const SEMVER = /^\d+\.\d+\.\d+$/;

/** Every file that carries the version, with how to read it. Extend this list, never bypass it. */
const VERSION_SOURCES = [
  { file: '.claude-plugin/marketplace.json', read: (s) => JSON.parse(s).metadata?.version },
  { file: 'plugins/claude/kabo-alpha/.claude-plugin/plugin.json', read: (s) => JSON.parse(s).version },
  { file: 'plugins/codex/kabo-alpha/.codex-plugin/plugin.json', read: (s) => JSON.parse(s).version },
  { file: 'plugins/claude/kabo-alpha/package.json', read: (s) => JSON.parse(s).version },
  { file: 'plugins/codex/kabo-alpha/package.json', read: (s) => JSON.parse(s).version },
  { file: 'plugins/claude/kabo-alpha/scripts/lib/common.js', read: readRuntimeVersion },
  { file: 'plugins/codex/kabo-alpha/scripts/lib/common.js', read: readRuntimeVersion },
];

/** Paths whose content reaches users' machines. A change here without a bump is a silent release. */
const SHIPPED_PREFIXES = ['plugins/', '.claude-plugin/', '.agents/'];

function readRuntimeVersion(source) {
  const match = source.match(/export\s+const\s+PLUGIN_VERSION\s*=\s*['"]([^'"]+)['"]/);
  return match ? match[1] : undefined;
}

function fail(message) {
  process.stderr.write(`plugin-version: ${message}\n`);
  process.exit(1);
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** Read all version fields from the working tree (or from a git ref when given) and require agreement. */
function versionAt(ref) {
  const seen = new Map();
  for (const { file, read } of VERSION_SOURCES) {
    let source;
    try {
      source = ref ? git('show', `${ref}:${file}`) : fs.readFileSync(file, 'utf8');
    } catch {
      fail(`${file} is missing${ref ? ` at ${ref}` : ''}; every file in VERSION_SOURCES must exist`);
    }
    const version = read(source);
    if (typeof version !== 'string' || !SEMVER.test(version)) {
      fail(`${file} has no plain x.y.z version (found ${JSON.stringify(version)})`);
    }
    seen.set(file, version);
  }
  const distinct = new Set(seen.values());
  if (distinct.size !== 1) {
    const listing = [...seen].map(([f, v]) => `  ${v}  ${f}`).join('\n');
    fail(`the version fields disagree; every one of them must carry the same value:\n${listing}`);
  }
  return [...distinct][0];
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] || fail(`${name} needs a value`);
}

const version = versionAt(null);

const base = option('--base');
if (base) {
  const baseVersion = versionAt(base);
  const changed = git('diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean);
  const shipped = changed.filter((f) => SHIPPED_PREFIXES.some((p) => f.startsWith(p)));
  const order = compareSemver(version, baseVersion);
  if (order < 0) {
    fail(`version went backwards: ${baseVersion} on ${base} -> ${version} here`);
  }
  if (shipped.length > 0 && order === 0) {
    fail(
      `shipped files changed but the version is still ${baseVersion}; bump it (users install main as-is, so this would ship unversioned):\n` +
        shipped.map((f) => `  ${f}`).join('\n'),
    );
  }
}

if (process.argv.includes('--tags')) {
  const tags = git('tag', '--list', 'v*')
    .split('\n')
    .map((t) => t.replace(/^v/, ''))
    .filter((t) => SEMVER.test(t))
    .sort(compareSemver);
  const highest = tags.at(-1);
  if (highest && compareSemver(version, highest) < 0) {
    fail(`version ${version} is below the highest released tag v${highest}`);
  }
}

process.stdout.write(`${version}\n`);
