// Shared reading contract; Desktop carries an identical offline copy. No account credentials.
import { identifyPublicLink, tiktokPostMedia, instagramPostMedia } from './link-routing.js';

export const readLinkDefinition = {
  name: 'read_link',
  description: 'Inspect a public social link or official help page before choosing media-specific processing. Routes TikTok/Instagram/YouTube posts and accounts by URL, verifies post media type from details, and delivers ordered photo images. Never replace a photo link with a video link. Read at most 4 images per call: continue at next_offset; completeness may be unknown. If a connector request is returned, execute it through Kabo, then call again with its staged envelope_file. When calling through functions.exec, forward each returned image block with image(block); JSON/text serialization does not deliver image pixels. This reads evidence; business analysis remains with the selected Skill.',
  inputSchema: {
    type: 'object', properties: {
      source_url: { type: 'string', maxLength: 2048 },
      offset: { type: 'integer', minimum: 0, maximum: 127, default: 0 },
      count: { type: 'integer', minimum: 1, maximum: 4, default: 4 },
      envelope_file: { type: 'string', description: 'Plugin only: exact staged JSON path from the Kabo PostToolUse hook, never a hand-written copy.' },
    }, required: ['source_url'], additionalProperties: false,
  },
};
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = value => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) });
const fail = message => ({ isError: true, content: [text(message)] });
const canonicalShareUrl = value => {
  if (typeof value !== 'string' || identifyPublicLink(value).resource_kind !== 'share') return null;
  const url = new URL(value);
  url.hash = '';
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.href;
};

export function connectorEnvelope(result) {
  const structured = record(result).structuredContent;
  const candidates = [result, structured];
  for (const part of record(result).content ?? []) {
    if (part.type === 'text') { try { candidates.push(JSON.parse(part.text)); } catch {} }
  }
  for (const value of candidates) {
    const item = record(value), envelope = record(item.envelope ?? item);
    if (typeof envelope.connector_id === 'string' && typeof envelope.operation === 'string' && typeof envelope.status === 'string') return envelope;
  }
  return null;
}

// Only public platform CDN images; neither arbitrary websites nor redirects receive requests.
export function allowedImageUrl(value) {
  try {
    const u = new URL(value), h = u.hostname.toLowerCase();
    return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      ['cdninstagram.com', 'fbcdn.net', 'tiktokcdn.com'].some(base => h === base || h.endsWith('.' + base)) ||
      u.protocol === 'https:' && !u.username && !u.password && !u.port && ['tiktokcdn-us.com','tiktokcdn-eu.com'].some(base => h === base || h.endsWith('.' + base));
  } catch { return false; }
}
export function imageMime(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
export async function fetchImage(url, fetchFn = fetch, prepareImage) {
  if (!allowedImageUrl(url)) throw new Error('image_host_unsupported');
  const response = await fetchFn(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { accept: 'image/jpeg,image/png,image/webp' } });
  if (!response.ok || response.status >= 300) throw new Error('image_fetch_failed');
  const limit = 8 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit || !response.body) throw new Error('image_too_large');
  const chunks = []; let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new Error('image_too_large'); chunks.push(value); }
  } finally { await reader.cancel().catch(() => {}); }
  let bytes = Buffer.concat(chunks), mime = imageMime(bytes);
  if (prepareImage) { bytes = await prepareImage(bytes, 1024 * 1024); mime = imageMime(bytes); }
  if (!mime) throw new Error('image_format_unsupported');
  if (bytes.length > 1024 * 1024) throw new Error('image_too_large_for_model');
  return { type: 'image', mimeType: mime, data: bytes.toString('base64') };
}

