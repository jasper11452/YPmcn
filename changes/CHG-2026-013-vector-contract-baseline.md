# CHG-2026-013：建立向量检索 MVP 正式契约基线

```yaml
task_id: CHG-2026-013
change_type: contract
status: SPEC_APPROVED
approved_spec_version: "mvp-v3-vector-baseline / schemaVersion 1"
approval_basis: "用户批准的 CHG-2026-013 契约决策与执行边界"
baseline: "ab91b2479e704336937cf8486b9f50f5b9af1d9f"
rollback_strategy: "revert 本变更；本阶段不修改数据库、Qdrant、Provider 或生产数据"
```

## Problem

正式 Spec 尚未表达向量检索的业务身份、事实源、字段语义、工具闭集、排序治理和失败降级边界。实验性向量实现不能替代正式业务契约。

## Decision

1. MySQL 是业务事实源；Qdrant 仅为可重建派生索引，无业务写权限。
2. 来源记录身份为 `(platform, kw_uid, source_snapshot_date)`，创作者业务身份为 `(platform, kw_uid)`。
3. 批准的 MVP 实体、写入所有权及推荐路径由 `spec/database.json` 固化。
4. 不新增业务向量工具；向量能力仅供 `search_creators` 和 `rank_creators` 内部使用，`vector-mcp` 保持 excluded namespace。
5. `search_creators` 负责硬过滤、候选召回和 provenance；`rank_creators` 仅排序 accepted 候选，并输出缺失感知、可解释结果。
6. 地区、粉丝量、价格、合规等结构化约束是硬条件；标签和向量分数仅为软特征，不得覆盖硬条件。
7. Qdrant 使用 `content`、`commercial` 两个 named vectors；纳入和排除字段由 `spec/algorithms.json` 精确列出。
8. 缺失不是最差真实观测，0 是已观测值；覆盖不足时不得把 CPE 设为主要权重。
9. Provider、模型、版本、维度、距离、归一化、Top-K、候选上限、RRF、阈值和排序权重在冻结样本评估前保持 pending、shadow 或 disabled。
10. 返回业务结果前必须以 MySQL 当前记录重新校验；Qdrant payload 不具权威性。
11. 向量失败或索引陈旧时仅允许显式 SQL-only 降级，并返回 `retrieval_mode`、`degraded_reason` 和 `provenance`；禁止 FakeQdrant 或本地 JSON 冒充生产结果。

## Scope

Included：正式 Spec、契约/治理测试，以及现有同步机制确需更新的人类文档。

Excluded：Qdrant adapter、同步服务、部署、Provider Runtime、数据库访问、凭据及外部 Embedding/Reranker 调用。

## Acceptance

- 实体、身份、所有权、推荐路径、字段集合、硬/软语义、缺失排序与 MySQL 复核均可机器验证。
- 业务工具闭集和 excluded namespace 不变，不新增业务 MCP 工具。
- 算法参数未被猜测为生产默认值。
- 向量失败、陈旧索引和 SQL-only 降级具有稳定语义。
- 现有 workflow 状态、动作和转换保持兼容。
