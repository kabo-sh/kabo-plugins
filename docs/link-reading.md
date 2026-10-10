# Codex 链接读取

目标：用户原链接 → 确定的取数请求 → 实际媒体类型与有序图片 → 原生视觉输入。模型决定何时读取，业务 Skill 决定如何分析；不在看到任意链接时自动抓取。

`kabo_links.read_link` 是本地、无凭据的 MCP 适配器：

1. 按 URL 区分支持的平台、帖子、账号和官方页；TikTok 照片、视频及短链都使用现有 `tiktok-search/get_video`，接口名不决定媒体类型。不改写 `/photo/` 为 `/video/`。
2. 首次返回确定的 Kabo connector 请求。模型通过现有 Kabo OAuth 连接检查目录就绪、执行请求；平台结果由现有 PostToolUse hook 原样落盘。
3. 再调用读取器，传 hook 暂存目录中的编号 JSON 文件为 `envelope_file`。读取器检查目录、当前线程、大小及摘要，核对 connector/operation 和标准链接的帖子 ID；不接受模型手抄或其他线程文件，不读任何登录材料。
4. 从实际帖子结构读取媒体类型及图片顺序。单批最多4张，缺失图片保留原位置，继续使用 `next_offset`；上游没有可靠总数时完整性为未知。
5. 仅下载指定平台 CDN 的 HTTPS 图片，不跟随跳转，不附带凭据；限制时间及字节，按真实文件格式返回 MCP image 块。functions.exec 调用者须用 `image(block)`转发；把base64/URL放进text不算看图。没有转换器时不支持的格式明确记为缺失。

原生 Codex 的失败 MCP 调用可能不触发 PostToolUse，因而没有暂存文件。此时向读取器传原错误的 `connector_failure`（error_code/request_id）；结果明确标为调用者报告、非验签信封，不产生图片或内容证据，只保留链接的媒体提示和恢复方式。不能借用其他会话文件。

失败不证明格式不支持：404、平台未就绪、图片下载失败分别保留；媒体内容缺失时不能编造逐图判断或把用户要求改成视频链接。照片源失效时要求原图是合理恢复，但须先尝试原链接。

桌面使用同一读取合同的离线副本（`gateway/link-reading`），通过自己的凭据持有进程调用既有平台接口、按回合记账和暂存，并用原生图片编码器限制尺寸。插件采用两步hand-over是因为其OAuth由Codex持有，适配器不能读取或复制凭据。这是宿主差异，不是新增后台接口。

URL及媒体投影源自 Web Agent PR120（3786368）`link-routing.ts`，网络交付由各宿主承担。变更时对照三端的路由与媒体测试；不把任一端通过写成三端验收。此PR仅覆盖Codex插件；Claude业务行为未改。

离线验证：`node --test tests/*.mjs`、`node scripts/plugin-version.mjs --base origin/main --tags`。安装态验证使用隔离Codex home、原生插件安装及签名/撤销流程；固定原问、真实MCP、模型gpt-5.6-luna/medium，正常确认只续“继续”。同版本缓存更新只用于隔离开发，发布由版本检查与负责人合并闸门控制。
