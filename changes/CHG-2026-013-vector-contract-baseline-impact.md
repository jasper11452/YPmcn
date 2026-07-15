# CHG-2026-013 Impact Analysis

```yaml
task_id: CHG-2026-013
status: ANALYZED
risk_level: high
approved_spec_version: "mvp-v3-vector-baseline / schemaVersion 1"
baseline: "ab91b2479e704336937cf8486b9f50f5b9af1d9f"
```

## Domain Impact

| Domain | Change | Constraint |
| --- | --- | --- |
| Database Spec | Yes | 表达实体、身份、所有权、推荐路径和派生索引原则；不执行 DDL/DML。 |
| Business MCP | Yes | 校准 `search_creators` / `rank_creators` 输出语义；工具集合保持闭合。 |
| Algorithms | Yes | 建立向量召回/排序治理；参数保持待评估、未激活。 |
| Errors / Workflow | Yes | 增加失败、陈旧和 SQL-only 降级语义；不改变既有状态机。 |
| Runtime / Deployment | No | 不修改 Provider、vector-mcp、Qdrant、MySQL 或服务器。 |

## Compatibility

- `vector-mcp` 继续位于 excluded namespace，不扩大业务权限面。
- 新算法字段保持 shadow/disabled；不选择模型、阈值或权重。
- 现有 workflow 阶段、动作、状态组合和转换不变。
- Runtime 适配、真实向量索引与外部依赖均留给后续独立变更。

## Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| 未验证参数成为默认值 | 治理测试要求全部参数值为 `null` 且状态为 pending/disabled。 |
| 向量工具扩大 MCP 表面 | 测试锁定 15 个业务工具并排除 3 个运维工具。 |
| Qdrant payload 被当作事实源 | 强制 MySQL 回源复核和 provenance。 |
| 缺失数据导致排序偏置 | 强制 missing-aware、coverage-aware 和解释字段。 |
| 向量故障被静默吞掉 | 显式 SQL-only 模式、原因及错误目录。 |

## Rollback

Revert 本 Change 的 Spec、测试和同步文档。本阶段无数据库、索引、外部 API、容器或生产数据变更。
