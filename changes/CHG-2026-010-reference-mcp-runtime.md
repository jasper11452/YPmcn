# CHG-2026-010：Reference MCP 实现正式输出与恢复契约

```yaml
task_id: CHG-2026-010-REF-MCP
change_type: implementation
status: SPEC_APPROVED
approved_spec_version: "mvp-v2 / schemaVersion 1"
approval_basis: "用户要求在最新检测文档对应契约修复完成后继续落地下游运行时修复"
baseline: "main@839aa6ee26ab0af3d2b813d53efb154d51ab5ae5"
rollback_strategy: "revert 模拟器提交；内存模拟无外部数据副作用"
```

## Problem

Reference MCP 仍把 `simulated` 塞入业务 data，15 个工具的多个成功结果缺字段或多字段；workflow 仅按本地 phase/time 推断，未实现持久化 `state_version`、closed-world `allowed_actions` 与 refresh/request/finalize；需求 canonical input、范围、deadline、constraint 规则也未完整执行。

## Decision

1. 所有普通结果严格符合逐工具 output contract；simulation 标记只留在既有 wrapper/MCP `_meta`。
2. 内存状态由 approved workflow state combinations 唯一解析，未知组合 fail closed；状态变更递增 `state_version`。
3. Recovery 严格执行 refresh → request → finalize，request 内部完成 CAS/idempotency；`trigger` 只记录来源。
4. `validate_requirement` 执行 canonical raw、字典 identity、range、deadline 与 constraint grammar，冲突或语义错误 fail closed。
5. 保存 selection/send/recovery/snapshot 等稳定模拟身份并保持冻结 artifact 不被迟到数据改写。
6. 不凭缺失事实合成 offer promotion；Reference MCP 始终是离线、内存、非生产证据。

## Task Boundary

```yaml
goal: "让离线 Reference MCP 的 15 个工具、权威 workflow state 与恢复序列符合已批准契约"
allowed_paths:
  - "reference-mcp/state.mjs"
  - "reference-mcp/README.md"
  - "tests/reference_mcp.test.mjs"
forbidden_paths:
  - "spec/**"
  - "changes/**"
  - "workflows/**"
  - "YPmcn/**"
  - "vector-mcp/**"
  - "packages/**"
  - "scripts/**"
  - ".github/**"
  - ".env*"
acceptance:
  - "15 个工具的成功/失败输出逐项符合 mcp.json，业务 data 不含 simulated"
  - "状态由 closed-world combinations 派生，包含单调 state_version 与 allowed_actions，未知组合 fail closed"
  - "恢复严格 refresh/request/finalize，manual/scheduled replay 只产生一个 recovery operation"
  - "canonical raw、字典、金额/返点范围、deadline 顺序与 constraint grammar 按正式错误码 fail closed"
  - "send 绑定当前 selection 并返回 selection/send/state 身份"
  - "冻结模拟 artifact 不被后续数据改写，不伪造 offer promotion 或生产部署证据"
verification:
  - "node --test tests/reference_mcp.test.mjs"
  - "node --test tests/reference_mcp.test.mjs tests/provider_contract.test.mjs"
  - "npm run verify:spec"
  - "npm run verify:docs"
  - "npm run verify"
  - "node scripts/scan-secrets.mjs --tracked"
  - "git diff --check"
rollback: "revert Reference MCP 实现提交；模拟器只使用进程内状态"
```
