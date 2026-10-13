import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { identifyPublicLink, instagramPostMedia, tiktokPostMedia } from '../plugins/codex/kabo-alpha/scripts/lib/link-routing.js';
import { readPublicLink } from '../plugins/codex/kabo-alpha/scripts/lib/link-reader.js';

// 这些断言针对后台真实返回（与 Web 共用同一批样本）；失败时先怀疑读取代码，不要改样本迁就代码。
const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/link-payloads/${name}.json`, import.meta.url), 'utf8'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64');

test('真实 TikTok 图文帖与视频：类型、张数、JPEG 选择', () => {
  for (const [name, count] of [['tiktok-photo-2', 2], ['tiktok-photo-9', 9]]) {
    const post = tiktokPostMedia('https://vt.tiktok.com/Example/', fixture(name).data.video);
    assert.equal(post.media_type, 'image_carousel');
    assert.equal(post.slides.length, count);
    assert.ok(post.slides.every(s => s.fetch_status === 'available' && /\.jpe?g$/i.test(s.media_url ?? '')));
  }
  const video = tiktokPostMedia('https://www.tiktok.com/@nexy741/video/7686371296120147222', fixture('tiktok-video').data.video);
  assert.equal(video.media_type, 'video');
  assert.equal(video.slides.length, 0);
});

test('真实 Instagram 多图帖与 Reels（XDT 世代）：类型、张数、评论与播放数', () => {
  const sidecar = instagramPostMedia('https://www.instagram.com/p/DZ6HAQUAQDX/', fixture('instagram-sidecar-xdt').data.post);
  assert.equal(sidecar.media_type, 'image_carousel');
  assert.deepEqual(sidecar.slides.map(s => s.fetch_status), Array(5).fill('available'));
  assert.equal(sidecar.metrics.comments, 1);
  const reel = instagramPostMedia('https://www.instagram.com/reel/DZYr1DsjUDV/', fixture('instagram-reel-xdt').data.post);
  assert.equal(reel.media_type, 'video');
  assert.equal(reel.metrics.views, 177);
});

test('真实 Instagram 多图帖经 read_link 交付原生图片', async () => {
  const source_url = 'https://www.instagram.com/p/DZ6HAQUAQDX/';
  const envelope = { ...fixture('instagram-sidecar-xdt'), status: 'completed', limitations: [] };
  const result = await readPublicLink({ source_url, envelope_file: 'fixture' }, { readEnvelope: async () => envelope, fetchFn: async () => new Response(png) });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.media_type, 'image_carousel');
  assert.equal(result.content.filter(p => p.type === 'image').length, 4);
  assert.equal(body.next_offset, 4);
});

test('带用户名的 Instagram 帖子地址与点号开头的 TikTok 用户名', () => {
  const ig = identifyPublicLink('https://www.instagram.com/creator.name/p/DZ6HAQUAQDX/?img_index=2');
  assert.equal(ig.resource_kind, 'post');
  assert.deepEqual(ig.read, { connector_id: 'instagram-discovery', operation: 'get_post', params: { url: 'https://www.instagram.com/p/DZ6HAQUAQDX/' } });
  assert.equal(identifyPublicLink('https://www.tiktok.com/@..blu3est4r_.r4ntz/video/7681696961962970382').resource_kind, 'post');
  assert.equal(identifyPublicLink('https://www.tiktok.com/@.creator').read, null);
});
