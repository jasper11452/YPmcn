# CHG-2026-019 Impact Analysis

```yaml
task_id: CHG-2026-019-RUNTIME-ID-AND-SUPPLY-CONTRACT
status: IMPLEMENTED_LOCAL_HOST_BLOCKED
risk_level: medium
approved_spec_version: "mvp-v2 / MCP schemaVersion 1 / Hook schemaVersion 6"
runtime_scope: "plugin contract, Skill, prompt, session-scoped Hook receipts and local orchestration projection"
production_provider_in_repository: false
```

## Impact

| Domain | Change | Constraint |
| --- | --- | --- |
| MCP | 固定 `data.id` 主键，主读搜索供给 v2 并短期双读旧形状 | 不改变 Provider 输入字段；冲突响应不猜测。 |
| Requirement | 绑定完整原始 Brief 的哈希，多平台拆单保持同源 | 不保存 Brief 正文，不追加重试或去重标记。 |
| Hook | 分离搜索与手扒回执，手扒要求同会话上下文 | 当前缺上下文宿主返回 `INTEGRATION_REQUIRED`。 |
| Workflow | 显式手扒续接优先，状态格式升级至 v19 | 旧回执迁移时清除，既有完成 phase 不回退。 |
| Skill / UX | 统一问题数量与选项规则，隐藏内部价格档位名 | 只使用平台可理解的内容形式/时长措辞。 |
| Release | 补丁版本升级为 3.4.9 | 旧搜索形状兼容仅保留本版本。 |

## Compatibility And Rollout

- 当前搜索响应 `total_matched + supply_assessment` 是主契约；旧 `demand_count/eligible_creator_count/supply_ratio` 仅在 3.4.9 双读，下一版本可移除。
- v18 本地状态迁移到 v19 时清除旧授权回执，保留已完成工作流 phase，避免跨版本回执误授权。
- 旧宿主缺少 `before_tool_call` 会话上下文时，搜索仅执行非授权的主键形状检查，手扒与外发继续 fail-closed。
- 不触碰日志中已产生的远程重复需求；若后续需要清理，必须另行授权并使用 Provider 权威证据。

## Verification

本地回归覆盖 ID 命名空间纠正、回执不误消费、上下文缺失阻断、Brief 篡改、多平台同源、搜索新旧双读冲突、手扒续接路由以及 v18→v19 迁移。未以本地测试冒充宿主升级或生产 Provider 写入证据。
