# CHG-2026-008 Impact Analysis

```yaml
task_id: CHG-2026-008-NAMESPACE
status: ANALYZED
risk_level: medium
approved_spec_version: "mvp-v2 / schemaVersion 1"
```

## Impact

| Domain | Change | Constraint |
| --- | --- | --- |
| MCP identity contract | Yes | 只定义 Host canonical namespace 与限定名规则，不改 15 个工具的 bare protocol names。 |
| Hook / Skill runtime | No | 后续任务消费本契约，本任务禁止修改。 |
| Reference MCP | No | 模拟器仍直接使用 bare tool names，不受 Host namespace 改写。 |
| Vector MCP | No | 明确保持独立向量服务，不冒充业务 provider。 |
| Production provider | No | 不连接、不配置、不调用业务工具；readiness 仍为 NO-GO。 |

## Security

- 精确 namespace 可阻断 `mcp__foreign__search_creators` 等同名工具伪装。
- 不把 bare Hook event 视为业务 MCP 调用，避免绕过 server identity。
- provider 协议层仍由 `tools/list` 检查 bare tool catalog；Host namespace 不能代替能力协商。

## Compatibility

- 现有测试使用的 `mcp__ypmcn__*` 成为正式限定名。
- `YPmcn/mcp.json` 中的 `vector-mcp` 是不同工具服务，不会被重命名或 fallback。
- legacy provider 保持 detection-only；没有生产兼容性声明。

## Verification

- `npm run verify:spec`
- `npm run verify:docs`
- `npm run verify`
- `node scripts/scan-secrets.mjs --tracked`
- `git diff --check`

## Rollback

revert 契约提交。本任务没有 provider、数据库、Hook、包或外部写副作用。
