# 链接读取的真实上游样本

来自 Kabo 后台接口的真实返回（2026-10-12/13 三端验收时保存），只裁剪掉了读取代码用不到的字段，并去掉了 CDN 地址的签名参数，字段名和取值保持原样。

| 文件 | 接口 | 内容 |
|---|---|---|
| tiktok-photo-2.json | tiktok-search/get_video | 2 张图的图文帖（N0355） |
| tiktok-photo-9.json | tiktok-search/get_video | 9 张图的图文帖（N0074 短链） |
| tiktok-video.json | tiktok-search/get_video | 普通视频 |
| instagram-sidecar-xdt.json | instagram-discovery/get_post | 5 张图的多图帖，XDT 世代类型名 |
| instagram-reel-xdt.json | instagram-discovery/get_post | Reels，XDT 世代类型名 |

改读取代码时不要手改这些样本去迁就代码；上游格式变化时，用新的真实返回替换或新增样本。
