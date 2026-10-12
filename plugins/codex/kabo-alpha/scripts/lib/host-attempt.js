// Native MCP metadata owns attempt identity. Model arguments and reservations cannot reset it.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dataRoot } from './common.js';
import { validateExecutionStages, resolveSignedReportPath } from './signed-stages.js';

const token = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const sha = value => createHash('sha256').update(value).digest('hex');
const check = (ok, reason) => { if (!ok) throw new Error(reason); };
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function privateStat(file, directory = false, privateMode = true) {
  const stat = fs.lstatSync(file);
  check(directory ? stat.isDirectory() : stat.isFile(), 'attempt_path_not_regular');
  check((stat.mode & (privateMode ? 0o077 : 0o022)) === 0 && (!process.getuid || stat.uid === process.getuid()), 'attempt_path_not_private');
  if (!directory) check(stat.nlink === 1, 'attempt_file_hardlinked');
  return stat;
}
function directory(dir) {
  fs.mkdirSync(dir, { mode: 0o700 });
  privateStat(dir, true);
}
function ensureDirectory(dir) {
  try { directory(dir); } catch (error) { if (error.code !== 'EEXIST') throw error; privateStat(dir, true); }
}
function read(file, privateMode = true) {
  privateStat(file, false, privateMode);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.nlink === 1 && stat.size <= 1024 * 1024, 'attempt_file_invalid');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}
function scopeOf(value) {
  check(value && typeof value.session_id === 'string' && typeof value.turn_id === 'string' && token.test(value.session_id) && token.test(value.turn_id),
    'host_attempt_scope_missing; this signed contract requires the native host preparation handoff');
  return { session_id: value.session_id, turn_id: value.turn_id };
}

// Codex injects these fields beside arguments, in tools/call params._meta.
// Never read the same names from arguments or accept a caller-selected request id.
export function hostScopeFromParams(params) {
  const meta = params?._meta, turn = meta?.['x-codex-turn-metadata'];
  if (typeof meta?.threadId !== 'string' || !token.test(meta.threadId) ||
      typeof turn?.turn_id !== 'string' || !token.test(turn.turn_id)) return null;
  if (turn.thread_id !== undefined && turn.thread_id !== meta.threadId) return null;
  return { session_id: meta.threadId, turn_id: turn.turn_id };
}
function indexFor(binding, root) {
  const scope = scopeOf(binding.host_scope);
  const base = path.join(root, 'runtime-attempts');
  ensureDirectory(base);
  const turn = path.join(base, sha(JSON.stringify([scope.session_id, scope.turn_id])));
  ensureDirectory(turn);
  return path.join(turn, `${sha(binding.skill_id)}.json`);
}
function bindingFor(prepared, runId) {
  check(prepared.verified === true && token.test(prepared.id ?? '') && token.test(runId ?? ''), 'attempt_preparation_invalid');
  return { format_version: 1, host_scope: scopeOf(prepared.host_scope), skill_id: prepared.id,
    skill: prepared.skill_directory, checksum: prepared.checksum, manifest: prepared.manifest_sha256, run_id: runId };
}

