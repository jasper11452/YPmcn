# CHG-2026-023 Impact Analysis

```yaml
task_id: CHG-2026-023-RELEASE-3.4.12
status: IMPLEMENTED_LOCAL_HOST_UNVERIFIED
risk_level: medium
approved_spec_version: "mvp-v2 / Skill schemaVersion 2 / Workflow schemaVersion 1 / Local state schemaVersion 20"
runtime_scope: "direct export tool lineage, success evidence, unknown-write state, and host aliases"
production_provider_in_repository: false
```

## Impact

| Domain | Change | Constraint |
| --- | --- | --- |
| Release | 新增不可变 `3.4.12` tgz | 不覆盖 `3.4.11` 产物。 |
| Tool order | 排序与导出进入 before-hook 强门禁 | 乱序调用和跨轮参数 fail closed。 |
| Evidence | 字段、排序、导出只在有效业务证据下推进 | 通用 `success: true` 不能替代业务证据。 |
| State | 本地状态升级至 schema v20 | 未知写进入 `reconcile_*`，失败事件也递增序号。 |
| Host | 支持 OpenCode 风格工具名、`sessionID` 与 `callID` | 不放宽 ID、确认或会话隔离规则。 |
| Provider | 无生产操作 | 三参数导出契约仍需生产部署验证。 |

## Verification

发布前运行完整仓库验证、可复现包内容测试、tgz 密钥扫描与 Git 差异检查。
