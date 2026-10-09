# 复刻材料分块落盘（候选，尚未发布）

目标只是让既有宿主保存后台准备的声音 / 首帧，不增加上传、通用文件系统或生成平台。hook 不联网、不读凭据、不走遥测，正文不进入 additionalContext 或可见信封。

提供方候选：kabo PR #1287 的 `creator_remake_artifact`。它只取当前用户已完成的历史材料任务，在普通返回中给出任务、文件与分块清单；正文在宿主 `_meta` 字段中交接。插件校验双方清单、分块范围及摘要，以私有文件保存，再复用 `kabo-save-envelope` 移入当前 run。Skill 按清单拼接并校验整文件，不能让模型重抄正文。

协议来自提供方实际 schema / 策略 / 公开静音样例；固定 commit 与摘要记在 `contracts-snapshot/kabo/pin.json`。两端随包副本逐字节一致，运行时从制品校验形状，不手抄第二份。只有显式刷新访问 GitHub；普通验证不查远端源码、Actions 或部署：

```bash
node scripts/remake-contract-snapshot.mjs --verify
node scripts/remake-contract-snapshot.mjs --refresh --commit <provider-commit>
```

缺失或损坏的协议副本会拒绝新二进制，原有信封落盘继续工作；已覆盖该行为和损坏、越界、跨任务、正文缺失等拒绝路径。当前新增的 11 项本地检查通过。普通完整测试有一个现存路径容量夹具在 macOS 上创建超过系统长度上限，失败为 ENAMETOOLONG；换短临时根仍失败。未修改该断言，本提交的 Linux CI 单独核验，不拿此前 44 项通过记录代替当前提交。

联合验证：后台实际分块 → 两端候选 hook / drain → Skill 重组，8 个合成声音 / 首帧整文件一致。原生 Codex 0.161 / gpt-5.6-luna / medium 项目 hook 此前已通过正常审核；协议更新后的复测另记，不能把旧夹具放行记录当作新协议验收。Claude 原生探针被当前组织的 Claude Code 订阅限制挡在工具调用前，未修改登录或改用其他凭据。

以上都不是 Registry 安装验签、服务部署或真实付费成片。新版版本为 0.21.9；需要宿主正常审核并加载改变的 hook，不绕过签名或撤销。跨版本联合探针只在显式验证时运行，不作为普通构建的跨仓前置。尚未发布 Internal。