export async function readPublicLink(args, deps = {}) {
  const input = record(args), { source_url, envelope_file } = input;
  const offset = input.offset ?? 0, count = input.count ?? 4;
  if (typeof source_url !== 'string' || source_url.length > 2048) return fail('source_url must be the original HTTPS URL, at most 2048 characters.');
  if (!Number.isInteger(offset) || offset < 0 || offset > 127) return fail('offset must be an integer from 0 to 127. Start at 0; then use next_offset.');
  if (!Number.isInteger(count) || count < 1 || count > 4) return fail({ code: 'invalid_count', message: 'Read at most 4 images per call. Retry this same URL with count: 4, then continue at next_offset; this is not a URL or media-type failure.', retry: { source_url, offset, count: 4, ...(envelope_file ? { envelope_file } : {}) } });
  if (Object.keys(input).some(k => !['source_url','offset','count','envelope_file'].includes(k))) return fail('Only source_url, offset, count and the plugin envelope_file are accepted.');
  const identity = identifyPublicLink(source_url), route = identity.read;
  if (!route) return fail('No supported reading route for this link. Keep the original URL; do not guess a different resource type.');
  let raw;
  try {
    if (envelope_file !== undefined) {
      if (typeof envelope_file !== 'string' || !deps.readEnvelope) return fail('Staged envelopes are unavailable in this host.');
      raw = await deps.readEnvelope(envelope_file);
    } else if (deps.call) {
      const catalogResult = await deps.call('data_connector_catalog', { connector_ids: [route.connector_id] });
      let catalog = record(catalogResult).structuredContent;
      if (!catalog) { for (const part of record(catalogResult).content ?? []) { try { catalog = JSON.parse(part.text); break; } catch {} } }
      const connector = record(catalog).connectors?.find(c => c.connector_id === route.connector_id);
      if (!connector?.ready || !connector.operations?.some(o => o.operation === route.operation && o.implemented)) return fail('The platform reading capability is not ready or implemented.');
      raw = await deps.call('data_connector_run', route);
    }
    else return { content: [text({ identity, status: 'requires_connector', request: { tool: 'data_connector_run', arguments: route }, continuation: 'Execute the request through Kabo, then supply the exact staged envelope_file. Do not hand-copy the result. Check connector readiness before executing.' })] };
  } catch { return fail('Link reading failed. The source availability is unconfirmed; do not infer that the media format is unsupported.'); }
  const envelope = connectorEnvelope(raw);
  if (!envelope || envelope.connector_id !== route.connector_id || envelope.operation !== route.operation) return fail('The result does not match this link reading route.');
  if (!['completed','completed_partial'].includes(envelope.status)) return { content: [text({ identity, status: envelope.status, error_code: envelope.error_code ?? null, limitations: envelope.limitations, missing: 'No usable post content was delivered. This does not establish a format limitation.' })] };
  if (envelope_file !== undefined && identity.platform === 'tiktok' && identity.resource_kind === 'share' &&
      canonicalShareUrl(record(envelope.params).url) !== canonicalShareUrl(source_url)) return fail('The staged result cannot be bound to this TikTok share link. Fetch the original link again and use its envelope with matching params.url.');
  const data = record(envelope.data);
  let media = identity.platform === 'tiktok' && ['post','share'].includes(identity.resource_kind) ? tiktokPostMedia(source_url, data.video) :
    identity.platform === 'instagram' && identity.resource_kind === 'post' ? instagramPostMedia(source_url, data.post) : null;
  if (media && identity.resource_id && media.post_id !== null && media.post_id !== identity.resource_id) return fail('The returned post identity differs from the original link.');
  if (!media) return { content: [text({ identity, source: envelope, note: 'Metadata/text only; no images or video frames were delivered.' })] };
  const slides = media.slides.map(slide => ({ index: slide.index, status: slide.media_url ? 'not_requested' : 'missing' }));
  const content = [], images = [], selected = media.slides.slice(offset, offset + count);
  for (const slide of selected) {
    const status = slides[slide.index - 1];
    if (!slide.media_url) continue;
    try {
      const image = await fetchImage(slide.media_url, deps.fetchFn, deps.prepareImage);
      status.status = 'delivered';
      images.push({ index: slide.index, mime_type: image.mimeType, data: image.data });
      content.push(text(`Slide ${slide.index} of ${media.returned_count} returned positions (total completeness unknown).`), image);
    } catch (error) { status.status = error instanceof Error ? error.message : 'image_fetch_failed'; }
  }
  const { slides: unused, video: unusedVideo, ...summary } = media;
  const delivered = slides.filter(s => s.status === 'delivered').map(s => s.index);
  return { evidence: { schema_version: 'linked-media-evidence.v1', identity, ...summary, source: { connector_id: envelope.connector_id, operation: envelope.operation, request_id: envelope.request_id, retrieved_at: envelope.retrieved_at, raw_sha256: envelope.raw_sha256 }, images }, content: [text({ identity, ...summary, source: { status: envelope.status, retrieved_at: envelope.retrieved_at, limitations: envelope.limitations, evidence_ref: envelope.evidence_ref }, slides, delivered_indices: delivered, next_offset: offset + count < media.slides.length ? offset + count : null,
    missing: media.media_type === 'unknown' ? 'No verified media details. Source failure reason unconfirmed.' : media.media_type === 'video' ? 'Video verified; use its transcript/frame capability if required.' : delivered.length < selected.length ? 'Some requested images were not delivered; leave their contents unassessed.' : null }), ...content] };
}
