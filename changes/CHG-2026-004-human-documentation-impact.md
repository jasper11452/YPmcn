# CHG-2026-004 Impact Analysis

```yaml
task_id: CHG-2026-004
status: ANALYZED
risk_level: low
approved_spec_version: "mvp-v2 / schemaVersion 1"
```

## Domain Impact

| Domain | Change | Evidence / Constraint |
| --- | --- | --- |
| Database | No | 不改 Schema、writer ownership、不变量或证明状态。 |
| MCP | No | 不改 Tool、输入输出、错误和副作用。 |
| Skill / Hook | No | 不改路由、事件、守卫或状态投影。 |
| Workflow / Error | No | 不改阶段、转换、恢复或重试语义。 |
| Algorithm | No | 继续显示 `external-unverified`，不生成规则定义。 |
| Documentation | Yes | 新增三个人类入口及自动事实区块。 |
| Tooling | Yes | 新增确定性同步脚本和检查命令。 |
| Test | Yes | 新增两项文档治理测试并接入统一门禁。 |
| Packaging | No | 人类文档和同步脚本不进入插件发布包。 |

## Generated Facts

- Spec 摘要由 manifest、正式契约与 compatibility profile 的原始内容共同计算 SHA-256；任一内容变化都会改变摘要。
- 项目地图的领域路径来自 `manifest.contracts`，说明文字只解释责任，不复制 Schema。
- 演进索引来自 `changes/CHG-*.md` 的标题与状态；Impact Analysis 不重复列入。
- 生成器只替换明确 marker 之间的区块，marker 外人工内容保持不变。

## Risks And Mitigations

| Risk | Level | Mitigation |
| --- | --- | --- |
| 文档成为第二份 Spec | Medium | 自动区块只放摘要和链接；所有契约细节仍指向 `spec/`。 |
| 自动同步掩盖人工叙事过期 | Low | AGENTS/开发流程要求同步后人工复核；测试只保证机器事实，不宣称替代审阅。 |
| 文档持续膨胀 | Low | 测试设置行数上限并检查入口层级。 |
| 脚本误改人工内容 | Low | 仅替换唯一 marker 区块；缺失或重复 marker 时 fail closed。 |
| Spec 变化未触发同步 | Low | `verify:docs` 比较期望生成区块与当前文件，统一 `verify` 强制执行。 |

## Compatibility And Rollback

- 只使用 Node.js 内置模块，无新增依赖或锁文件变化。
- 现有根 workspace 安装、组件构建、CI 意图和发布包内容不变。
- 回滚只需 revert 文档、脚本、测试和根命令变更；不涉及数据、生产配置或业务状态。

## Open Questions

无。文档默认使用中文，机器标识、路径和命令保持原文以便精确定位。
