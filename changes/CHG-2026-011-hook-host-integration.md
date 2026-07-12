# CHG-2026-011：修正 Hook 与 OpenClaw 宿主接口对接

```yaml
task_id: CHG-2026-011-HOOK-HOST
change_type: implementation
status: SPEC_APPROVED
approved_spec_version: "mvp-v2 / schemaVersion 1"
approval_basis: "在 CHG-2026-009 运行时验收中确认，Hook 与真实 OpenClaw 宿主事件面存在接口错配，需先收口宿主对接再继续集成 Hook"
baseline: "main@39615a9b6cdc24c5b26392384dd5aa639417abb4"
rollback_strategy: "revert 实现提交；不连接生产 provider、不发布包"
```

## Problem

`CHG-2026-009-HOOK-SKILL` 的逻辑收口后，运行时验收确认它仍依赖 OpenClaw 实际不会提供的 Hook 字段（如 `operatorRole`、`gateState`、`confirmations`），且业务 tool name / MCP transport wrapper 解析与宿主真实行为存在错配。因此当前 Hook 无法安全合入主线。

## Decision

1. 新任务只修复 Hook 与 **真实 OpenClaw 2026.6.11 宿主事件面** 的对接，不扩展业务契约。
2. 允许在 Hook 侧消费宿主真实可用字段/扩展存储；若宿主确实不提供发送确认数据，则必须把该要求迁移到可获得的 session extension 或同等宿主安全面，不能靠伪造字段。
3. 只修复以下运行面缺口：
   - 真实 tool naming / namespace 适配
   - content-only MCP result unwrap
   - send confirmation metadata source
   - stale field-selection proof binding
4. 保持 `mvp-v2` / `CHG-2026-008` / `CHG-2026-009` 的 formal Spec 不变；若发现仍需改 Spec，则该任务直接 BLOCKED。

## Acceptance

- 真实 OpenClaw host 事件可进入业务 Hook，而不是因命名错配被绕过
- `create_with_distributions` 所需确认信息来自真实可用宿主接口，不再依赖不存在字段
- content-only MCP result wrapper 能被正确解包并进入 output contract 校验
- stale field-selection proof 不会被重新标记为当前 server selection
- `npm --prefix YPmcn test`、`npm run verify:spec`、`npm run verify:docs`、`npm run verify`、`node scripts/scan-secrets.mjs --tracked`、`git diff --check` 全部通过
