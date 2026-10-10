import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Host-produced evidence, never an account connector or a model-authored envelope.
export function stageLinkEvidence(root, threadId, evidence) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(threadId ?? '')) throw new Error('missing_thread_identity');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const dataRoot = fs.realpathSync(root);
  const parent = path.join(dataRoot, 'envelope-staging');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(parent) !== parent) throw new Error('unsafe_staging_directory');
  const dir = path.join(parent, threadId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(dir) !== dir) throw new Error('unsafe_staging_directory');
  const body = JSON.stringify(evidence);
  if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error('link_evidence_too_large');
  const meta = JSON.stringify({ schema_version: evidence.schema_version,
    bytes: Buffer.byteLength(body), sha256: crypto.createHash('sha256').update(body).digest('hex'),
    verbatim: true, staged_at: new Date().toISOString() });
  for (let n = 1; n < 10000; n++) {
    const stem = path.join(dir, String(n).padStart(2, '0'));
    let lock;
    try { lock = fs.openSync(stem + '.lock', 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    let bodyWritten = false;
    try {
      fs.writeSync(lock, `${process.pid} ${crypto.randomUUID()}\n`);
      if (['.json', '.meta', '.art'].some(ext => fs.existsSync(stem + ext))) continue;
      fs.writeFileSync(stem + '.json', body, { flag: 'wx', mode: 0o600 });
      bodyWritten = true;
      fs.writeFileSync(stem + '.meta', meta, { flag: 'wx', mode: 0o600 });
      return { directory: dir, file: stem + '.json' };
    } catch (error) {
      if (bodyWritten) fs.unlinkSync(stem + '.json');
      throw error;
    } finally { fs.closeSync(lock); fs.unlinkSync(stem + '.lock'); }
  }
  throw new Error('link_evidence_staging_full');
}
