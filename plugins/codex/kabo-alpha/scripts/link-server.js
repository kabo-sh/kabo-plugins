#!/usr/bin/env node
// Local evidence adapter. Account OAuth remains exclusively in the host's existing Kabo connection.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createInterface } from 'node:readline';
import { dataRoot } from './lib/common.js';
import { readLinkDefinition, readPublicLink } from './lib/link-reader.js';

export async function readStagedEnvelope(file, root, threadId) {
  if (typeof threadId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(threadId)) throw new Error('missing_thread_identity');
  const base = await fs.realpath(path.join(root, 'envelope-staging'));
  const resolved = await fs.realpath(file), relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.split(path.sep).slice(0, -1).includes(threadId) || !/^\d{2,}\.json$/.test(path.basename(resolved))) throw new Error('invalid_staged_path');
  const handle = await fs.open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  let body;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('invalid_staged_file');
    body = await handle.readFile();
  } finally { await handle.close(); }
  const meta = JSON.parse(await fs.readFile(resolved.replace(/\.json$/, '.meta'), 'utf8'));
  if (meta.bytes !== body.length || meta.sha256 !== crypto.createHash('sha256').update(body).digest('hex')) throw new Error('staged_digest_mismatch');
  return JSON.parse(body.toString('utf8'));
}

const toolDefinition = {
  ...readLinkDefinition,
  inputSchema: {
    ...readLinkDefinition.inputSchema,
    properties: {
      ...readLinkDefinition.inputSchema.properties,
      connector_failure: {
        type: 'object', description: 'Native Kabo MCP failure with no PostToolUse staging: report only its error_code/request_id. Never use another conversation’s envelope.',
        properties: { error_code: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' }, request_id: { type: 'string', maxLength: 128 } },
        required: ['error_code'], additionalProperties: false,
      },
    },
  },
};

async function reportedFailure(args) {
  const { connector_failure: failure, ...input } = args;
  if (!failure || typeof failure !== 'object' || !/^[A-Za-z0-9_-]{1,64}$/.test(failure.error_code) ||
      Object.keys(failure).some(k => !['error_code', 'request_id'].includes(k)) ||
      failure.request_id !== undefined && (typeof failure.request_id !== 'string' || failure.request_id.length > 128) || input.envelope_file !== undefined)
    return { isError: true, content: [{ type: 'text', text: 'Invalid failure handoff. Use this call’s native error_code/request_id, without an envelope file.' }] };
  const plan = await readPublicLink(input);
  if (plan.isError) return plan;
  const { identity } = JSON.parse(plan.content[0].text);
  return { content: [{ type: 'text', text: JSON.stringify({
    identity, status: 'reported_connector_failure', error_code: failure.error_code, request_id: failure.request_id ?? null,
    media_type_verified: false, images_delivered: 0,
    recovery: identity.media_type_hint === 'image_carousel'
      ? 'The supplied URL denotes a photo post. Request its ordered original images/screenshots and caption; do not ask for a video URL.'
      : 'Request the original post media without changing its type.',
    limitation: 'Failure metadata reported by the caller, not a verified staged envelope. Source failure does not establish a format limitation.',
  }) }] };
}

export async function handleRpc(request, deps = {}) {
  const { id, method, params = {} } = request;
  if (id === undefined) return null;
  let result;
  if (method === 'initialize') result = { protocolVersion: params.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'kabo-link-reader', version: '1.0.0' } };
  else if (method === 'ping') result = {};
  else if (method === 'tools/list') result = { tools: [toolDefinition] };
  else if (method === 'tools/call' && params.name === 'read_link') {
    result = params.arguments?.connector_failure !== undefined ? await reportedFailure(params.arguments) : await readPublicLink(params.arguments, { ...deps, readEnvelope: file => readStagedEnvelope(file, deps.root ?? dataRoot(), params._meta?.threadId) });
    result.content = result.content.map(part => part.type === 'text' ? { ...part, text: '<untrusted_data source="read_link">\n' + part.text.replace(/<\/?\s*untrusted_data/gi, value => value.replace('<', '‹')) + '\n</untrusted_data>' } : part);
  } else return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  return { jsonrpc: '2.0', id, result };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let active = 0;
  for await (const line of lines) {
    if (Buffer.byteLength(line) > 16 * 1024) continue;
    let request; try { request = JSON.parse(line); } catch { continue; }
    if (active >= 4) { if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'Too many active link reads' } }) + '\n'); continue; }
    active++;
    handleRpc(request).then(response => { if (response) process.stdout.write(JSON.stringify(response) + '\n'); }).catch(() => {
      if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'Link reader failed' } }) + '\n');
    }).finally(() => { active--; });
  }
}
