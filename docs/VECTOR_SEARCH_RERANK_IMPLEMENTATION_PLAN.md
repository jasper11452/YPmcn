# SearchCreators / RankCreators 向量融合实施方案

## 结论

Qdrant 保持服务端内部能力，不进入插件包，也不新增 Agent 可见 Tool。`SearchCreators` 负责“真实需求硬筛 → Qdrant 双路召回 → rerank → MySQL 回源 → 候选池”；`RankCreators` 只在已回收/手扒的合法候选集合内复用向量与 rerank 相关性，作为业务精排的软特征。两处都必须使用 rerank，任何向量分不得覆盖硬条件。

当前口径：Qdrant 已部署且达人数据已向量化，这是业务方确认；代码和配置曾看到 `content/commercial` 双向量与 embedding/rerank 模块，但本机 2026-07-18 无法连开发机 MCP，因此本方案不能把“两个 Tool 已实际调用并返回正确结果”写成通过。上线前必须用真实 Brief 证实调用链。

## 现有代码评估

仓库的 `vector-mcp` 只能作为服务端迁移素材，不能原样挂到业务 Tool：

- `LocalVectorPipeline` 没有被 `search_creators` 或 `rank_creators` 调用；公开业务面也已正确排除独立 Vector MCP。
- 当前 `mergeHits()` 只按两路中的最好名次排序，不是 RRF；应改为 Qdrant Query API 的真实 RRF，或使用已有正确的 RRF 实现并保存融合参数。
- Point ID 当前包含 `sourceSnapshotDate`，同一 `(platform,kwUid)` 在新快照会生成新点；业务集合必须改为稳定账号 ID，快照时间只放 payload，并在同步时清理/覆盖旧点。
- 真实 Qdrant 查询目前只过滤 `platform`，还没有接收 SQL 硬筛允许集合；硬筛也只覆盖少量 region/follower 字段，没有读取 `field_match_mapping`。
- content/commercial 查询目前对同一 query 文本重复 embedding；接入时必须按本文分别构造两段查询文本。
- rerank client 已存在，但只有完整真实链路返回模型版本、分数和 provenance 后，才能算已启用。

因此最小工作不是另起一个 Vector Tool，而是把这些内部模块修正后嵌入远程业务 MCP 的 Search/Rank handler。

## 真实数据库边界

2026-07-18 直连开发 MySQL：`customer_demands=0`、`field_match_mapping=110`、`xhs_creator_accounts=619`、`dy_creator_accounts=2373`、`creator_candidate_pool=17291`、`recommendation_runs=4`。

`customer_demands` 与 `field_match_mapping` 是硬筛权威。当前 110 条映射全部为 `已匹配`、三元组无重复，且每个 `source_field_name` 都能在 61 列需求表中找到。Agent 已把范围值落成 `"[min,max]"`；Search 后端按 `(platform,source_field_name,match_status='已匹配')` 读取映射，再交给现有平台筛选适配器。Agent 和向量模块都不得自行改写目标 Min/Max 名称。

Qdrant 只保存可重建索引。最终达人身份、价格、机构、返点、档期和合规结论必须回源 MySQL。

## SearchCreators 最小实现

### 1. 编译硬筛

读取 `customer_demands.id` 对应的唯一行，拒绝非 ready、多行或平台非法状态。对每个非空需求字段：

1. 范围字段严格解析 `"[min,max]"`，失败直接 `INVALID_REQUIREMENT_RANGE`；
2. 按平台读取 `field_match_mapping` 的已匹配行；
3. 交给已确认的目标参数适配器生成硬筛；
4. 未映射但属于软内容的字段进入语义查询；既非可执行硬筛也非可保留软条件的字段返回 `FIELD_MAPPING_REQUIRED`，不得静默忽略。

SQL 先得到通过硬条件的 `(platform,kwUid)` 集合。该集合是向量召回的允许范围；硬筛结果为 0 时直接返回 0，不用向量“救回”不合格达人。

### 2. 生成两段查询文本

- content query：`contentTag`、`description`、内容/人物/达人类型标签及 `rawMessagesJson` 中的正向软约束；
- commercial query：品牌、产品、商业场景、卖点及明确可公开给模型的商业语义；
- 参考 URL、手机号、邮箱、客户身份和纯数值硬筛字段不进 embedding；负向要求单独传给 rerank 约束，不混成正向 query。

两段都为空时走 `sql-only`，不生成无意义向量。

### 3. 在硬筛集合内做 Qdrant 双路召回

使用稳定 Point ID 把 SQL 允许集合传为 Qdrant `has_id` filter。当前两张达人表合计约 2992 个账号，第一版先用完整允许 ID 集，测量请求体大小和 P95，不为这一级数据量提前复制整套硬筛字段。随后：

1. 对 `content` named vector prefetch；
2. 对 `commercial` named vector prefetch；
3. 使用 Qdrant Query API 的 RRF 融合两路；
4. `prefetch K`、最终 K 和 RRF 参数只从固定真实样本评测决定，不在 Skill 写死；不同召回分数不可直接线性相加，第一版以 RRF 为基线，任何权重都必须用冻结样本调参。

