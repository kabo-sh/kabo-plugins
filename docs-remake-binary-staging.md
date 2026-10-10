# 复刻材料分块：后台媒体交付候选

本候选沿用既有 PostToolUse、私有分块落盘和 `kabo-save-envelope`，同步后台媒体文件的精确类型。制作方案、来源 job、分析和 QC JSON 继续保存在原信封里；不新增上传入口、登录流程、素材库或任务中心。

提供方 [kabo PR #1324](https://github.com/kabo-sh/kabo/pull/1324) 的独立制品固定到 `100974c1e6b8b233804581482fa8569b21ab748e`，摘要 `a5c2edc074ecdfc94d05539fb815fedcc9431a13d21599de991abdef380816a2`。`source=media` 复用同一个下载工具，以本用户持有的 job、索引和偏移读取后台结果。

新增 `final_video/video/mp4` 与 `editable_pack/application/zip` 各自上限200MiB；候选帧 `image/image/png|image/jpeg` 与原文本诊断 `report/text/plain` 保持20MiB。JSON 文档直接放在 `data.documents`。原 `source_video` 仍200MiB、索引≤13，其他旧文件仍20MiB，单块仍4MiB。类型、MIME、任务配对、范围、长度和摘要不符时拒绝保存；二进制正文不进入模型或遥测。

Claude 与 Codex 随包合同逐字节一致，直接执行已固定 schema；未知关键词或歧义分支仍拒绝。候选版本0.21.21，七版本字段一致，仅提交到候选分支，不代表已合入主线、后台已部署或生产发布。

回归覆盖新类型的合法边界、越界和错 MIME、旧限制、跨任务、损坏合同、歧义 oneOf，以及现有签名/撤销/分阶段执行。单块测试不代表200MiB文件性能或真实成片验收；两宿主实际后端联调、效果与安装包验证分别继续推进，验收通过前保留原本地媒体环境。
