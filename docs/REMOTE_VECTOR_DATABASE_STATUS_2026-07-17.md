# 远程向量能力现状（2026-07-23）

> 本文件的日期沿用原文件名；内容已按当前仓库契约更新。它说明“我们能证实什么”，不把历史部署描述当成上线证据。

## 一句话结论

当前批准的路线是：**Qdrant 只能作为服务端内部的、可重建的召回索引；MySQL 才是达人数据和硬条件的事实源。**

它目前处于 `shadow`（影子能力）状态，而不是已验收的生产检索能力。普通用户和 Agent 不会看到独立的向量 Tool，只应通过 `search_creators`、`rank_creators` 走业务流程。

## 已确认的边界

这些是仓库 `spec/` 已批准的内容：

| 事项 | 当前约定 | 对使用者意味着什么 |
| --- | --- | --- |
| 数据事实源 | MySQL | 价格、档期、合规等结论必须回源 MySQL，不能只信向量命中。 |
| 向量索引 | Qdrant，且可从 MySQL 重建 | 索引损坏时重建，不拿它当业务主库。 |
| 对外 Tool | 没有公开的向量 Tool | 不要让 Agent 直接调用 `vector-mcp`、同步或健康检查入口。 |
| 内部消费者 | `search_creators`、`rank_creators` | 向量能力只能是这两个业务 Tool 的内部实现细节。 |
| 故障处理 | 显式 `sql-only` | 向量不可用时仍可按 MySQL 硬筛找人，结果必须说明已降级。 |

例如，用户要“上海、预算 1 万以内的美妆达人”时，地区和预算先由 MySQL 判断；即使某个达人在语义上很像美妆内容，也不能因此越过预算或地区限制。

## 尚不能证实的事

仓库不含本地 `vector-mcp` 或远程业务服务的运行实现；当前插件只配置远程 SSE 地址。因此下列说法都不能写成“已上线”：

- 远程 `search_creators` 现在确实执行了 Qdrant、双路召回或 rerank；
- 某个 Qdrant 集群、Collection、模型、维度或 API Key 已被当前服务使用；
- Qdrant 点数与 MySQL 当前达人数据已对齐；
- 检索质量、延迟、费用和 SQL-only 降级已经用真实需求验收；
- `rank_creators` 已使用某一版向量或 rerank 分数。

`spec/algorithms.json` 也把模型、维度、Top-K、RRF 参数和 reranker 标为待评估或未启用。旧文档中出现的 DashScope、1024 维、具体 Collection 名等，最多是历史实施素材，**不是当前已批准的生产参数**。

## 当前路线与非路线

- 当前路线：完善一套 Qdrant 内部能力，先在 MySQL 硬筛出的允许集合内召回，回源复核后再返回业务候选。
- 非路线：并行建设 DashVector。旧 DashVector 设计保留为历史资料，不能据此采购、开发或切流。

相关说明：

- [面向使用者的迁移说明](VECTOR_QUERY_TOOL_MIGRATION_GUIDE.md)
- [Qdrant 接入前的实施与验收清单](VECTOR_SEARCH_RERANK_IMPLEMENTATION_PLAN.md)
- [Qdrant Cloud 准备指南（待批准的运维方案）](QDRANT_CLOUD_MIGRATION_GUIDE.md)
- [历史 DashVector 方案（不执行）](VECTOR_SERVER_MIGRATION_AND_TOOL_DESIGN.md)

## 什么时候可以把状态改成“可用”

至少要同时拿到以下证据：

1. 从统一远程 endpoint 的真实 `search_creators` / `rank_creators` 响应中，看到 `retrieval_mode`、`degraded_reason` 和 MySQL 回源的 `provenance`；
2. 用冻结的脱敏需求集比较 SQL-only 与候选向量方案，且硬条件违规为 0；
3. 记录模型、Collection、索引版本、延迟、成本和降级原因；
4. Qdrant、embedding 或 rerank 故障时，确认结果会明确退回 `sql-only`，而不是伪造向量结果；
5. 由业务和运维共同确认上线阈值及回滚方式。

在这些证据齐全前，产品状态应保持为“影子能力 / 待集成验收”。
