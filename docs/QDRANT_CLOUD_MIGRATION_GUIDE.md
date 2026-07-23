# Qdrant Cloud 接入指南（待批准、待验收）

> 更新：2026-07-23
> 适用对象：负责远程业务服务和运维的同学。普通插件使用者不需要按本文创建集群、配置密钥或同步向量。

## 先说结论

Qdrant 是当前项目唯一保留的向量路线，但它仍是服务端内部的 **影子能力**，不是已验收的生产功能。它只能帮助召回候选；达人资料、价格、档期和硬条件的最终判断仍以 MySQL 为准。

当前仓库没有可运行的本地向量服务，也没有证据证明某个 Qdrant Cloud 集群已经接入远程业务 Tool。请不要因为本文存在，就假设 Cloud、模型、Collection 或数据同步已经可用。

## 哪些事实已经确认

| 事项 | 当前状态 |
| --- | --- |
| 向量索引路线 | 只保留 Qdrant；不再并行推进 DashVector。 |
| 对外入口 | 普通 Agent 只使用 `search_creators`、`rank_creators`，没有公开的向量 Tool。 |
| 数据权威 | MySQL 是事实源；Qdrant 是可删除、可从 MySQL 重建的派生索引。 |
| 故障处理 | 向量依赖不可用或索引过期时，必须明确退回 `sql-only`。 |
| 算法参数 | embedding/rerank 提供方、模型、维度、Top-K、RRF 和排序权重均尚待冻结样本评估。 |
| Cloud 连通性 | 未由本仓库验证，不能写成已接入。 |

例如，用户要求“北京、预算 2 万以内、能做护肤品内容”的达人时，地区和预算必须由 MySQL 先筛掉不合格账号；Qdrant 即使认为某人内容很相近，也不能把他重新带回结果里。

## 不要误解插件配置

[`YPmcn/mcp.json`](../YPmcn/mcp.json) 只告诉插件连接统一远程 SSE：

```json
{
  "mcpServers": {
    "ypmcn-mcp": {
      "url": "https://mcp.eshypdata.com/sse"
    }
  }
}
```

它不是远程业务服务的部署配置，当前也**不包含** `SILICONFLOW_API_KEY`、Qdrant、embedding 或 rerank 的环境变量。不能从这个文件推断服务端会怎样启动，更不能把基础设施密钥写回插件配置或提交到仓库。

## 什么时候才需要开始 Cloud 接入

先满足以下四个前提，再由服务端负责人创建测试集群：

1. 有明确的 Change Proposal，指定哪一个远程服务仓库负责实现、部署和回滚；
2. 用脱敏的冻结需求集确定是否真的需要向量召回，以及接受的质量、延迟和成本阈值；
3. 批准模型、维度、文本投影、Collection 版本和召回/重排参数；
4. 服务端已有受控的密钥管理、只读 MySQL 账号、审计和监控方案。

任何一个前提缺失时，都保持 `sql-only`，不要先建正式索引再补设计。

## 建议的实施顺序

### 1. 先做服务端影子验证

服务端在不影响用户排序的前提下，记录：

- MySQL 硬筛出的候选数量；
- Qdrant 召回的候选及其命中率；
- 回源 MySQL 后剩余的合格候选；
- 降级原因、耗时和单次成本。

这一阶段的目的不是“让结果看起来更智能”，而是确认向量结果不会突破硬条件，也不会带来不可接受的延迟或费用。

### 2. 再创建测试 Collection 并回填

若影子验证获得批准：

- 从 MySQL 的白名单、脱敏投影重新生成索引；
- 使用稳定的达人业务身份（`platform + kwUid`）进行对账；
- 分别统计扫描、成功、失败、失效和重复项；
- 把模型、文本投影和 Collection 版本一起记录；
- 不复制本地数据目录，也不把 Qdrant 当备份主库。

完成回填不等于可以切流。还要用同一批冻结需求验证召回质量和 SQL-only 降级。

### 3. 以显式开关小流量启用

推荐顺序是：影子记录 → 媒介可见但不影响排序 → 小流量 `search_creators` → 验收后再考虑 `rank_creators`。

出现 Qdrant、embedding、rerank 或索引新鲜度问题时，关闭服务端能力并返回 `sql-only`；不要让插件临时连接本地 Qdrant，也不要伪造向量分数。

## 结果应如何说明“用了什么”

下面是服务端未来应满足的语义示例，**不是当前远程 Provider 已实测的响应样本**：

```json
{
  "retrieval_mode": "sql-only",
  "degraded_reason": "vector_store_unavailable",
  "provenance": {
    "authoritative_source": "mysql",
    "revalidated": true
  }
}
```

这表示“本次只用 MySQL 找人，向量库不可用”，而不是“没有结果”。若将来启用向量，也需要能追溯所用的 Collection、模型/算法版本和 MySQL 回源校验；不得返回密钥、完整向量或敏感原文。

当前 Provider 的 `tools/list` 没有广告 `outputSchema`，所以必须以真实响应和服务端日志做验收，而不能只根据文档假设字段一定存在。详情见 [MCP 运行时审计](MCP_TOOL_RUNTIME_AUDIT_2026-07-23.md)。

## 安全与回滚

- Qdrant、MySQL、embedding 和 rerank 凭据只放在服务端密钥管理或受限环境变量中；
- 插件包、`mcp.json`、Skill、日志和测试数据都不能保存这些密钥；
- MySQL 使用只读账号；Qdrant 索引损坏时从 MySQL 重建；
- 切流前保留旧的可用 Collection 或保持 SQL-only；验证通过前不要删除任何仍在使用的索引；
- 发现问题时，先关闭向量能力，再排查和重建；不修改 MySQL 业务数据来“回滚向量”。

## 接入完成的最低证据

只有同时具备下列证据，才能把状态从“影子能力”改为“已验收”：

- 真实远程 `search_creators` / `rank_creators` 调用记录；
- 固定样本上硬条件违规为 0，且质量阈值经业务确认；
- MySQL 与 Qdrant 的同步、去重、失效清理和回源复核记录；
- 版本、延迟、成本、错误和降级监控；
- 演练过向量依赖不可用时的 SQL-only 回退；
- 明确的服务端负责人和回滚窗口。

相关文档：

- [远程向量能力现状](REMOTE_VECTOR_DATABASE_STATUS_2026-07-17.md)
- [向量能力的使用与部署边界](VECTOR_QUERY_TOOL_MIGRATION_GUIDE.md)
- [向量检索与排序的待验收实施计划](VECTOR_SEARCH_RERANK_IMPLEMENTATION_PLAN.md)
- [历史 DashVector 方案（不执行）](VECTOR_SERVER_MIGRATION_AND_TOOL_DESIGN.md)
