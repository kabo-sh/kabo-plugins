#!/usr/bin/env node
// 固定只读入口：scope 仅来自 stdin，run/文件路径只由 native attempt 台账决定。
import path from 'node:path';
import { dataRoot } from './lib/common.js';
import { completedReportsForScope } from './lib/host-attempt.js';
const MAX_INPUT = 4096, MAX_OUTPUT = 4 * 1024 * 1024;
try {
  if (process.argv.length !== 2) throw new Error('unexpected_arguments');
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > MAX_INPUT) throw new Error('scope_too_large'); chunks.push(chunk); }
  const scope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!scope || Array.isArray(scope) || typeof scope !== 'object' || Object.keys(scope).length !== 2 || !['session_id','turn_id'].every(k => typeof scope[k] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(scope[k]))) throw new Error('invalid_scope');
  const root = dataRoot();
  const reports = completedReportsForScope({ hostScope: scope, root, workRoot: path.join(root, 'work') }).map(report => ({ runId: report.run_id, path: report.path, sha256: report.sha256, text: report.text }));
  if (reports.length > 16) throw new Error('too_many_reports');
  const body = JSON.stringify({ reports }) + '\n';
  if (Buffer.byteLength(body) > MAX_OUTPUT) throw new Error('snapshot_too_large');
  process.stdout.write(body);
} catch {
  process.stderr.write('Report delivery snapshot could not be read.\n');
  process.exitCode = 1;
}
