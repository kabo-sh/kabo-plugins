// Local metadata only: never pass package bodies, paths, credentials or raw error messages.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataRoot, ensurePrivateDir } from './common.js';

export function installDiagnostics() {
  const invocation = crypto.randomUUID();
  const started = Date.now();
  return (event, fields = {}) => {
    const record = { time: new Date().toISOString(), invocation, event, elapsed_ms: Date.now() - started, ...fields };
    const line = JSON.stringify(record) + '\n';
    try { fs.writeSync(2, `KABO_SKILL_UNPACK ${line}`); } catch {}
    try {
      const dir = path.join(dataRoot(), 'logs');
      ensurePrivateDir(dir);
      const file = path.join(dir, 'skill-unpack.jsonl');
      if (fs.existsSync(file) && fs.statSync(file).size >= 1024 * 1024) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, line, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
    } catch (error) {
      try { fs.writeSync(2, `KABO_SKILL_UNPACK ${JSON.stringify({ invocation, event: 'log_write_failed', code: diagnosticCode(error) })}\n`); } catch {}
    }
  };
}

export function diagnosticCode(error) {
  return ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EEXIST', 'ENOSPC', 'EROFS', 'ETIMEDOUT', 'ENOBUFS', 'EIO'].includes(error?.code)
    ? error.code : 'unknown_error';
}
