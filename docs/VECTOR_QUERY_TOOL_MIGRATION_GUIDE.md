# 向量能力的使用与部署边界

> 更新：2026-07-23
> 这是一份给插件使用者、产品和服务端同学看的说明：它解释当前能做什么、不能做什么，以及为什么不需要在本地“迁移向量库”。

## 先记住三件事

1. **普通用户不需要安装 Qdrant、配置数据库或申请模型 API Key。**
2. **普通 Agent 不会调用向量 Tool。** 公开业务入口仍是 `search_creators`、`rank_creators`，并由 Skill 按业务流程使用。
3. **Qdrant 目前是服务端影子能力。** 它是否参与某一次搜索，必须由真实远程响应和服务端证据确认，不能只看插件配置或旧文档。

## 当前链路长什么样

```text
用户 / Agent
→ YPmcn 插件
→ 统一远程 MCP（SSE）
→ search_creators / rank_creators 等业务 Tool
→ 服务端内部：MySQL 硬筛
→ （待验收时才可能）Qdrant 语义召回与可选 rerank
→ MySQL 回源复核
→ 业务结果
```

插件配置文件 [`YPmcn/mcp.json`](../YPmcn/mcp.json) 只保存统一远程 MCP 的地址。它没有也不应该包含 Qdrant、MySQL、embedding 或 rerank 的密钥。

换句话说，安装插件不等于在用户电脑上启动了向量数据库；它只是让插件能与远程业务服务通信。

## 一次正常使用的例子

媒介提出：“找 10 位适合护肤新品、预算在范围内的小红书达人。”

1. Skill 先按当前工作流解析和校验需求；
2. 服务端业务 Tool 根据需求做候选处理；
3. 无论内部是否启用语义召回，价格、平台、地域等硬条件都以 MySQL 当前记录为准；
4. 返回的候选才进入后续的排序、提报或人工判断。

若向量依赖不可用，正确行为是服务端明确采用 `sql-only`，继续给出 MySQL 硬筛结果，而不是要求用户安装本地工具、改环境变量或反复重试。

## 哪些操作不该做

- 不要把 `vector-mcp`、`search_creator_tag_vectors`、同步或健康检查工具暴露给普通 Agent；
- 不要在插件包、`mcp.json`、Skill、Prompt、日志或聊天里放 Qdrant/MySQL/模型密钥；
- 不要用本地 JSON、旧缓存或未经回源的向量点当作生产结果；
- 不要因为旧文档提到 DashVector，就新建第二套向量数据库；
- 不要把“远程 MCP 可连接”误写成“向量检索已验收”。

## 给服务端和运维同学的边界

若未来要启用 Qdrant，密钥、同步、索引和监控都只部署在远程业务服务一侧。服务端必须：

- 使用 MySQL 只读权限和受控密钥管理；
- 让 Qdrant 只保存可重建的、脱敏后的派生索引；
- 在返回结果前按 MySQL 重新验证；
- 把检索模式、降级原因和来源信息写入真实响应/审计记录；
- 在 Qdrant、embedding、rerank 或索引过期时可立刻切回 `sql-only`。

具体接入和验收步骤见 [Qdrant Cloud 接入指南](QDRANT_CLOUD_MIGRATION_GUIDE.md) 与 [向量检索与排序实施计划](VECTOR_SEARCH_RERANK_IMPLEMENTATION_PLAN.md)。

## 如何判断当前是否真的启用了向量

以下证据强度不同：

| 看到的现象 | 能证明什么 | 不能证明什么 |
| --- | --- | --- |
| 插件能连接 SSE | 远程 MCP 地址可被配置 | 向量服务已部署或已启用 |
| `tools/list` 里没有 vector Tool | 对外工具边界没有暴露向量运维能力 | `search_creators` 已跑向量 |
| 本地测试通过 | 契约和插件逻辑符合预期 | 远程数据、性能和质量已验收 |
| 真实响应有检索模式和来源信息，加上服务端日志 | 某次真实调用走了哪条链路 | 长期质量、成本和容量一定达标 |
| 冻结样本评测与故障演练完成 | 可以讨论灰度或上线 | 后续无需持续监控 |

当前远程 MCP 的工具输出没有广告 `outputSchema`；因此“向量已启用”的最终证据只能来自真实调用留存和服务端观测。可先阅读 [MCP 运行时审计](MCP_TOOL_RUNTIME_AUDIT_2026-07-23.md)。

## 常见问题

### 我需要在自己的电脑上启动 Qdrant 吗？

不需要。当前插件包不携带本地向量运行时，也不应获得数据库或模型凭据。

### 我可以让 Agent 直接搜索向量吗？

不可以。这样会绕开需求校验、MySQL 硬筛、候选快照、权限和审计。Agent 应使用现有业务流程，而不是向量基础设施。

### 结果里显示 `sql-only` 是失败吗？

不一定。它表示本次按 MySQL 的权威数据处理，没有使用向量能力。只要降级原因和来源信息清楚，这比返回未经验证的“看起来相关”的结果更安全。

### 能否按旧 DashVector 方案继续做？

不能。该方案已经归档为历史资料；当前只保留 Qdrant 路线。若要重新评估 DashVector，必须走新的 Change Proposal 和同样的质量/安全验收。

## 进一步阅读

- [远程向量能力现状](REMOTE_VECTOR_DATABASE_STATUS_2026-07-17.md)
- [Qdrant Cloud 接入指南](QDRANT_CLOUD_MIGRATION_GUIDE.md)
- [历史 DashVector 方案（不执行）](VECTOR_SERVER_MIGRATION_AND_TOOL_DESIGN.md)
