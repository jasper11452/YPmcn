# CHG-2026-013 Impact Analysis

```yaml
task_id: CHG-2026-013
status: ANALYZED
risk_level: critical
approved_spec_version: "mvp-v3-vector-baseline / schemaVersion 1"
lane: critical
```

## Domain Impact

| Domain | Change | Constraint |
| --- | --- | --- |
| Business Spec / Database | Yes | 增补最新 MVP 实体、身份、所有权和派生索引原则；不执行数据库 DDL/DML。 |
| Business MCP | Yes | 校准 `search_creators` / `rank_creators` 契约；保持 closed-world 工具集合，不新增业务工具。 |
| Algorithms | Yes | 建立向量召回/排序治理结构，但模型、阈值和权重保持待评估、未激活。 |
| Errors / Workflow | Yes | 增补向量失败、索引陈旧和 SQL-only 降级语义，保持已有工作流状态机兼容。 |
| Runtime / Deployment | No | 不修改 Provider、vector-mcp、Qdrant、MySQL 或服务器。 |

## Compatibility

- 这是正式业务契约升级；现有 reference provider 可能在后续 Change 中需要适配，但本阶段不得偷偷修改运行时以掩盖不一致。
- 现有业务 MCP namespace 保持不变；`vector-mcp` 继续排除，因此不会扩大宿主可调用的业务工具表面。
- 新算法字段必须保持向后可解析；未选择模型或权重时只能是 `shadow`、`disabled` 或等价的非生产状态。
- 现有工作流动作与状态不得因向量能力而新增旁路。

## Risks And Mitigations

| Risk | Level | Mitigation |
| --- | --- | --- |
| 外部文档与现有 Spec 存在语义冲突 | Critical | 以本批准 Change 明确升级点；冲突无法确定时停止，不由 Executor 猜测。 |
| 未验证参数被误写成生产默认值 | Critical | 测试要求模型、维度、阈值、权重保持待评估/未激活。 |
| 新增向量工具扩大 MCP 权限面 | High | closed-world 工具列表不得新增；vector namespace 继续 excluded。 |
| Qdrant payload 被当作事实源 | High | 契约强制 MySQL 回源复核与派生索引可重建。 |
| 数据缺失导致排序偏置 | High | 契约要求 missing-aware、coverage-aware 及可解释 provenance。 |
| 运行时与新契约暂时不一致 | Medium | 本 Change 只改契约并明确后续迁移；全量测试记录差异，不跨范围修复。 |

## Verification Independence

- Lane 为 `critical`。
- 必须使用 `yuepu/Deepseek-V4-Pro` 的 OpenCode 只读验证。
- Verifier 缺失、格式失败或出现任何非预期写入时保持 `BLOCKED`，禁止 fallback。
- 集成前必须确认冻结 base/head SHA、allowed paths 与 secret scan。

## Rollback

- revert 本 Change 的 Spec、测试和文档变更。
- 本阶段无数据库、向量索引、外部 API、容器或生产运行态变更，无数据回滚步骤。
