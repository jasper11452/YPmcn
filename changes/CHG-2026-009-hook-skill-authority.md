# CHG-2026-009：Hook / Skill 消费服务端权威状态

```yaml
task_id: CHG-2026-009-HOOK-SKILL
change_type: implementation
status: SPEC_APPROVED
approved_spec_version: "mvp-v2 / schemaVersion 1"
approval_basis: "用户要求在最新检测文档对应契约修复完成后继续落地下游运行时修复"
baseline: "main@839aa6ee26ab0af3d2b813d53efb154d51ab5ae5"
rollback_strategy: "revert 实现提交；不连接生产 provider、不发布包"
```

## Problem

当前 Hook 仍以本地 phase、人工恢复文本或 cron context 推断部分授权；普通工具结果未逐工具校验 output contract；任意 MCP namespace 的同名工具可能被识别；Skill 仍未完整要求每次写后刷新服务端权威状态。这与 CHG-2026-007 和 CHG-2026-008 已批准契约不一致。

## Decision

1. Hook session 只保存脱敏、可过期的 deny-only projection；服务端 `state_version` 与 `allowed_actions` 是唯一动作授权。
2. 只有通过 `spec/mcp.json#/outputContracts` 验证的结果才可更新本地证据；失败、畸形、过期或错误工具结果不得推进投影。
3. 只有 `mcp__ypmcn__<contract-tool>` 被视为业务 MCP Hook 事件；bare 与 foreign namespace fail closed。
4. 写结果若不含完整权威动作集合，下一个状态写前必须通过 `get_workflow_state` 刷新。
5. 人工意图、cron 来源、字段选择和本地 ID 只能增加拒绝条件，不能授予服务端动作。
6. Skill/tool cards 与 Hook 行为同步；生产 provider、数据库、算法与包发布仍不在本任务范围。

## Task Boundary

```yaml
goal: "让 Hook/Skill 严格消费已批准的业务 namespace、工具输出与服务端权威 workflow projection"
allowed_paths:
  - "YPmcn/src/contract/types.ts"
  - "YPmcn/src/contract/validator.ts"
  - "YPmcn/src/hooks/**"
  - "YPmcn/src/index.ts"
  - "YPmcn/tests/contract.test.mjs"
  - "YPmcn/tests/guards.test.mjs"
  - "YPmcn/tests/runtime-flow.test.mjs"
  - "YPmcn/tests/registration.test.mjs"
  - "YPmcn/README.md"
  - "YPmcn/skills/media-assistant/**"
  - "tests/test_skill_package.py"
forbidden_paths:
  - "spec/**"
  - "changes/**"
  - "workflows/**"
  - "reference-mcp/**"
  - "vector-mcp/**"
  - "YPmcn/mcp.json"
  - "YPmcn/openclaw.plugin.json"
  - "YPmcn/dist/**"
  - "packages/**"
  - "scripts/**"
  - ".github/**"
  - ".env*"
acceptance:
  - "仅服务端 allowed_actions 可授权动作，state_version 单调且旧投影不能覆盖新投影"
  - "人工恢复文本、cron context、本地 phase 或本地 ID 均不能独立授权 recovery write"
  - "所有被接受的结果符合逐工具 output contract；畸形结果不改变任何状态或证据"
  - "仅 mcp__ypmcn__<contract-tool> 进入业务 Hook，foreign 与 bare 名称被拒绝"
  - "Skill 文档覆盖 get_workflow_state、写后刷新、关键身份和 fail-closed 边界"
  - "不修改 Spec、provider、reference/vector MCP、生成物或包"
verification:
  - "npm --prefix YPmcn test"
  - "uv run --no-project python -B -m unittest -v tests/test_skill_package.py"
  - "npm run verify:spec"
  - "npm run verify:docs"
  - "npm run verify"
  - "node scripts/scan-secrets.mjs --tracked"
  - "git diff --check"
rollback: "revert Hook/Skill 实现提交；session projection 为内存态，无数据迁移"
```
