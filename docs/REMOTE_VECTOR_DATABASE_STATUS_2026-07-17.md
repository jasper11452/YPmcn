# 远程向量能力现状（更新于 2026-07-18）

## 结论

Qdrant 已部署且达人数据已向量化，这是当前业务确认；远程代码也存在 embedding、`content/commercial` 双向量和 rerank 模块。但 `SearchCreators`、`RankCreators` 是否已经稳定调用这些能力并返回可追溯结果，尚未通过真实链路验收，因此正式状态仍是 `shadow / integration-unverified`，不能写成已上线。

## 已确认

- 向量能力运行在服务端，不进入 YPmcn 插件包；
- Qdrant 是 MySQL 的可重建派生索引，不是业务事实源；
- 达人数据已经完成向量化；
- 代码方向使用内容与商业双路向量；
- rerank 模块已存在，但必须接入 Search 和 Rank 的实际业务路径并用真实 Brief 验证；
- 普通 Agent 只调用 `search_creators` / `rank_creators`，不直接看到向量运维 Tool。

## 尚未通过的证据

当前统一远程 MCP 尚未完成向量业务链验收，所以不能证明：

- 实际运行进程加载了哪一版向量配置；
- 每个平台 Point 数与 MySQL 是否一致；
- `search_creators` 是否真的执行 Qdrant 和 rerank，而不是 SQL-only；
- `rank_creators` 是否消费相同语义特征和模型版本；
- 真实需求的召回质量、延迟、费用和降级行为。

必须从统一 endpoint 的 Tool 响应 `retrieval_mode/degraded_reason/provenance` 和服务端日志同时确认，不能只看代码存在。

## 当前统一路线

近期只完善已经部署的 Qdrant，不再并行设计 DashVector 第二套实现。MySQL 先按 `customer_demands + field_match_mapping` 做硬筛；Qdrant 在允许集合内双路召回；rerank 重排；最后回源 MySQL 复核。完整改造和验收见 [VECTOR_SEARCH_RERANK_IMPLEMENTATION_PLAN.md](VECTOR_SEARCH_RERANK_IMPLEMENTATION_PLAN.md)。

## 上线门禁

至少用 20–50 条真实脱敏 Brief 比较 SQL-only、单路 dense、双路 RRF、RRF+rerank；硬条件违规必须为 0，三个候选模型按同一冻结样本达到既定 80% 媒介满意率后再定模型与参数。失败时关闭服务端 feature flag 回到 SQL-only，不改插件、不回滚 MySQL。
