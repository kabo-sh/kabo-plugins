#!/usr/bin/env node
// Local package preparation and stage data binding. Business execution stays in native exec.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cacheRoot, dataRoot, workRoot, ensurePrivateDir } from './lib/common.js';
import { selectSignedStage, validateExecutionStages } from './lib/signed-stages.js';
import { bindRunAttempt, hostScopeFromParams, readCompletedReport } from './lib/host-attempt.js';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const prepareDefinition = {
  name: 'prepare_skill',
  description: 'Prepare one registry Skill for execution in the active host data root. A cache hit runs the original network-aware skill-verify once. A miss returns download_required; pass registry_skill_download.structuredContent unchanged as package in the next call. The tool pipes JSON directly to skill-unpack --verify and returns its terminal result and verified manifest. Never manually unpack, reverify or execute after isError/verified:false. Does not execute business code or access OAuth credentials.',
  inputSchema: { type: 'object', properties: {
    id: { type: 'string', pattern: TOKEN.source }, version: { type: 'string', pattern: TOKEN.source },
    package: { type: 'object', description: 'The unchanged native registry download structuredContent; only for a cache miss.' },
  }, required: ['id', 'version'], additionalProperties: false },
};
export const inputDefinition = {
  name: 'stage_input',
  description: 'Bind one native JSON judgment/plan to a signed execution stage in an existing running Skill reservation. preparation is the basename of prepare_skill\'s successful receipt. Writes only a fixed private input and binding receipt; does not execute any script, fetch evidence or access OAuth. Use native kabo-run-pipeline --stage; it derives the fixed receipt from run/stage without copying an absolute input path. Native execution keeps its normal approval boundary. Refuses closed runs, unknown/out-of-order stages and replacement inputs.',
  inputSchema: { type: 'object', properties: {
    run_id: { type: 'string', pattern: TOKEN.source }, stage: { type: 'string', pattern: TOKEN.source },
    preparation: { type: 'string', pattern: '^[0-9]+-[a-f0-9-]+\\.json$' },
    input: { type: 'object', description: 'One plan or synthesis object, unchanged. Not a connector envelope or command.' },
  }, required: ['run_id', 'stage', 'preparation', 'input'], additionalProperties: false },
};
export const bindDefinition = {
  name: 'bind_run',
  description: 'Bind an existing Skill reservation to the native host turn that verified its preparation receipt. Use before a signed stage with no JSON input; stage_input performs the same binding for JSON stages. One Skill attempt has one reservation even after failure. A new run or a new preparation receipt for the same host turn cannot replace it. This does not execute scripts or grant shell approval.',
  inputSchema: { type: 'object', properties: {
    run_id: { type: 'string', pattern: TOKEN.source },
    preparation: { type: 'string', pattern: '^[0-9]+-[a-f0-9-]+\\.json$' },
  }, required: ['run_id', 'preparation'], additionalProperties: false },
};
export const reportDefinition = {
  name: 'read_report',
  description: "Read the complete unchanged report from this native turn's successfully finalized signed Skill attempt. Accepts only run_id, not a file path. Checks native turn binding, signed final stage, completed predecessors and finalized artifact SHA. Returns full UTF-8 body or an explicit failure, never a summary or truncation. Deliver this body in full using the host file-delivery path when available; a tool response alone is not creator delivery. Does not execute, fetch, or grant shell permission.",
  inputSchema: { type: 'object', properties: { run_id: { type: 'string', pattern: TOKEN.source } }, required: ['run_id'], additionalProperties: false },
};
export async function readReport(args, deps = {}) {
  if (!args || typeof args !== 'object' || Object.keys(args).some(key => key !== 'run_id') || typeof args.run_id !== 'string' || !TOKEN.test(args.run_id))
    return response({ error: 'invalid_report_identity' }, true);
  const data = path.resolve(deps.dataRoot ?? dataRoot());
  const work = path.resolve(deps.workRoot ?? workRoot());
  for (const dir of [data, work]) if (!fs.lstatSync(dir).isDirectory()) throw new Error('report_directory_not_regular');
  return response(readCompletedReport({ runDir: path.join(work, args.run_id), runId: args.run_id, hostScope: deps.hostScope, root: data }));
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function response(value, isError = false) {
  return { ...(isError ? { isError: true } : {}), structuredContent: value,
    content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function execute(file, args, input) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [file, ...args], { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const parts = []; let size = 0, reason = null;
    const stop = () => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch (e) { if (e.code !== 'ESRCH') child.kill('SIGKILL'); }
    };
    const timer = setTimeout(() => { reason = 'verification_timeout'; stop(); }, 120_000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      size += chunk.length;
      if (size <= 256 * 1024) parts.push(chunk);
      else { reason = 'verification_output_limit'; stop(); }
    });
    // A rejected package can close stdin before the producer finishes. Close is the terminal gate.
    child.stdin.on('error', () => {});
    child.on('error', () => { reason = 'verification_spawn_failed'; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ exit_code: code, signal, ...(reason ? { error: reason } : {}), diagnostics: Buffer.concat(parts).toString('utf8') });
    });
    child.stdin.end(input);
  });
}

