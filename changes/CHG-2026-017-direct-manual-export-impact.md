# CHG-2026-017 Impact Analysis

```yaml
task_id: CHG-2026-017-DIRECT-MANUAL-EXPORT
status: IMPLEMENTED_LOCAL_PROVIDER_BLOCKED
risk_level: high
approved_spec_version: "mvp-v2 / schemaVersion 1"
runtime_scope: "local contract, packaged Skill, prompt and local orchestration projection"
production_provider_in_repository: false
```

## Impact

| Domain | Change | Constraint |
| --- | --- | --- |
| MCP | 对齐字段选择、手扒、排序输入，并定义三参数导出目标 | 只传契约字段；数值型业务量以正整数十进制字符串传输。 |
| Workflow | 增加字段选择优先的四步直接链 | 任一步失败都不得调用下一业务 Tool。 |
| Skill / Prompt | 删除旧的赛马、询价回收和宿主 CSV 导出前置 | 字段、需求、数量和批次号均复用本轮已确认值。 |
| Hook state | 记录字段选择后的下一步、手扒返回的询价集合和导出完成态 | 本地状态不伪造 Provider 成功；未知写结果不盲重试。 |
| Database boundary | 手扒按需求直接生成询价结果，排序去重后按需求/数量/批次导出 | Provider 的事务、幂等和文件生成不在本仓库。 |
| Tests | 锁定调用顺序、必填参数、旧参数拒绝和状态推进 | 不调用生产写 Tool。 |

## Compatibility And Rollout

- `manual_source_creators.target_count` 与 `create_submission_batch.run_id` 从新链路移除，属于破坏性输入变更。
- 当前 Provider 已发布 `manual_source_creators(requirement_id,size)` 与以 `inquiry_ids` 为唯一必填项的 `rank_creators`。
- 当前 Provider 尚未发布三参数 `create_submission_batch`；发布前生产只读契约门禁预期失败，不得自动回退旧 `run_id`。
- 旧赛马/企微工具仍保留在 MCP 工具目录，但不属于本次手扒导出主链。

## Verification

本地契约、Hook 回放、Skill 校验与完整离线门禁均已通过。生产 Provider 只读比较器确认字段选择、手扒和排序输入已对齐，但三参数导出仍未部署；生产导出继续阻断，不自动回退旧 `run_id`。
