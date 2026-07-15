# CHG-2026-013：建立向量检索 MVP 正式契约基线

```yaml
task_id: CHG-2026-013
change_type: contract
status: SPEC_APPROVED
approved_spec_version: "mvp-v3-vector-baseline / schemaVersion 1"
approval_basis: "用户于 2026-07-14 要求以最新 MVP 数据表与工具契约为准，完成 MySQL 实表检查和公开资料交叉验证后，按既定向量数据库计划直接实施"
baseline: "main@5d36b391c1b0c69cd58243dd3f8598018996d71d"
rollback_strategy: "revert 本变更；本阶段不修改数据库、Qdrant、Provider 或生产数据"
```

## Problem

当前正式 Spec 落后于最新业务设计：`spec/database.json`、`spec/mcp.json` 与实际 MVP 表/工具边界不完整，`spec/algorithms.json` 仍为 `external-unverified`，而 `vector-mcp` 的实验实现不能在正式业务契约之前升级为生产依赖。直接接入 Qdrant 会造成业务身份、字段语义、工具闭集、排序算法和失败降级缺少权威依据。

## Decision

1. MySQL 是唯一业务事实源；Qdrant 仅是可重建的派生索引，不拥有业务写权限。
2. 正式记录身份为 `(platform, kw_uid, source_snapshot_date)`，创作者业务身份为 `(platform, kw_uid)`。
3. 将最新 MVP 业务实体纳入数据库契约：`customer_demands`、`xhs_creator_accounts`、`dy_creator_accounts`、`creator_supply_offers`、`creator_candidate_pool`、`mcn_recommendation_items`、`mcn_inquiry_batches`、`mcn_inquiries`、`mcn_submission_items`、`recommendation_runs`、`creator_recommendation_items`。
4. 保持业务 MCP 工具闭集；不新增面向业务的向量工具。向量召回作为 `search_creators` 和 `rank_creators` 的内部实现能力。
5. `vector-mcp` 继续位于业务 MCP excluded namespace；其三个工具仅用于开发/运维：`sync_creator_tag_vectors`、`search_creator_tag_vectors`、`health_check_vector_store`。
6. `search_creators` 负责硬过滤、候选召回及 provenance；`rank_creators` 只处理已接受候选并输出可解释的缺失感知排序。
7. 硬约束仍由结构化字段判定；内容标签和向量分数默认是软相关特征，不得替代地区、粉丝量、价格、合规等硬过滤。
8. Qdrant 使用两个 named vectors：`content` 与 `commercial`。`content` 来源于创作者类型、内容类型、内容标签、persona 和清洗后的 description；`commercial` 来源于解析后的品牌、品类、场景、功效、成分与 IP。
9. ID、昵称、URL、机构、性别、年龄、地区、粉丝/互动指标、CPE/CPM、价格、返点及纯数值 JSON 不进入 embedding 文本。
10. 排序必须显式处理缺失值；不得把缺失或 0 误当作最差真实观测，也不得在 CPE 覆盖不足时将其设为主要权重。
11. Embedding/Reranker 提供商、模型版本、维度、归一化、距离度量、候选上限、RRF 参数和权重必须版本化；未通过冻结样本评估前保持 shadow/off，不得把猜测值升级为正式生产默认值。
12. Qdrant payload 不是权威数据；对外返回前必须以 MySQL 当前记录重新校验。
13. 可用性失败时采用显式 SQL-only 降级并标注 provenance/degraded reason；禁止以 FakeQdrant 或本地 JSON 冒充生产检索结果。
14. 增加向量相关错误语义，区分配置错误、Embedding/Reranker 失败、向量库不可用、索引陈旧和降级结果。
15. 本 Change 只建立契约与治理基线；真实 Qdrant adapter、同步服务、Docker 部署和业务 Provider 集成必须拆分后续 Change。

## Scope

### Included

- 更新 `spec/database.json`、`spec/mcp.json`、`spec/workflow.json`、`spec/errors.json`、`spec/algorithms.json` 及 manifest/version 引用。
- 补充 Spec 治理测试，机器验证实体、身份、工具闭集、excluded namespace、算法状态与错误语义。
- 同步仅由 Spec 生成/约束的人类文档（如现有验证要求确需）。

### Excluded

- 不修改 `vector-mcp/**`、`reference-mcp/**`、`YPmcn/**` 运行时代码。
- 不连接或修改 MySQL/Qdrant，不发起外部 Embedding/Reranker 请求。
- 不新增业务 MCP 工具，不确定生产模型和排序权重。
- 不部署服务器、容器或网络策略。

## Acceptance

- 最新 MVP 表、身份、写入所有权和推荐链路在正式 Spec 中闭环。
- `search_creators` / `rank_creators` 的职责和向量内部实现边界明确，业务工具闭集保持不变。
- 两类向量字段、排除字段、硬过滤/软排序、缺失值及 MySQL 回源原则可机器验证。
- 算法参数保持未激活/待评估，不写入未经验证的生产默认值。
- 向量失败、陈旧索引及 SQL-only 降级有稳定错误/结果语义。
- 全量离线门禁、Spec 治理、文档同步、secret scan 与 whitespace 检查通过。

## Implementation Order

1. 先补失败测试，冻结新业务实体、身份、MCP 边界与向量治理规则。
2. 最小更新正式 Spec 和 manifest 引用。
3. 只更新由正式 Spec 约束的文档。
4. 运行全部门禁。
5. 冻结 SHA，使用 OpenCode 首选 Verifier 只读复验；Critical 不允许 fallback。
