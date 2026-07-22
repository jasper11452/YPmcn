# CHG-2026-024 Impact Analysis

```yaml
task_id: CHG-2026-024-RELEASE-3.4.13
status: IMPLEMENTED_LOCAL_HOST_UNVERIFIED
risk_level: medium
approved_spec_version: "mvp-v2 / Skill schemaVersion 2 / Workflow schemaVersion 1 / Local state schemaVersion 20"
runtime_scope: "manual sourcing completion evidence, MCN inquiry lineage, and immediate HITL popup behavior"
production_provider_in_repository: false
```

## Impact

| Domain | Change | Constraint |
| --- | --- | --- |
| Manual sourcing | 成功证据改为 Provider 实际返回的 `excel_file_path` | 只传 `requirement_id,size`；路径缺失或冲突即失败关闭。 |
| Workflow | 手动拓展成为表格导出终态 | 不追加字段选择、排序或二次导出。 |
| MCN recovery | 排序询价 ID 改由同步回收结果提供 | 只复制本轮 `sync_mcn_inquiry_status` 的实际 ID。 |
| HITL | 需要人的节点立即弹窗 | 不以普通文本问句停住等待“继续”。 |
| Provider | 无代码或生产操作 | 插件只消费现有接口返回，不假设 Provider 新字段。 |

## Risk

Provider 未在 `tools/list` 中声明响应结构；插件依据实际调用返回的 `excel_file_path` 做严格运行时校验。若响应缺失该字段，本链会停止并报告证据不足，不会伪造完成。