export function bindRunAttempt({ prepared, runDir, runId, root = dataRoot() }) {
  privateStat(root, true); privateStat(runDir, true);
  const binding = bindingFor(prepared, runId), index = indexFor(binding, root);
  try { fs.writeFileSync(index, JSON.stringify(binding) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    check(equal(read(index), binding), 'host_attempt_already_reserved; preserve its run and stop, do not create a replacement');
  }
  const local = path.join(runDir, '.pipeline-attempt.json');
  try { fs.writeFileSync(local, JSON.stringify(binding) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; check(equal(read(local), binding), 'run_attempt_binding_changed'); }
  return binding;
}

export function assertRunAttempt({ runDir, runId, skillDir, checksum, manifest, root = dataRoot() }) {
  privateStat(root, true); privateStat(runDir, true);
  const binding = read(path.join(runDir, '.pipeline-attempt.json'));
  check(binding.format_version === 1 && binding.run_id === runId && binding.skill === fs.realpathSync(skillDir) &&
    binding.checksum === checksum && binding.manifest === manifest, 'run_attempt_binding_mismatch');
  check(equal(read(indexFor(binding, root)), binding), 'host_attempt_binding_mismatch');
  return binding;
}


// Read the signed final artifact, never a caller-selected file or a model summary.
export function readCompletedReport({ runDir, runId, hostScope, root = dataRoot() }) {
  const scope = scopeOf(hostScope);
  privateStat(runDir, true);
  const binding = read(path.join(runDir, '.pipeline-attempt.json'));
  check(equal(binding.host_scope, scope), 'report_host_scope_mismatch');
  assertRunAttempt({ runDir, runId, skillDir: binding.skill, checksum: binding.checksum, manifest: binding.manifest, root });
  privateStat(binding.skill, true);
  check(!fs.existsSync(path.join(path.dirname(path.dirname(binding.skill)), `${binding.skill_id}.disabled`)), 'report_skill_revoked');
  const manifest = read(path.join(binding.skill, 'manifest.json'), false);
  check(sha(fs.readFileSync(path.join(binding.skill, 'manifest.json'))) === binding.manifest &&
    read(path.join(binding.skill, '.meta.json'), false).checksum === binding.checksum && manifest.name === binding.skill_id,
    'report_package_binding_changed');
  const stages = validateExecutionStages(manifest);
  const state = read(path.join(runDir, '.pipeline-stages.json'));
  const record = read(path.join(runDir, 'run-manifest.json'));
  check(state.status === 'ok' && record.status === 'ok' && record.run_id === runId && record.skill_id === binding.skill_id &&
    state.skill === binding.skill && state.checksum === binding.checksum && state.manifest === binding.manifest,
    'report_run_not_completed');
  const history = state.execution_stages ?? {};
  const finals = Object.entries(stages).filter(([name, stage]) => stage.final && history[name]?.status === 'completed');
  check(finals.length === 1 && Object.values(history).every(stage => stage.status === 'completed'), 'report_final_stage_missing');
  const [stageName, stage] = finals[0];
  check(stage.after.every(name => history[name]?.status === 'completed'), 'report_predecessors_incomplete');
  const file = resolveSignedReportPath(runDir, stage.report_file);
  privateStat(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0 && (!process.getuid || stat.uid === process.getuid()) && stat.size > 0 && stat.size <= 256 * 1024, 'report_file_invalid_or_too_large');
    bytes = fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
  const digest = sha(bytes);
  const artifact = record.artifacts?.filter(item => item.kind === 'report' && item.path_or_uri === stage.report_file);
  check(bytes.length > 0 && bytes.length <= 256 * 1024, 'report_file_invalid_or_too_large');
  check(artifact?.length === 1 && artifact[0].sha256 === digest, 'report_artifact_digest_mismatch');
  // Fatal decoding preserves valid UTF-8 byte content, including an intentional BOM.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  check(text.trim().length > 0, 'report_empty');
  return { run_id: runId, stage: stageName, path: file, sha256: digest, bytes: bytes.length, text };
}


// Stop only checks reports that actually completed in this native turn. It does not
// turn a legitimate clarification or a failed/partial run into a completion demand.
export function completedReportsForScope({ hostScope, root = dataRoot(), workRoot }) {
  const scope = scopeOf(hostScope), attempts = path.join(root, 'runtime-attempts');
  const base = path.join(attempts, sha(JSON.stringify([scope.session_id, scope.turn_id])));
  if (!fs.existsSync(base)) return [];
  privateStat(root, true); privateStat(attempts, true); privateStat(base, true); privateStat(workRoot, true);
  const reports = [];
  for (const name of fs.readdirSync(base)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const binding = read(path.join(base, name));
    if (!equal(binding.host_scope, scope)) continue;
    check(token.test(binding.run_id ?? ''), 'report_attempt_identity_invalid');
    const runDir = path.join(workRoot, binding.run_id);
    privateStat(runDir, true);
    const record = read(path.join(runDir, 'run-manifest.json'));
    if (record.status !== 'ok') continue;
    reports.push(readCompletedReport({ runDir, runId: binding.run_id, hostScope: scope, root }));
  }
  return reports;
}