export async function prepareSkill(args, deps = {}) {
  if (!args || typeof args !== 'object' || Object.keys(args).some(k => !['id', 'version', 'package'].includes(k)) ||
      typeof args.id !== 'string' || typeof args.version !== 'string' ||
      !TOKEN.test(args.id) || !TOKEN.test(args.version)) return response({ verified: false, error: 'invalid_skill_identity' }, true);
  const root = path.resolve(deps.root ?? cacheRoot()), dir = path.join(root, args.id, args.version);
  const locks = path.join(path.resolve(deps.dataRoot ?? dataRoot()), 'runtime-locks');
  const receipts = path.join(path.resolve(deps.dataRoot ?? dataRoot()), 'runtime-preparations');
  function safePaths() {
    for (const target of [root, locks, receipts, path.join(root, args.id), dir]) {
      try { if (fs.lstatSync(target).isSymbolicLink()) throw new Error('symlinked_runtime_path'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  safePaths();
  ensurePrivateDir(root); ensurePrivateDir(locks); ensurePrivateDir(receipts);
  const key = createHash('sha256').update(JSON.stringify([args.id, args.version])).digest('hex');
  const lock = path.join(locks, `prepare-${key}.lock`);
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch { return response({ verified: false, error: 'skill_preparation_busy' }, true); }
  try {
    safePaths();
    const finish = (value, failed = false) => {
      const receipt = path.join(receipts, `${Date.now()}-${randomUUID()}.json`);
      fs.writeFileSync(receipt, JSON.stringify({ id: args.id, version: args.version, finished_at: new Date().toISOString(), ...value }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      return response({ ...value, receipt }, failed);
    };
    if (fs.existsSync(path.join(root, `${args.id}.disabled`))) return finish({ verified: false, error: 'skill_revoked' }, true);
    const cached = fs.existsSync(dir);
    if (cached && args.package !== undefined) return response({ verified: false, error: 'cache_exists_do_not_redownload' }, true);
    if (!cached && args.package === undefined) return response({ verified: false, status: 'download_required', id: args.id, version: args.version });
    let input;
    if (!cached) {
      const pkg = args.package;
      if (!pkg || pkg.id !== args.id || pkg.version !== args.version) return response({ verified: false, error: 'package_identity_mismatch' }, true);
      input = JSON.stringify(pkg);
      if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) return response({ verified: false, error: 'package_too_large' }, true);
    }
    const runner = deps.execute ?? execute;
    const terminal = await runner(path.join(PLUGIN, 'bin', cached ? 'skill-verify' : 'skill-unpack'), cached ? [dir] : ['--verify', '-', root], input);
    if (terminal.exit_code !== 0 || terminal.signal || terminal.error)
      return finish({ verified: false, source: cached ? 'cache' : 'download', ...terminal }, true);
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); }
    catch { return finish({ verified: false, error: 'verified_manifest_unreadable' }, true); }
    if (manifest.name !== args.id || manifest.version !== args.version)
      return finish({ verified: false, error: 'signed_manifest_identity_mismatch' }, true);
    if (manifest.execution_stages !== undefined && !deps.hostScope)
      return finish({ verified: false, error: 'host_attempt_scope_missing' }, true);
    return finish({ ...(deps.hostScope ? { host_scope: deps.hostScope } : {}), verified: true, source: cached ? 'cache' : 'download', skill_directory: fs.realpathSync(dir), manifest,
      checksum: JSON.parse(fs.readFileSync(path.join(dir, '.meta.json'), 'utf8')).checksum,
      manifest_sha256: sha(fs.readFileSync(path.join(dir, 'manifest.json'))), ...terminal });
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

export async function stageInput(args, deps = {}) { return stageRequest(args, deps, false); }
export async function bindRun(args, deps = {}) { return stageRequest(args, deps, true); }
async function stageRequest(args, deps, bindOnly) {
  const keys = bindOnly ? ['run_id', 'preparation'] : ['run_id', 'stage', 'preparation', 'input'];
  if (!args || typeof args !== 'object' || Object.keys(args).some(k => !keys.includes(k)) ||
      typeof args.run_id !== 'string' || !TOKEN.test(args.run_id) || (!bindOnly && (typeof args.stage !== 'string' || !TOKEN.test(args.stage))) ||
      typeof args.preparation !== 'string' || !/^[0-9]+-[a-f0-9-]+\.json$/.test(args.preparation) ||
      (!bindOnly && (!args.input || typeof args.input !== 'object' || Array.isArray(args.input))))
    return response({ error: 'invalid_stage_input' }, true);
  if (!bindOnly && Object.hasOwn(args.input, 'connector_id') && Object.hasOwn(args.input, 'status'))
    return response({ error: 'connector_envelopes_use_native_staging' }, true);
  const input = bindOnly ? '' : JSON.stringify(args.input);
  if (Buffer.byteLength(input) + 1 > MAX_REQUEST_BYTES) return response({ error: 'stage_input_too_large' }, true);
  const data = path.resolve(deps.dataRoot ?? dataRoot()), cache = path.resolve(deps.root ?? cacheRoot());
  const work = path.resolve(deps.workRoot ?? workRoot()), runPath = path.join(work, args.run_id);
  const preparation = path.join(data, 'runtime-preparations', args.preparation);
  function regular(file) {
    if (!fs.lstatSync(file).isFile()) throw new Error('expected_regular_runtime_file');
    return fs.readFileSync(file);
  }
  function directories(paths) {
    for (const p of paths) if (!fs.lstatSync(p).isDirectory()) throw new Error('expected_real_runtime_directory');
  }
  directories([data, cache, work, runPath, path.join(runPath, 'owner'), path.dirname(preparation)]);
  const run = fs.realpathSync(runPath);
  for (const dir of [run, path.join(run, 'owner')]) {
    const stat = fs.lstatSync(dir);
    if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('run_input_paths_not_private');
  }
  const prepared = JSON.parse(regular(preparation));
  if (!deps.hostScope || JSON.stringify(prepared.host_scope) !== JSON.stringify(deps.hostScope))
    throw new Error('preparation_host_scope_mismatch');
  if (prepared.verified !== true || typeof prepared.id !== 'string' || !TOKEN.test(prepared.id) ||
      typeof prepared.version !== 'string' || !TOKEN.test(prepared.version)) throw new Error('invalid_preparation_receipt');
  const skill = path.join(cache, prepared.id, prepared.version);
  directories([path.join(cache, prepared.id), skill]);
  if (fs.realpathSync(skill) !== prepared.skill_directory || fs.existsSync(path.join(cache, `${prepared.id}.disabled`)))
    throw new Error('preparation_identity_changed_or_revoked');
  const manifestBytes = regular(path.join(skill, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes), meta = JSON.parse(regular(path.join(skill, '.meta.json')));
  if (sha(manifestBytes) !== prepared.manifest_sha256 || meta.checksum !== prepared.checksum ||
      manifest.name !== prepared.id || manifest.version !== prepared.version) throw new Error('prepared_package_changed');
  const lock = path.join(work, `.${args.run_id}.pipeline-lock`);
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); }
  catch { return response({ error: 'run_stage_busy' }, true); }
  try {
    const record = JSON.parse(regular(path.join(run, 'run-manifest.json')));
    if (record.status !== 'running' || record.skill_id !== prepared.id) throw new Error('run_closed_or_different_skill');
    let state = null;
    try { state = JSON.parse(regular(path.join(run, '.pipeline-stages.json'))); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (state && (state.status !== 'running' || state.skill !== prepared.skill_directory || state.manifest !== prepared.manifest_sha256 || state.checksum !== prepared.checksum))
      throw new Error('run_stage_binding_changed');
    if (bindOnly) {
      validateExecutionStages(manifest);
      bindRunAttempt({ prepared, runDir: run, runId: args.run_id, root: data });
      return response({ bound: true, run_id: args.run_id });
    }
    const stage = selectSignedStage({ manifest, name: args.stage, state });
    if (stage.input !== 'json') throw new Error('stage_has_no_signed_json_input');
    bindRunAttempt({ prepared, runDir: run, runId: args.run_id, root: data });
    const base = path.join(run, 'owner', 'stage-inputs');
    try { directories([base]); } catch (e) { if (e.code !== 'ENOENT') throw e; ensurePrivateDir(base); }
    const file = path.join(base, `${args.stage}.json`), receipt = path.join(base, `${args.stage}.receipt.json`);
    const binding = { format_version: 1, run_id: args.run_id, skill: prepared.skill_directory, checksum: prepared.checksum,
      manifest: prepared.manifest_sha256, stage: args.stage, input_file: file, input_sha256: sha(input) };
    fs.writeFileSync(file, input + '\n', { flag: 'wx', mode: 0o600 });
    // Hash the exact stored bytes, including their final newline.
    binding.input_sha256 = sha(input + '\n');
    fs.writeFileSync(receipt, JSON.stringify(binding, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return response({ staged: true, input_receipt: receipt, ...binding });
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

export async function handleRpc(request, deps = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('invalid_request');
  const { id, method, params = {} } = request;
  if (id === undefined) return null;
  let result;
  if (method === 'initialize') result = { protocolVersion: params.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'kabo-skill-runtime', version: '1.0.0' } };
  else if (method === 'ping') result = {};
  else if (method === 'tools/list') result = { tools: [prepareDefinition, inputDefinition, bindDefinition, reportDefinition] };
  else if (method === 'tools/call' && ['prepare_skill', 'stage_input', 'bind_run', 'read_report'].includes(params.name)) {
    try { result = await ({ prepare_skill: prepareSkill, stage_input: stageInput, bind_run: bindRun, read_report: readReport }[params.name])(params.arguments, { ...deps, hostScope: hostScopeFromParams(params) }); }
    catch (e) { result = response({ verified: false, error: 'skill_preparation_failed', reason: e.code ?? e.message }, true); }
  }
  else return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  return { jsonrpc: '2.0', id, result };
}

// Unlike the link adapter's 16KiB lines, native registry packages are megabytes. Bound bytes
// while receiving, before JSON.parse, and drain an oversized request without retaining its body.
export async function* requestLines(stream) {
  let chunks = [], bytes = 0, oversized = false;
  for await (const chunk of stream) {
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset), stop = end === -1 ? chunk.length : end;
      const part = chunk.subarray(offset, stop); bytes += part.length;
      if (bytes > MAX_REQUEST_BYTES) { oversized = true; chunks = []; }
      else if (!oversized) chunks.push(part);
      if (end !== -1) {
        yield oversized ? null : Buffer.concat(chunks).toString('utf8');
        chunks = []; bytes = 0; oversized = false;
      }
      offset = stop + 1;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for await (const line of requestLines(process.stdin)) {
    let response;
    try {
      if (line === null) throw new Error('oversized');
      response = await handleRpc(JSON.parse(line));
    } catch { response = { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid or oversized runtime request' } }; }
    if (response) process.stdout.write(JSON.stringify(response) + '\n');
  }
}