如果允许集合增长到 `has_id` 请求不可接受，不能改成“先全库取较小 Top-K、再与 SQL 集合求交”，那会静默丢掉合格达人。届时只把高选择性、稳定、真实查询会用到的字段补为 Qdrant payload index；不要给所有字段建索引。索引若在现有数据入库后才创建，需要按当前 Qdrant 版本完成 HNSW 重建，才能获得 filter-aware 路径；版本不支持所选 Query/RRF 参数时保持显式 `sql-only`，不做兼容猜测。

### 4. 强制 rerank

RRF 后的有限候选使用服务端已部署的 rerank 模型做 cross-encoder 重排。输入包含原始语义需求、负向条件和脱敏后的达人文本；输出保存 raw score、rerank rank、模型与版本。rerank 只能重排召回集，不能新增不在 SQL 允许集合的达人。

### 5. MySQL 回源和持久化

按 `(platform,kwUid)` 回源当前达人表、供给关系和供应商；再次执行全部硬筛并去重。使用现有字段即可，无需新列：

- `creator_candidate_pool.content_match_score` 保存规范到 0–100 的本次语义分；
- `matched_json.score_detail` 保存 dense/RRF/rerank 原始分与名次；
- `source_detail_json.retrieval` 保存 `retrieval_mode`、embedding/rerank/collection/vector 版本、查询 hash 和降级原因；
- 不保存完整向量、密钥或未脱敏客户 Brief。

候选池写入仍使用已有未锁定唯一约束，重复同一 search generation 必须幂等。

### 6. 固定响应

成功响应至少返回：

- `retrieval_mode`: `vector-rerank` 或 `sql-only`；
- `degraded_reason`: 正常时 null，降级时固定错误码；
- `provenance`: MySQL 快照、Qdrant collection/vector、embedding/rerank/algorithm 版本；
- 去重候选摘要；
- 现有十个 `supply_plan` 字段，包括按达人账号数计算的 `mcn_manual_creator_ratio`。

Qdrant/embedding/rerank 任一故障只能显式降级 `sql-only`。降级结果仍需 MySQL 硬筛；不得返回假向量分。

## RankCreators 最小实现

`RankCreators` 不重新全库召回。输入集合只来自当前 requirement 的有效 MCN 回填和已验证手扒候选：

1. 按 MySQL 重新执行价格、平台、档期、授权、合规等硬条件；失败者淘汰并记录原因；
2. 取 SearchCreators 已保存的 query hash 与语义特征；需求或模型版本变化时创建新 run，不能覆盖旧 run；
3. 对当前合法候选集合查询 Qdrant 相关性；Qdrant 中缺失的新回填达人使用当前脱敏文本进入同一 rerank 批次，并标记 `vector_missing=true`；
4. 对整个有限集合再次执行 cross-encoder rerank，确保 MCN 新回填与旧库候选在同一需求下可比；
5. 把 rerank 相关性规范成 run 内 0–100 的“内容匹配子分”，再与价格、返点、机构质量、效果、风险等业务分组合；具体权重由真实样本评测决定；
6. 0 是观测值，NULL 是缺失值；缺失不自动当 0，也不自动判最差；
7. 写 `recommendation_runs.embedding_model/algorithm_version/ranking_strategy/ranking_weights_json/parameters_json`，每个推荐项保存分项、理由、风险和缺失标记。

Rank 响应固定返回 `run_id`、候选数量、淘汰数量、模型/算法版本、每个候选的硬筛结论、最终分、分项、理由、风险及数据来源。

## 服务端最小改动位置

不改插件、不改 Tool 名、不加数据库列。远程业务 MCP 只需：

1. 把现有范围映射编译器接到 SearchCreators 的硬筛入口；
2. 把现有 Qdrant query 模块作为 SearchCreators 内部函数调用；
3. 把现有 rerank client 从“代码存在”接到 Search 和 Rank 的真实路径；
4. 用现有 JSON 字段保存 provenance；
5. 增加 `VECTOR_RECALL_ENABLED`、`VECTOR_RERANK_ENABLED` 两个服务端 feature flag；任一关闭即明确 SQL-only。

## 真实评测与上线门禁

先用 20–50 条脱敏真实 Brief 建独立样本，每条由媒介标注期望/可接受/不相关达人，并覆盖两平台、内容、品牌、价格边界、地域、无结果、机构重复、手扒新增和负向要求。至少比较：

1. SQL-only；
2. 单路 dense；
3. content+commercial RRF；
4. RRF+rerank。

必须同时记录硬条件违规数（必须为 0）、ANN Recall@K、NDCG@K、Top-K 媒介接受率、无结果率、重复率、向量缺失率、SQL-only 降级率、P50/P95 延迟与单次成本。三个待选模型均按同一冻结样本评测，满意率达到既定 80% 门槛后才定模型和参数。

上线顺序：shadow 记录 → 媒介可见但不影响排序 → 小流量 SearchCreators → 真实回归通过后进入 RankCreators。任一阶段失败，关闭 feature flag 回到 SQL-only，MySQL 与旧 Qdrant collection 不回滚。

实现遵循 Qdrant 官方 [RRF / Hybrid Queries](https://qdrant.tech/documentation/search/hybrid-queries/)、[Payload Indexing](https://qdrant.tech/documentation/manage-data/indexing/)、[Filtering](https://qdrant.tech/documentation/search/filtering/) 和 [Hybrid Search with Reranking](https://qdrant.tech/documentation/tutorials-basics/reranking-hybrid-search/)。
