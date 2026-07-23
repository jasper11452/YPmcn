# 历史方案：迁移到阿里云 DashVector（不执行）

> 状态：历史资料，2026-07-23 起不作为当前设计、采购或实施依据。
> 当前路线请看 [远程向量能力现状](REMOTE_VECTOR_DATABASE_STATUS_2026-07-17.md)。

## 为什么保留这份文档

这份文档记录过一个“把向量索引迁到 DashVector”的备选思路，方便理解曾经讨论过的取舍。它不是待办事项，也不表示项目正在使用 DashVector。

当前批准的边界已经改为：只完善服务端内部的 Qdrant 能力；MySQL 是业务事实源；普通 Agent 不直接接触任何向量运维 Tool。

## 不要据此执行的内容

请不要根据旧方案做下面的事：

- 购买 DashVector、申请 API Key 或创建 Collection；
- 把 Qdrant 数据迁移到 DashVector；
- 开发或部署 `DashVectorClient`；
- 给插件、Skill 或 `YPmcn/mcp.json` 注入向量数据库或模型凭据；
- 把“DashVector/百炼/1024 维”当成当前已批准的生产参数。

仓库当前不包含可验证的本地向量运行时；`spec/algorithms.json` 也明确表示模型、维度、RRF、Top-K 和 rerank 参数仍待评估。旧方案里的具体产品、接口和参数只能视为当时的假设。

## 当时的核心想法是什么

历史方案希望把一个可重建的语义索引托管到 DashVector，工作流大致是：

```text
MySQL 权威数据
→ 脱敏文本
→ embedding
→ 向量召回
→ MySQL 回源复核
→ 可选 rerank
```

其中“向量只做软相关性，硬条件仍由 MySQL 决定”的原则仍然有效；变化的是存储路线：当前只保留 Qdrant，不再维护 DashVector 的第二套实现。

## 如果未来确实要重新评估 DashVector

这需要一项新的决策，而不是恢复这份历史文档。至少应先完成：

1. 提交 Change Proposal，说明为什么 Qdrant 不能满足需求；
2. 重新做成本、可用性、网络、数据治理和迁移复杂度比较；
3. 用同一份脱敏冻结样本评估 Qdrant、DashVector 和 SQL-only；
4. 重新批准模型、维度、投影、索引结构、权限和降级语义；
5. 指定远程服务实现、观测、回滚和数据重建负责人；
6. 更新 `spec/`、测试和面向人的指南后，才开始采购或开发。

在新决策完成前，本文只是一份历史记录。请使用以下现行文档：

- [Qdrant Cloud 接入指南（待批准、待验收）](QDRANT_CLOUD_MIGRATION_GUIDE.md)
- [向量能力的使用与部署边界](VECTOR_QUERY_TOOL_MIGRATION_GUIDE.md)
- [向量检索与排序的待验收实施计划](VECTOR_SEARCH_RERANK_IMPLEMENTATION_PLAN.md)
