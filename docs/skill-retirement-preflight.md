# 插件下线前置验证（草稿，禁止合并）

本 PR 只新增仓库外层测试与 CI，不改安装 payload、prompt、版本或用户缓存。不需要发布新 Plugin 版本。

`node --test tests/skill-retirement.mjs` 在临时目录和本地 HTTP 服务上执行真实 Claude/Codex SessionStart hook，覆盖：

- 目录中有旧 Skill、目录移除旧 Skill、目录为空、服务不可用时，原缓存字节保留且不创建禁用标记。
- 其他 Skill 的缓存不变，目录仍可提示其可更新。
- 明确 revocation 才删除目标缓存并禁用；离线不撤销禁用，服务端撤回 revocation 后清除标记，但不凭空恢复已删除缓存。
- 动态 guidance 不可用时输出兜底提示，不注入未验证内容；只向本地服务发无 Authorization 的 GET。

缓存是合成哨兵文件，未声称通过签名或可执行。这些测试不是已安装插件的模型路由、业务执行或完整 E2E，也没有验证有效动态 guidance 的模型遵从性。

下线是频道目录操作，不是全局 revocation。插件安装 payload 的 `used_by` 引用可能仍用于其他频道或历史缓存，不能为了清理 Internal 下线而删除共享连接器。

## 后续顺序

先完成两个 repo 的 Review/CI 与 internal repo 下线 workflow 门禁；如有实际运行时改动，先发布并验证新旧共存，再获得确认修改 GCS。写入后回读服务侧搜索/下载及其他 Skill，完成安装态 E2E。当前两端 PR 均不得合并，下线未执行。
