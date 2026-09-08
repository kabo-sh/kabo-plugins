# 插件下线前置验证（本测试 PR 评审通过后由负责人合并）

本 PR 只新增仓库外层测试与 CI，不改安装 payload、prompt、版本或用户缓存。不需要发布新 Plugin 版本。

`node --test tests/skill-retirement.mjs` 在临时目录和本地 HTTP 服务上执行真实 Claude/Codex SessionStart hook，覆盖：

- 目录中有旧 Skill、目录移除旧 Skill、目录为空、服务不可用时，原缓存字节保留且不创建禁用标记。
- 其他 Skill 的缓存不变，目录仍可提示其可更新。
- 明确 revocation 才删除目标缓存并禁用；离线不撤销禁用，服务端撤回 revocation 后清除标记，但不凭空恢复已删除缓存。
- 动态 guidance 不可用时输出兜底提示，不注入未验证内容；只向本地服务发无 Authorization 的 GET。

缓存是合成哨兵文件，未声称通过签名或可执行。这些测试不是已安装插件的模型路由、业务执行或完整 E2E，也没有验证有效动态 guidance 的模型遵从性。

下线是频道目录操作，不是全局 revocation。插件安装 payload 的 `used_by` 引用可能仍用于其他频道或历史缓存，不能为了清理 Internal 下线而删除共享连接器。

## 后续顺序

本测试 PR 完成本地测试、版本检查、CI 和 CodeRabbit 评审后，可以由负责人合并；代理不代合并，也不开启自动合并。

这是两个独立的门禁：internal repo 的下线 workflow、发布身份、安全恢复、防重上架、频道集合例外，以及后续后台/安装态业务验收，是实际修改 GCS 前必须完成的条件，不阻止本测试 PR 合入。若另有运行时改动，先发布并验证新旧共存，再获得当次确认修改 GCS；写入后仍需回读服务侧搜索/下载、其他 Skill 和 Production。下线尚未执行。

## 合入前隔离验证记录（2026-09-08）

Node 22.22.0，Claude/Codex 各一条连续生命周期测试，2/2 通过。每端依次测试 listed、removed、empty、offline、revoked、offline、withdrawn 共 7 个状态。

在独立工作区两端真实 hook 临时注入错误后复跑，随后立即还原：

| 故意注入的错误 | 实测 |
| --- | --- |
| 把 catalog 缺席当成 revocation | 两端均失败：测试能抓住误删缓存 |
| 离线时清空 revocation 标记 | 两端均失败：测试能抓住安全撤销被误清 |

还原后 `git diff --exit-code -- plugins` 为零，原套件再次 2/2 通过。注入代码没有提交，也没有触碰真实用户缓存或外部服务。

本 PR 合入门：上述测试、版本检查、CI、CodeRabbit 实际评审完成，由负责人合并。下线 workflow、安全恢复及业务安装态 E2E 属于 GCS 下线前另行满足的门禁，不因本测试 PR 通过而自动放行。
