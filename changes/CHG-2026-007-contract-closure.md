# CHG-2026-007：固化 P0 与首批 P1 正式契约

```yaml
task_id: CHG-2026-007-CONTRACT
change_type: contract
status: SPEC_APPROVED
approved_spec_version: "mvp-v2 / schemaVersion 1"
approval_basis: "用户于 2026-07-12 预批准任务包，要求把检测出的 P0 与首批 P1 固化为可生成、可验证的正式契约"
baseline: "codex/chg-2026-007-contract@786c45ec45e9d2ebc084979cd95f9bf981d6835f"
rollback_strategy: "revert 本变更提交；不执行生产迁移、provider 发布或数据回写"
```

## Problem

当前 `mvp-v2` 已锁定工具输入、基本工作流和 9 项外部数据库不变量，但仍存在会阻断后续 provider/数据库实现的契约空洞：需求没有头实体和字典快照引用，多报价、供应商绑定、发送操作、字段选择结果及风险/反馈审计没有正式数据模型；恢复授权依赖 Hook session context；普通工具只有成功证据而没有完整输出形状；预算、返点、三类截止时间、单平台拆单、约束语法、Join Gate、迟到数据和报价晋升缺少机器约束。

这些缺口不能继续留给实现或 Agent 推断。本变更只批准目标契约，不把仓库内测试、reference MCP 或旧 provider 伪装成部署证据。

## Decision

1. `spec/database.json` 成为实体、字段、关系、物理唯一键、scope 与 late-data 存储边界的唯一权威；记录仍为 `external-unverified`，不声称迁移已部署。
2. 新增 `spec/requirements.json` 和无客户内容的 `spec/requirement-dictionary.json`。前者唯一拥有输入规范化、金额区间、三类 deadline、单平台拆单、约束语法、Join Gate、迟到数据和 offer promotion 语义；后者只保存字段定义，使用可复现 version/hash。
3. `raw_messages_json` 是唯一 canonical 原文。`raw_messages` 仅作为兼容输入；两者同时出现时必须规范化后完全相等，否则以 `CANONICAL_INPUT_CONFLICT` fail closed。
4. `spec/workflow.json` 把恢复固定为 `refresh → request → finalize`。服务端持久化 `state_version`、状态组合与 `allowed_actions`，并在 request 内部做 CAS；Hook session projection 只能附加更严格的本地保护，不能授权服务端动作。
5. `spec/mcp.json` 为 15 个当前工具逐一声明成功输出 Schema 和允许错误码；标准 envelope 用 JSON Schema 明确 success/data/error 互斥。字段选择继续保留现有 top-level 成功 envelope；服务端把其有序字段持久化为 selection result，发送按 authoritative recommendation/state 绑定并返回 selection/send 身份。
6. `spec/errors.json` 增加字典/规范化、区间、deadline、constraint、join、scope、迟到数据、selection freshness 与 offer promotion 的 fail-closed 错误。
7. `spec/schemas/` 提供可供实现生成类型或校验实例的 JSON Schema；Spec 与测试检查所有引用、实体字段、字典 hash 和状态组合一致，并保证发布快照自包含。
8. `spec/algorithms.json` 继续为 `external-unverified`，本变更只定义数据有效性和生命周期，不定义排序权重、召回公式或业务打分算法。
9. `legacy-1.9.4` 继续只做 detection-only，不获得执行权或自动 fallback。生产 provider、数据库迁移与算法均未完成，整体上线结论保持 **NO-GO**。

## Adopted Finding Registry

每个采纳项只有一个定义落点；其余 Spec 只能引用，不复制定义。

