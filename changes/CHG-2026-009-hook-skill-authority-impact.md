# CHG-2026-009 Impact Analysis

```yaml
task_id: CHG-2026-009-HOOK-SKILL
status: ANALYZED
risk_level: high
approved_spec_version: "mvp-v2 / schemaVersion 1"
```

## Impact

| Domain | Change | Constraint |
| --- | --- | --- |
| Hook guards/projection | Yes | 只消费服务端权威投影，session deny-only。 |
| Result validation | Yes | 每个工具按冻结 output contract fail closed。 |
| MCP identity | Yes | 精确消费 `mcp__ypmcn__*`，不接受 foreign/bare。 |
| Skill docs | Yes | 写后刷新、状态/身份证据与恢复顺序同步。 |
| Spec/provider/database | No | 禁止修改，不声明外部部署。 |
| Packaging | No | 不改 dist、staging、release。 |

## Security And Data

- 不保存 raw customer payload；投影只保留脱敏状态、版本、动作和语义 ID。
- foreign namespace、畸形输出、stale state 不能成为授权或证据。
- manual/cron context 只作审计与额外拒绝，不授予恢复写。

## Risks

- 某些写输出只有 `state_version` 而没有完整 `allowed_actions`；必须强制 `get_workflow_state` 刷新，不得本地推断。
- Hook API 不能主动执行 provider `tools/list`；生产 capability handshake 继续由独立 provider gate 承担。
- 外部 provider 当前仍不兼容，生产保持 NO-GO。

## Verification

聚焦插件与 Skill 测试后运行完整 `npm run verify`、secret scan 与 diff check；OpenCode 对冻结 SHA 只读复验。
