# CHG-2026-011 Impact Analysis

```yaml
task_id: CHG-2026-011-HOOK-HOST
status: ANALYZED
risk_level: high
approved_spec_version: "mvp-v2 / schemaVersion 1"
```

## Impact

| Domain | Change | Constraint |
| --- | --- | --- |
| Hook host adapter | Yes | 仅修真实宿主事件适配，不扩业务行为面。 |
| Hook guards/results | Yes | 只补宿主接口错配导致的 fail-open / fail-closed 错误。 |
| Spec / Reference MCP | No | 本任务禁止修改。 |
| Production provider | No | 仍为 NO-GO。 |

## Risks

- 若 OpenClaw 当前宿主根本不暴露发送确认信息，则需要改为从 session extension 取值；若连 extension 也无可用来源，应直接 BLOCKED，不得伪造。
- 只允许修已确认的宿主对接问题，避免重新发散为整套 Hook 重写。

## Verification

- `npm --prefix YPmcn test`
- `npm run verify:spec`
- `npm run verify:docs`
- `npm run verify`
- `node scripts/scan-secrets.mjs --tracked`
- `git diff --check`
