import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { readPublicLink, allowedImageUrl } from '../plugins/codex/kabo-alpha/scripts/lib/link-reader.js';
import { identifyPublicLink } from '../plugins/codex/kabo-alpha/scripts/lib/link-routing.js';
import { handleRpc, readStagedEnvelope } from '../plugins/codex/kabo-alpha/scripts/link-server.js';
const url = 'https://www.tiktok.com/@example/photo/12345';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64');
const envelope = { connector_id: 'tiktok-search', operation: 'get_video', status: 'completed', limitations: [], data: { video: { aweme_id:'12345', aweme_type:150, author:{unique_id:'example'}, image_post_info:{images: Array.from({length:9}, (_,i)=>({display_image:{url_list: i===4?[]:[`https://p16.tiktokcdn-us.com/${i}.jpg`]}}))} } } };
const readEnvelope = async () => envelope;
const fetchFn = async () => new Response(png);
const parse = r => JSON.parse(r.content[0].text);

test('URL分流保持photo、短链、视频、账号和官方页区别，拒绝伪装域名', () => {
  for (const value of [url,'https://vt.tiktok.com/abc/','https://www.tiktok.com/@example/video/12345']) assert.equal(identifyPublicLink(value).read.connector_id,'tiktok-search');
  assert.equal(identifyPublicLink(url).media_type_hint,'image_carousel');
  assert.equal(identifyPublicLink('https://vt.tiktok.com/abc/').resolved_url,null);
  assert.equal(identifyPublicLink('https://www.instagram.com/p/abc/').media_type_hint,'unknown');
  assert.equal(identifyPublicLink('https://youtu.be/abcdefghijk').read.params.video_id,'abcdefghijk');
  assert.equal(identifyPublicLink('https://www.tiktok.com/@example').resource_kind,'account');
  assert.equal(identifyPublicLink('https://support.tiktok.com/en/account').platform,'official_page');
  for(const value of ['https://tiktok.com.evil.test/@example/photo/12345','http://www.tiktok.com/@example/photo/12345','https://user@www.tiktok.com/@example/photo/12345']) assert.equal(identifyPublicLink(value).read,null);
});
test('插件先返回确定性取数请求，拿到信封后才交付图像', async () => {
  const planned=parse(await readPublicLink({source_url:url}));
  assert.equal(planned.status,'requires_connector'); assert.equal(planned.request.arguments.params.url,url);
  const r=await readPublicLink({source_url:url,envelope_file:'fixture'}, {readEnvelope,fetchFn});
  assert.equal(r.content.filter(p=>p.type==='image').length,4);
  assert.deepEqual(parse(r).delivered_indices,[1,2,3,4]); assert.equal(parse(r).next_offset,4); assert.equal(parse(r).completeness,'unknown');
  const second=await readPublicLink({source_url:url,envelope_file:'fixture',offset:4}, {readEnvelope,fetchFn});
  assert.deepEqual(parse(second).delivered_indices,[6,7,8]); assert.equal(parse(second).slides[4].status,'missing'); assert.equal(parse(second).next_offset,8);
});
test('照片实际结构覆盖video路径提示；身份不符和404不产生图片',async()=>{
  const r=await readPublicLink({source_url:url.replace('/photo/','/video/'),envelope_file:'fixture'},{readEnvelope,fetchFn});
  assert.equal(parse(r).media_type,'image_carousel');
  const wrong=await readPublicLink({source_url:url.replace('12345','99999'),envelope_file:'fixture'},{readEnvelope,fetchFn}); assert.equal(wrong.isError,true);
  const missing=await readPublicLink({source_url:url,envelope_file:'fixture'},{readEnvelope:async()=>({...envelope,status:'failed',error_code:'not_found'}),fetchFn});
  assert.notEqual(missing.isError,true); assert.equal(parse(missing).error_code,'not_found'); assert.equal(missing.content.some(p=>p.type==='image'),false);
});
test('下载有界、不跟随跳转、不向任意主机请求，失败保留原位置',async()=>{
  assert.equal(allowedImageUrl('https://127.0.0.1/a.jpg'),false);
  assert.equal(allowedImageUrl('https://p16.tiktokcdn-evil.com/a.jpg'),false);
  assert.equal(allowedImageUrl('https://p16.tiktokcdn-us.com/a.jpg'),true);
  let options;
  const result=await readPublicLink({source_url:url,envelope_file:'fixture',count:1},{readEnvelope,fetchFn:async(_,o)=>{options=o;return new Response('redirect',{status:302});}});
  assert.equal(options.redirect,'manual'); assert.equal(parse(result).slides[0].status,'image_fetch_failed'); assert.equal(parse(result).delivered_indices.length,0);
  const html=await readPublicLink({source_url:url,envelope_file:'fixture',count:1},{readEnvelope,fetchFn:async()=>new Response('<html>bad</html>')});assert.equal(parse(html).slides[0].status,'image_format_unsupported');
});
test('桌面自动读取先检查真实目录就绪；未就绪不请求帖子',async()=>{
  const calls=[];
  const r=await readPublicLink({source_url:url},{call:async(name,args)=>{calls.push([name,args]);return {structuredContent:{connectors:[]}};},fetchFn});
  assert.equal(r.isError,true); assert.deepEqual(calls.map(c=>c[0]),['data_connector_catalog']);
});
test('原生stdio协议与暂存路径边界，不读取其他线程和摘要被改写的文件',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'kabo-link-test-'));
  try {
    const dir=path.join(root,'envelope-staging','thread-a');await fs.mkdir(dir,{recursive:true});
    const file=path.join(dir,'01.json'), body=Buffer.from(JSON.stringify(envelope)); await fs.writeFile(file,body);
    await fs.writeFile(file.replace('.json','.meta'),JSON.stringify({bytes:body.length,sha256:crypto.createHash('sha256').update(body).digest('hex')}));
    assert.deepEqual(await readStagedEnvelope(file,root,'thread-a'),envelope);
    await assert.rejects(readStagedEnvelope(file,root,'thread-b'));
    const result=await handleRpc({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read_link',arguments:{source_url:url,envelope_file:file,count:1},_meta:{threadId:'thread-a'}}},{root,fetchFn});
    assert.equal(result.result.content[1].text.startsWith('<untrusted_data'),true);
    assert.equal(result.result.content[2].type,'image');
    await fs.writeFile(file,'{}');await assert.rejects(readStagedEnvelope(file,root,'thread-a'));
    assert.equal((await handleRpc({id:2,method:'tools/list'})).result.tools[0].name,'read_link');
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('单批超限返回原URL的可执行修复，不误报为链接不支持',async()=>{
  const result=await readPublicLink({source_url:url,count:10});
  const error=parse(result); assert.equal(error.code,'invalid_count'); assert.deepEqual(error.retry,{source_url:url,offset:0,count:4});
});

test('原生MCP失败无hook文件时显式交接错误，不读取其他线程，不更换媒体类型',async()=>{
  const rpc=args=>handleRpc({id:10,method:'tools/call',params:{name:'read_link',arguments:args}});
  const result=await rpc({source_url:url,connector_failure:{error_code:'not_found',request_id:'req-example'}});
  const data=JSON.parse(result.result.content[0].text.split('\n')[1]);
  assert.notEqual(result.result.isError,true);assert.equal(data.status,'reported_connector_failure');assert.equal(data.media_type_verified,false);
  assert.equal(data.images_delivered,0);assert.match(data.recovery,/ordered original images/);
  assert.equal((await rpc({source_url:url,envelope_file:'/other/thread/01.json',connector_failure:{error_code:'not_found'}})).result.isError,true);
  assert.equal((await rpc({source_url:'https://evil.example',connector_failure:{error_code:'not_found'}})).result.isError,true);
});
