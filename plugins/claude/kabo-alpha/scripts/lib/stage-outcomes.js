// V2 native continuation consumes only normal host-hook records, never caller snapshots.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dataRoot } from './common.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const check = (ok, reason) => { if (!ok) throw new Error(reason); };
const canonical = value => JSON.stringify(sort(value));
function sort(value) { return Array.isArray(value) ? value.map(sort) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k,sort(value[k])])) : value; }
function privatePath(file, directory = false) {
  const stat = fs.lstatSync(file);
  check(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1, 'outcome_path_not_regular');
  check((stat.mode & 0o077) === 0 && (!process.getuid || stat.uid === process.getuid()), 'outcome_path_not_private');
}
function read(file, maximum = 1024 * 1024) {
  privatePath(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0 && (!process.getuid || stat.uid === process.getuid()) && stat.size <= maximum, 'outcome_file_invalid');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function folder(parent, name) {
  privatePath(parent,true);
  const dir = path.join(parent,name);
  try { fs.mkdirSync(dir,{mode:0o700}); } catch(e) { if(e.code !== 'EEXIST') throw e; }
  privatePath(dir,true); return dir;
}
export function flattenStageRequests(requests) {
  check(Array.isArray(requests) && requests.length <= 4, 'outcome_requests_invalid');
  const result = [];
  for (const request of requests) {
    check(object(request) && Object.keys(request).every(k => ['tool','arguments'].includes(k)) && object(request.arguments), 'outcome_request_invalid');
    if (request.tool === 'data_connector_run') result.push(request.arguments);
    else {
      check(request.tool === 'data_connector_batch_run' && Object.keys(request.arguments).length === 1 && Array.isArray(request.arguments.requests) && request.arguments.requests.length >= 1 && request.arguments.requests.length <= 4, 'outcome_batch_invalid');
      result.push(...request.arguments.requests);
    }
  }
  check(result.length <= 4, 'outcome_batch_limit');
  for (const request of result) check(object(request) && Object.keys(request).every(k => ['connector_id','operation','params'].includes(k)) && typeof request.connector_id === 'string' && request.connector_id.length > 0 && typeof request.operation === 'string' && request.operation.length > 0 && object(request.params), 'outcome_connector_request_invalid');
  return result;
}
function evidence(scope, root, {exclude = [], requests = null, baselineOnly = false} = {}) {
  const base = path.join(root,'envelope-staging'), found = [];
  if (!fs.existsSync(base)) return found;
  privatePath(base,true);
  let count = 0, totalBytes = 0;
  function visit(dir, depth) {
    privatePath(dir,true);
    for (const name of fs.readdirSync(dir)) {
      check(++count <= 4096, 'native_evidence_index_too_large');
      const file = path.join(dir,name), stat = fs.lstatSync(file);
      if (stat.isDirectory() && depth < 2) { visit(file,depth+1); continue; }
      if (!/^\d{2,}\.meta$/.test(name)) continue;
      const meta = JSON.parse(read(file).toString('utf8'));
      if (canonical(meta.native_scope) !== canonical(scope) || typeof meta.tool_use_id !== 'string' || !object(meta.native_request)) continue;
      const id = hash(path.relative(base,file)+'\n'+meta.tool_use_id+'\n'+meta.sha256);
      if (exclude.includes(id) || (requests && !requests.some(request => canonical(request) === canonical(meta.native_request)))) continue;
      if (baselineOnly) { found.push({id}); continue; }
      const bytes = read(file.slice(0,-5)+'.json',32*1024*1024);
      totalBytes += bytes.length; check(totalBytes <= 32*1024*1024 && found.length < 128, 'native_receipt_evidence_too_large');
      check(meta.sha256 === hash(bytes), 'native_evidence_hash_changed');
      const envelope = JSON.parse(bytes.toString('utf8'));
      check(envelope.connector_id === meta.native_request.connector_id && envelope.operation === meta.native_request.operation, 'native_evidence_request_mismatch');
      // Provider request metadata, when present, may not contradict the normal tool arguments.
      if (Object.hasOwn(envelope,'request')) check(canonical(envelope.request) === canonical(meta.native_request.params), 'native_evidence_params_mismatch');
      found.push({id,request:meta.native_request,envelope:{...envelope,request:meta.native_request.params}});
    }
  }
  visit(base,0); return found;
}
export function prepareStageOutcome({runDir,runId,stage,inputSha,manifestSha,skillId,binding,previous,language,root=dataRoot()}) {
  const owner = folder(runDir,'owner'), outcomes = folder(owner,'stage-outcomes');
  const file = path.join(outcomes,`${stage}.json`), reservation = path.join(owner,'reservation.json');
  const value = {format_version:1,skill_id:skillId,run:fs.realpathSync(runDir),manifest_sha256:manifestSha,attempt_id:runId};
  try { fs.writeFileSync(reservation,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600}); }
  catch(e) { if(e.code !== 'EEXIST') throw e; check(canonical(JSON.parse(read(reservation))) === canonical(value),'stage_reservation_changed'); }
  if (previous?.status === 'awaiting_connector') {
    check(previous.input_sha256 === inputSha && previous.language === language, 'paused_stage_input_or_language_changed');
    check(hash(read(file)) === previous.outcome_sha256, 'paused_stage_outcome_changed');
    check(previous.rounds >= 1 && previous.rounds <= 8, 'paused_stage_round_limit');
    const accepted = evidence(binding.host_scope,root,{exclude:previous.evidence_ids ?? [],requests:previous.requests});
    const used = new Set(), envelopes = [];
    for (const request of previous.requests) {
      const item = accepted.find(item => !used.has(item.id) && canonical(item.request) === canonical(request));
      check(item, 'native_same_turn_connector_receipt_missing; preserve awaiting run, do not execute or forge a receipt');
      used.add(item.id); envelopes.push(item.envelope);
    }
    const receipts = folder(owner,'stage-receipts'), receipt = path.join(receipts,`${stage}.json`);
    // Only this host path writes receipts. A stale prior round is checked before replacement.
    if (fs.existsSync(receipt)) { read(receipt); fs.unlinkSync(receipt); }
    const receiptBytes = JSON.stringify({format_version:1,input_sha256:inputSha,requests_sha256:hash(canonical(previous.requests)),outcome_sha256:previous.outcome_sha256,envelopes})+'\n';
    check(Buffer.byteLength(receiptBytes) <= 32*1024*1024, 'native_connector_receipt_too_large');
    fs.writeFileSync(path.join(receipts,`${stage}.${previous.rounds}.json`),receiptBytes,{flag:'wx',mode:0o600});
    fs.writeFileSync(receipt,receiptBytes,{flag:'wx',mode:0o600});
    return {file,rounds:previous.rounds,language,scope:binding.host_scope,inputSha,root};
  }
  check(!fs.existsSync(file), 'unowned_initial_stage_outcome');
  return {file,rounds:0,language,scope:binding.host_scope,inputSha,root};
}
export function readStageOutcome(context) {
  const bytes = read(context.file,64*1024), outcome = JSON.parse(bytes.toString('utf8'));
  check(object(outcome) && Object.keys(outcome).every(k => ['format_version','status','input_sha256','requests'].includes(k)) && outcome.format_version === 1 && ['completed','awaiting_connector'].includes(outcome.status) && outcome.input_sha256 === context.inputSha, 'stage_outcome_invalid');
  const requests = flattenStageRequests(outcome.requests);
  check(outcome.status === 'completed' ? requests.length === 0 : requests.length > 0, 'stage_outcome_status_requests_mismatch');
  const rounds = context.rounds + (outcome.status === 'awaiting_connector' ? 1 : 0);
  check(rounds <= 8, 'connector_handoff_limit; preserve artifacts and stop without fetching a ninth batch');
  const archive = context.file.replace(/\.json$/,`.${rounds}.${outcome.status}.json`);
  fs.writeFileSync(archive,bytes,{flag:'wx',mode:0o600});
  return {...outcome,input_sha256:context.inputSha,requests,rounds,language:context.language,outcome_sha256:hash(bytes),evidence_ids:evidence(context.scope,context.root,{baselineOnly:true}).map(item=>item.id)};
}
