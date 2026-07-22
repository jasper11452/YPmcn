# CHG-2026-025 Impact Analysis

```yaml
task_id: CHG-2026-025-EXTERNAL-SEND-CROSS-TURN
status: IMPLEMENTED_LOCAL_VERIFIED
risk_level: medium
approved_spec_version: "mvp-v2 / Skill schemaVersion 2 / Workflow schemaVersion 1 / Local state schemaVersion 20"
runtime_scope: "external-send AskUserQuestion callback lifecycle and patch release metadata"
production_provider_in_repository: false
```

## Impact

| Domain | Change | Constraint |
| --- | --- | --- |
| External confirmation | 一个待确认回执跨 AskUserQuestion 的用户响应边界保持有效 | 只匹配同一会话、未过期、完全相同参数和精确“确认发送”回调。 |
| Runtime guidance | 消除“必须在首次预检同轮重调”的矛盾 | 回调抵达后立即续接；不得先重新生成确认或绕过弹窗。 |
| State | 记录 callback/approval 时间以审计跨轮消费 | 不存消息正文、供应商 ID 或完整 payload。 |
| Safety | 取消、篡改、过期、参数变化、并发与未知写入仍被阻断 | 每次实际 Provider 调用只允许消费一次已确认回执。 |
| Provider | 无接口、数据库或真实发送变更 | 首次预检仍在本地完成，Provider 仅在授权后被调用一次。 |
| Release | 统一补丁版本为 `3.4.22` 并生成新 tgz | 不覆盖、不删除既有发布包。 |

## Verification

回归覆盖“预检 → 弹窗 → 用户下一 turn 回调 → 同参单次外发”的完整 Hook 生命周期，以及待确认时重复调用复用同一回执。发布前还将运行全仓库离线门禁、OpenCode 只读端到端验证、打包扫描和 Git 差异检查。
