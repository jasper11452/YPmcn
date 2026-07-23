# CHG-2026-026 Impact Analysis

```yaml
task_id: CHG-2026-026-LAST-APPROVED-EXTERNAL-SEND
status: IMPLEMENTED_LOCAL_VERIFIED
risk_level: high
approved_spec_version: "mvp-v2 / Skill schemaVersion 2 / Workflow schemaVersion 1 / Local state schemaVersion 21"
runtime_scope: "external-send AskUserQuestion callback lifecycle and patch release metadata"
production_provider_in_repository: false
```

## Impact

| Domain | Change | Constraint |
| --- | --- | --- |
| External confirmation | 最近一次已确认回执直接授权下一次外发 | 不再比较弹窗前后参数指纹；回执必须是最新、已弹窗、已确认、未过期且尚未消费。 |
| User impact | 消除跨 turn 回调后因参数指纹不一致而反复弹窗的死循环 | 一个确认可能授权不同的消息、字段或机构参数；这是用户明确选择的行为放宽。 |
| State | 记录原确认与实际执行的 SHA-256 指纹及脱敏摘要 | 不保存消息正文、供应商 ID 或完整 payload。 |
| Safety | 继续限制为一次、10 分钟、同一状态作用域并受文件锁保护 | 取消、拒绝、过期、重复消费、并发锁冲突和未知外发结果仍不放行。 |
| Provider | 无接口、数据库或真实发送变更 | 首次预检仍在本地完成，Provider 仅在已授权的下一次调用时触达。 |
| Release | 统一补丁版本为 `3.4.23` 并生成新 tgz | 不覆盖、不删除既有发布包。 |

## Verification

回归覆盖“预检 → 弹窗 → 用户下一 turn 确认 → 参数改变后单次授权”的完整 Hook 生命周期，并验证第二次调用不能复用同一回执。`npm run test:headless`、`npm run pack:yp` 的全仓库离线门禁、发布包检查和密钥扫描均通过；OpenCode 只读运行四项跨轮/逐机构生命周期用例，4/4 通过。