| Finding | Priority | Unique definition | Machine gate |
| --- | --- | --- | --- |
| `DATA_MODEL_AGGREGATES` | P0 | `spec/database.json#/entities` | 实体、关系、required fields、record schema 与 physical unique key 交叉校验 |
| `AUTHORITATIVE_RECOVERY` | P0 | `spec/workflow.json#/recoveryOperations` | 三操作顺序、state version、allowed actions、状态组合和 session 非权威断言 |
| `CANONICAL_REQUIREMENT` | P0 | `spec/requirements.json#/canonicalInput` | 字典 version/hash、canonical raw、冲突错误与 snapshot 引用测试 |
| `TOOL_OUTPUTS_AND_ERRORS` | P0 | `spec/mcp.json#/outputContracts` | 每个工具恰有一个输出契约，错误码必须来自 catalog |
| `MONEY_DEADLINE_PLATFORM` | P1 | `spec/requirements.json#/valuePolicies` | budget/rebate 区间、三类 deadline 与单平台拆单规则测试 |
| `CONSTRAINT_JOIN_LATE_PROMOTION` | P1 | `spec/requirements.json#/processingPolicies` | JSON Schema 引用、Join Gate、迟到数据与 offer promotion 状态机测试 |
| `READINESS_BOUNDARIES` | P1 | `spec/requirements.json#/governance` | external-unverified、legacy detection-only 与 NO-GO 文档门禁 |

## Task Boundary

```yaml
goal: "先把 2026-07-12 检测出的 P0 与首批 P1 问题固化为可生成、可验证的正式契约"
allowed_paths:
  - "changes/CHG-2026-007-contract-closure.md"
  - "changes/CHG-2026-007-contract-closure-impact.md"
  - "spec/**"
  - "schemas/**"
  - "YPmcn/src/contract/types.ts"
  - "YPmcn/src/contract/loader.ts"
  - "YPmcn/tests/contract-spec.test.mjs"
  - "tests/spec_governance.test.mjs"
  - "docs/README.md"
  - "docs/PROJECT_MAP.md"
  - "docs/EVOLUTION.md"
  - "docs/integration-readiness.md"
  - "workflows/tasks/CHG-2026-007-CONTRACT.yaml"
  - "workflows/verifications/CHG-2026-007-CONTRACT.json"
forbidden_paths:
  - "YPmcn/src/hooks/**"
  - "YPmcn/skills/**"
  - "reference-mcp/**"
  - "vector-mcp/**"
  - "packages/**"
  - ".github/**"
  - ".env*"
acceptance:
  - "每个采纳的 P0/P1 问题都有唯一正式 Spec 落点和机器可验证约束"
  - "数据模型、恢复权威、需求字典、业务有效性规则、输出契约和错误语义均可由机器交叉验证"
  - "external-unverified、legacy detection-only 与生产 NO-GO 边界不被弱化"
  - "全部本地门禁和 OpenCode 独立只读验证通过"
verification:
  - "npm run verify:spec"
  - "npm run verify:docs"
  - "npm run verify"
  - "node scripts/scan-secrets.mjs --tracked"
  - "git diff --check"
rollback: "revert 契约提交；下游尚未迁移，不执行数据回滚"
```

## Dependency Order

1. Change Proposal / Impact Analysis。
2. Requirements / Database Schema 与字典 hash。
3. MCP outputs / Workflow authority / Errors。
4. Loader / TypeScript types。
5. Contract tests / governance tests。
6. Human docs / task evidence。
7. 全量验证与独立只读复验。

## Compatibility And Migration

- 这是目标 `mvp-v2` 的契约收口，不是生产 migration。新实体、唯一键和服务端恢复状态都必须由后续独立 Change Proposal 落地。
- 生产 provider 当前已是 `legacy-1.9.4` 且不兼容；本变更不增加 fallback，也不调用业务工具。
- 现有 Hook/Skill/reference MCP 不在本任务修改范围。它们不能作为新契约已经实现的证据；后续实现任务必须按 Database → MCP → Hook/Skill → Integration 顺序执行。

## Rollback

revert 本变更提交即可恢复此前契约。仓库不执行生产写入、Migration、provider 发布、凭据操作或包发布，因此没有数据回滚步骤。
