// Host metadata only. This is a routing guard, not a sandbox or an authorization source.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataRoot, ensurePrivateDir, isSafeName } from './common.js';

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const codex = fs.existsSync(path.join(plugin, '.codex-plugin'));
const contextDir = () => path.join(dataRoot(), 'envelope-staging', '.executors');

export function recordExecutor(event) {
  if (!codex || !isSafeName(event.session_id) || !event.session_id) return;
  const agent = event.agent_id ?? null;
  if (agent !== null && (typeof agent !== 'string' || !agent || !isSafeName(agent))) return;
  try {
    const dir = contextDir();
    ensurePrivateDir(dir);
    fs.writeFileSync(path.join(dir, `${agent ?? event.session_id}.json`),
      JSON.stringify({ session_id: event.session_id, agent_id: agent }), { flag: 'wx', mode: 0o600 });
  } catch { /* Missing hook metadata never breaks envelope staging. */ }
}

export function runnerDispatchError(manifest, operation) {
  if (!codex || manifest?.execution !== 'subagent') return null;
  const overrides = manifest.pipeline_operations;
  const selected = operation !== null && overrides && Object.hasOwn(overrides, operation)
    ? overrides[operation] : manifest.pipeline;
  if (Array.isArray(selected) && selected.length > 0) return null;
  const thread = process.env.CODEX_THREAD_ID;
  if (!thread || !isSafeName(thread)) return null;
  let fd;
  try {
    fd = fs.openSync(path.join(contextDir(), `${thread}.json`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024) return null;
    const context = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (context.session_id !== thread || context.agent_id !== null) return null;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return `This operation requires skill-runner: dispatch an isolated Codex subagent with ${path.join(plugin, 'skills/skill-runner/SKILL.md')} and the verified Skill/task/evidence handoff. No step was run; the main thread must not replace the runner.`;
}
