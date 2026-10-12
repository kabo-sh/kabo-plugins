// Signed stage contracts bind native execution to package-owned commands and private JSON inputs.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { compareSemver } from './common.js';
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function require(ok, message) { if (!ok) throw new Error(message); }
export function validateExecutionStages(manifest) {
  const minimum = manifest.min_plugin_version;
  const semver = typeof minimum === 'string' && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(minimum);
  require(semver && (!semver[4] || semver[4].split('.').every(x => !/^[0-9]+$/.test(x) || x === '0' || !x.startsWith('0'))), 'execution_stages requires a legal min_plugin_version');
  const ordering = compareSemver(minimum, '0.21.28');
  require(ordering > 0 || (ordering === 0 && !semver[4]), 'execution_stages requires min_plugin_version >= 0.21.28');
  const contract = manifest.execution_stages;
  require(object(contract) && contract.format_version === 1 && Object.keys(contract).every(k => ['format_version','stages'].includes(k)) && object(contract.stages), 'invalid execution_stages contract');
  const stages = contract.stages, names = Object.keys(stages);
  require(names.length > 0 && names.every(n => TOKEN.test(n)), 'invalid signed stage names');
  for (const [name, s] of Object.entries(stages)) {
    require(object(s) && Object.keys(s).every(k => ['cmd','input','after','final','report_file'].includes(k)), `invalid signed stage ${name}`);
    require(typeof s.cmd === 'string' && s.cmd.trim() && ['json','none'].includes(s.input) && typeof s.final === 'boolean' && Array.isArray(s.after), `incomplete signed stage ${name}`);
    require(s.after.every(n => typeof n === 'string' && Object.hasOwn(stages,n) && n !== name) && new Set(s.after).size === s.after.length, `invalid predecessors for ${name}`);
    require((s.input === 'json') === s.cmd.includes('{stage_input}'), `stage ${name} input placeholder mismatch`);
    require(!/\{param\./.test(s.cmd), 'signed stages do not accept caller-selected parameters');
    require(s.final ? typeof s.report_file === 'string' && TOKEN.test(s.report_file) : s.report_file === undefined, `invalid report_file for ${name}`);
  }
  const active = new Set(), done = new Set();
  function visit(name) { require(!active.has(name), 'cyclic signed stage predecessors'); if (done.has(name)) return; active.add(name); stages[name].after.forEach(visit); active.delete(name); done.add(name); }
  names.forEach(visit);
  return stages;
}
export function selectSignedStage({manifest, name, state}) {
  const stages = validateExecutionStages(manifest);
  require(TOKEN.test(name ?? '') && Object.hasOwn(stages,name), 'unknown signed stage');
  const history = state?.execution_stages ?? {};
  require(object(history), 'invalid signed stage history');
  require(!Object.hasOwn(history,name), 'signed stage was already attempted; preserve artifacts and stop');
  require(Object.values(history).every(x => x?.status === 'completed'), 'a previous signed stage is unfinished or failed; preserve artifacts and stop');
  require(stages[name].after.every(n => history[n]?.status === 'completed'), 'signed stage predecessors are incomplete');
  return stages[name];
}
function privatePath(file, directory = false) {
  const stat = fs.lstatSync(file);
  require(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()), 'stage input paths must be regular and not symlinked');
  require((stat.mode & 0o077) === 0 && (process.getuid === undefined || stat.uid === process.getuid()), 'stage input paths must be private and owned by this user');
  if (!directory) require(stat.nlink === 1, 'stage input must not be hardlinked');
}
function privateRead(file) {
  privatePath(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const stat = fs.fstatSync(fd); require(stat.isFile() && stat.size <= 32*1024*1024, 'invalid stage input file'); return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}
export function readStageInput({runDir,runId,skillDir,stage,contract,receiptPath}) {
  privatePath(runDir,true);
  if (contract.input === 'none') { require(receiptPath === null, 'this stage accepts no input receipt'); return null; }
  require(receiptPath === null || typeof receiptPath === 'string', 'invalid signed stage receipt path');
  const realRun = fs.realpathSync(runDir), owner = path.join(realRun,'owner'), folder = path.join(owner,'stage-inputs');
  privatePath(runDir,true); // normal OS ancestor aliases may resolve differently; the run itself cannot be a symlink
  [realRun,owner,folder].forEach(p => privatePath(p,true));
  const input = path.join(folder,`${stage}.json`), expectedReceipt = path.join(folder,`${stage}.receipt.json`);
  require(receiptPath === null || path.resolve(receiptPath) === expectedReceipt, 'input receipt must use the fixed current-run owner path');
  const receipt = JSON.parse(privateRead(expectedReceipt).toString('utf8'));
  require(object(receipt) && receipt.format_version === 1 && receipt.run_id === runId && receipt.skill === fs.realpathSync(skillDir) && receipt.checksum === JSON.parse(fs.readFileSync(path.join(skillDir,'.meta.json'),'utf8')).checksum && receipt.manifest === hash(fs.readFileSync(path.join(skillDir,'manifest.json'))) && receipt.stage === stage && receipt.input_file === input, 'stage input receipt binding mismatch');
  const bytes = privateRead(input);
  require(receipt.input_sha256 === hash(bytes), 'stage input digest mismatch');
  require(object(JSON.parse(bytes.toString('utf8'))), 'stage input must be a JSON object');
  return {file:input,sha256:receipt.input_sha256};
}
