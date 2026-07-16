# 本地 Qdrant 迁移到 Qdrant Cloud 指南

## 先看这里：你现在需要做什么

你现在只需要准备账号和密钥，**不用自己创建向量、导数据或写代码**。

### 第一步：创建 Qdrant Cloud 测试集群

1. 打开 [Qdrant Cloud 控制台](https://cloud.qdrant.io/)并登录；
2. 创建一个最低配置的测试 Cluster；
3. 区域尽量选在业务服务器、MySQL 和阿里云百炼附近，避免跨地域访问太慢；
4. 在 Cluster 中创建 API Key；
5. 保存控制台提供的 HTTPS Endpoint 和 API Key。

你最终需要准备两个 Qdrant 配置：

```text
QDRANT_URL=https://你的-cluster-endpoint
QDRANT_API_KEY=你的-api-key
```

### 第二步：确认另外两类信息已经准备好

Qdrant 只负责保存和搜索向量。项目还需要从 MySQL 读取达人数据，并调用阿里云百炼生成向量和进行精排。

你需要确认已有：

- 阿里云百炼：`DASHSCOPE_API_KEY`；
- 阿里云百炼工作空间：`DASHSCOPE_WORKSPACE_ID`（当前 `qwen3-rerank` 配置需要）；
- MySQL 只读连接信息：Host、Port、User、Password、Database。

MySQL 账号只需要读权限，不应授予写入或删除业务数据的权限。

### 第三步：安全保存，不要把密钥发出来

- 不要把 API Key、数据库密码发到聊天或群里；
- 不要把真实密钥写进本文档、代码、Git 或普通脚本；
- 把它们放进服务器的密钥管理服务或受限环境变量；
- 如果由实施人员配置，只告诉对方密钥存放位置，不要复制密钥正文。

### 剩下的工作由项目代码和实施人员完成

以下值不是你去控制台申请的，可以按项目约定直接配置：

```text
VECTOR_MCP_MODE=real
QDRANT_COLLECTION=creator_vectors_v1_202607
QDRANT_VECTOR_SIZE=1024
VECTOR_VERSION=creator-v1
DASHSCOPE_EMBEDDING_MODEL=text-embedding-v4
DASHSCOPE_RERANK_MODEL=qwen3-rerank
```

实施人员负责：

1. 修复本文后面列出的迁移前问题；
2. 创建测试 Collection 和 `platform` 索引；
3. 从 MySQL 读取并脱敏数据；
4. 调用 DashScope 生成 1024 维向量；
5. 先导入 100～1000 条样本并测试；
6. 验证通过后，再进行全量同步和正式切换。

不要复制本地 Qdrant 数据目录。这里的向量库可以从 MySQL 重新生成，MySQL 才是业务数据源。

### 当前能不能直接上线？

**不能直接写入正式全量数据。** 当前实现仍有分页可能漏数、同一达人可能重复、下线达人无法自动清理、启动配置未完整注入等问题。先创建测试 Cluster 没问题，但必须完成本文“迁移前必须解决的问题”后，再做正式全量同步。

最短执行顺序：

```text
你创建测试 Cluster 和 API Key
→ 实施人员修复迁移问题
→ 创建测试 Collection
→ 导入少量样本
→ 验证搜索和降级
→ 全量同步
→ 正式切换
```

## 1. 结论与适用范围

当前向量库是“达人语义召回”的可重建派生索引，不是通用 RAG 文档库。推荐迁移方式不是复制本地 Qdrant 数据目录，而是：

```text
MySQL 权威数据
→ 使用当前投影规则重新生成 content/commercial 文本
→ DashScope text-embedding-v4（1024 维）
→ 写入 Qdrant Cloud 的版本化 Collection
→ 离线验证
→ 通过配置或 Collection alias 切流
→ 保留旧库观察并回滚
```

迁移目标：

- 保持现有 `content`、`commercial` 双命名向量和 Cosine 距离；
- 保持 MySQL 为唯一业务事实源，Qdrant 只保存向量和最小回源 metadata；
- 不改变现有 MCP Tool 的公开契约；
- 先修复会造成漏数、重复点和版本混查的问题，再迁移全量数据；
- 云端失败时仍能降级到 SQL-only；
- 全过程不删除或修改本地 Collection，不触碰生产 MySQL 写权限。

本文面向当前仓库实现。若代码发生变化，应以 `spec/manifest.json` 指向的正式 Spec 和实际运行代码为准。

## 2. 当前实现基线

### 2.1 数据链路

```text
MySQL 达人表（只读）
→ 字段白名单投影、规范化和脱敏
→ DashScope Embedding
→ Qdrant 双路语义召回
→ 按 platform + kw_uid 回源 MySQL
→ 地区/粉丝量等硬过滤
→ DashScope qwen3-rerank
→ 达人候选
```

关键职责：

- MySQL：权威达人数据和最终硬条件判断；
- Qdrant：可删除、可重建的语义索引；
- DashScope：生成向量和精排；
- `vector-mcp`：同步、双路召回、回源、精排和 SQL-only 降级。

### 2.2 当前运行配置

`createRealRuntime()` 使用：

| 配置 | 当前默认/要求 | 迁移要求 |
|---|---|---|
| `VECTOR_MCP_MODE` | real 模式由外部配置 | 云端验证时设为 `real` |
| `DASHSCOPE_API_KEY` | real 模式必填 | 从密钥管理注入 |
| `QDRANT_URL` | `http://localhost:6333` | 改为 Cloud cluster URL |
| `QDRANT_API_KEY` | 可选且代码已读取 | Cloud 必填，从密钥管理注入 |
| `QDRANT_COLLECTION` | `creator_local_vectors` | 建议先指向版本化物理 Collection 或稳定 alias |
| `QDRANT_VECTOR_SIZE` | `1024` | 固定为 1024，并校验模型实际输出 |
| `DASHSCOPE_EMBEDDING_MODEL` | `text-embedding-v4` | 迁移期间不得改变 |
| `DASHSCOPE_RERANK_MODEL` | `qwen3-rerank` | 迁移期间不得改变 |
| `VECTOR_VERSION` | `local-v1` | 改为明确发布版本，如 `creator-v1` |
| `VECTOR_HTTP_TIMEOUT_MS` | `15000` | 按国内到 Cloud 区域的实测延迟调整 |
| `VECTOR_HTTP_MAX_RETRIES` | `1` | 保持有限重试，避免放大故障 |

注意：`YPmcn/mcp.json` 当前仍传入旧的 `SILICONFLOW_API_KEY`，没有传入 DashScope 和 Qdrant Cloud 配置。从该文件启动 real mode 会在连接 Qdrant 前失败。迁移前必须修正配置注入，但密钥值不得写进仓库。

### 2.3 Collection schema

当前实际 schema：

```json
{
  "vectors": {
    "content": { "size": 1024, "distance": "Cosine" },
    "commercial": { "size": 1024, "distance": "Cosine" }
  }
}
```

- `content`：必填，描述内容风格、主题和账号画像；
- `commercial`：可选，描述品牌、行业、品类和合作场景；
- 写入前严格校验维度和有限数值；
- `commercial_vector_available` 必须与 point 是否包含 `commercial` 向量一致；
- 当前 upsert 批大小为 100，使用 `wait=true`。

当前 payload：

```json
{
  "platform": "xhs",
  "kw_uid": "...",
  "source_table": "xhs_mz",
  "source_row_id": "...",
  "source_snapshot_date": "...",
  "source_updated_at": "...",
  "embedding_model_id": "text-embedding-v4",
  "vector_version": "creator-v1",
  "commercial_vector_available": true
}
```

Qdrant 不保存完整达人行、客户 Brief、手机号、凭据或其他敏感原文。查询命中后必须回源 MySQL。

### 2.4 当前召回行为

同一条规范化 query 会生成两份相同模型的 query embedding，分别检索 `content` 和 `commercial`。两路结果按 `platform:kw_uid` 去重，以最佳名次合并；当前不是分数加权融合。Qdrant 层只按 `platform` 过滤，其余硬条件在回源 MySQL 后判断。

默认最终返回 20；`candidateLimit` 默认至少 50、最大可到 1000。迁移验证阶段建议双路各 50，合并后控制在 80 左右，送入 reranker 不超过 50；正式阈值必须由固定评测集决定。

## 3. 迁移前必须解决的问题

以下问题未解决时，不应向正式 Cloud Collection 全量写入。

### P0：运行配置不一致

修正 MCP real-mode 环境变量，至少注入：

```text
VECTOR_MCP_MODE=real
DASHSCOPE_API_KEY
QDRANT_URL
QDRANT_API_KEY
QDRANT_COLLECTION
QDRANT_VECTOR_SIZE=1024
VECTOR_VERSION=creator-v1
```

验收：进程能启动；日志和错误不输出 API Key；对 Cloud 只执行只读 health/collection 检查。

### P0：增量游标可能漏数

当前 SQL 使用 `update_time > cursor`，排序为 `update_time, kwUid`，但 cursor 只保存时间。如果分页边界有相同 `update_time` 的多行，下一页会跳过尚未处理的记录。

迁移前应改为复合游标 `(updated_at, kw_uid)`：

```sql
WHERE update_time > ?
   OR (update_time = ? AND kwUid > ?)
ORDER BY update_time ASC, kwUid ASC
```

游标只有在整批 upsert 成功后推进。必须测试同时间戳跨页、重跑同一页和中途失败恢复。

### P0：Point ID 与保留策略冲突

当前 point ID 由 `platform + kw_uid + source_snapshot_date` 生成；同一达人新快照会形成新 point。搜索会按 `platform:kw_uid` 在单次召回结果中去重，但旧 point 会持续占用存储，并可能让召回候选偏向重复达人。

必须二选一：

1. **推荐：仅保留当前达人。** point ID 改为稳定的 `platform + kw_uid`，upsert 覆盖旧版本，并为删除/下线记录同步删除 point；
2. **保留历史快照。** 当前 Collection 只服务最新数据，历史快照写入独立 Collection，查询明确携带快照范围。

不要在一个线上 Collection 中混合这两种语义。

### P0：版本字段没有查询隔离

`embedding_model_id` 和 `vector_version` 已写入 payload，但当前搜索不按它们过滤。同一 Collection 若混入不同文本规则或模型世代，即使维度相同，也会混查不可比的向量。

首期使用版本化物理 Collection：

```text
creator_vectors_v1_202607
creator_vectors_v2_...
```

稳定逻辑名建议为：

```text
creator_vectors_current
```

在应用尚未支持 alias 前，可直接通过 `QDRANT_COLLECTION` 切换；支持 alias 后再原子切换。不得在迁移期间同时改变模型、维度、文本投影规则和存储平台。

### P1：缺少 payload index

当前查询会按 `platform` 过滤，但创建 Collection 后没有创建 payload index。Cloud Collection 创建后、批量导入前至少建立：

```json
{ "field_name": "platform", "field_schema": "keyword" }
```

仅为实际在 Qdrant filter 中使用的字段建索引。`kw_uid` 目前只用于回源和去重，不是过滤条件；是否建 keyword index 应由后续对账/删除实现决定，不要为全部 payload 字段盲目建索引。

### P1：缺少 stale point 删除和对账

当前实现只能 upsert 或删除整个 Collection，没有 point-level 删除、失效记录同步和全量 ID 对账。正式上线至少要有：

- MySQL 已删除/下线记录对应的 point 删除；
- 按 `(platform, kw_uid)` 的抽样或全量对账；
- 当前模型与 `vector_version` 分布检查；
- 重复业务身份检查；
- 可解释的失败清单和有限重试。

### P1：候选和 rerank 成本上限过高

`candidateLimit` 当前最大 1000，合并后候选会全部回源并送入 reranker。迁移上线前应收紧默认值和硬上限，避免 Cloud 网络、MySQL 查询和 DashScope 费用同时放大。

## 4. 目标设计

### 4.1 命名

推荐：

```text
物理 Collection：creator_vectors_v1_202607
稳定 alias：      creator_vectors_current
预发布 alias：    creator_vectors_candidate（可选）
VECTOR_VERSION：  creator-v1
```

物理 Collection 名携带 schema/数据世代；alias 表达流量角色。不要继续把 `local` 写入云端正式命名。

### 4.2 Schema 创建示例

以下命令仅作为运维模板，先替换占位符并在测试 Cluster 执行。不要把真实 Key 写入 shell history、文档或仓库；优先由密钥管理系统注入环境变量。

```bash
curl --fail-with-body --silent --show-error \
  -X PUT "${QDRANT_URL}/collections/creator_vectors_v1_202607" \
  -H "api-key: ${QDRANT_API_KEY}" \
  -H "Content-Type: application/json" \
  --data '{
    "vectors": {
      "content": {"size": 1024, "distance": "Cosine"},
      "commercial": {"size": 1024, "distance": "Cosine"}
    }
  }'
```

创建 `platform` index：

```bash
curl --fail-with-body --silent --show-error \
  -X PUT "${QDRANT_URL}/collections/creator_vectors_v1_202607/index" \
  -H "api-key: ${QDRANT_API_KEY}" \
  -H "Content-Type: application/json" \
  --data '{"field_name":"platform","field_schema":"keyword","wait":true}'
```

随后读取 Collection 信息并确认两个 named vector 的 `size=1024`、`distance=Cosine`。现有 `ensureCollection()` 会校验 named vector schema，但不会创建 payload index 或 alias。

### 4.3 区域与网络

选择 Cloud 区域时，分别测量应用到 Qdrant、应用到 MySQL、应用到 DashScope 的网络延迟。对当前链路，Qdrant 不是唯一远程依赖；跨境或跨地域部署可能使“双路查询 + 回源 + rerank”的尾延迟明显放大。

要求：

- 使用 TLS Cloud URL，不通过公网暴露 Dashboard；
- 应用和运维使用不同 API Key（若套餐/权限模型支持）；
- Key 仅存密钥服务或受限环境变量；
- 测试与正式使用不同 Cluster 或至少不同 Collection；
- 为国内网络不稳定设置明确 timeout、有限 retry 和 SQL-only 降级；
- 不在日志中记录完整向量、完整 payload、Brief 或密钥。

## 5. 分阶段迁移 Runbook

### 阶段 0：冻结迁移变量

记录并保持不变：

```yaml
embedding_model: text-embedding-v4
dimension: 1024
distance: Cosine
named_vectors: [content, commercial]
projection_version: 当前投影实现的提交号
vector_version: creator-v1
source_tables: 实际 dy/xhs 表
source_cutoff: 全量导出开始时间 T0
```

同时保存：当前代码 commit、依赖锁文件、可同步 MySQL 数量、各平台数量和固定检索评测集。迁移期间不要升级 embedding 模型或修改投影规则。

### 阶段 1：完成 P0/P1 代码准备

最低完成项：

1. 修正 MCP 环境变量；
2. 修复复合 cursor；
3. 确定稳定 point ID/历史快照策略；
4. 加入 payload index 初始化；
5. 加入失效 point 删除和对账；
6. 收紧 candidate/rerank 上限；
7. 增加版本、数量、失败率和延迟指标；
8. 为上述行为补相邻测试。

这些是代码变更，不应在 Cloud 控制台手工补丁式维护。

### 阶段 2：创建 Cloud 测试 Cluster 和 Collection

1. 创建最低成本的非生产 Cluster；
2. 获取 TLS endpoint，创建测试 Key；
3. 创建版本化 Collection 和 `platform` index；
4. 用 `GET /collections/{name}` 校验 schema；
5. 只写 100–1000 条脱敏后的真实达人样本；
6. 确认 point 数、向量维度、可选 commercial 向量和 payload；
7. 执行 content/commercial 双路查询；
8. 验证 MySQL 回源、硬过滤、rerank 和 SQL-only 降级。

禁止从本地数据目录直接复制 segment/WAL 到 Cloud。Qdrant 是派生索引，首选从 MySQL 重新生成；这也能验证新环境的完整同步链路。

### 阶段 3：全量回填

以 MySQL 快照边界 T0 为准，分别按平台稳定分页读取。建议流程：

```text
读取一批
→ 投影/脱敏
→ 生成 content 和可选 commercial embedding
→ 校验维度/有限值
→ wait=true 批量 upsert
→ 抽样回读
→ 持久化成功复合游标和统计
```

原则：

- 单批失败不得推进游标；
- upsert 必须幂等，可安全重跑；
- provider 限流只做指数退避和有限重试；
- 失败记录进入脱敏失败清单，不能吞错；
- 从 100 point/批和低并发开始，根据 429、超时、Cloud CPU/内存和 optimizer 状态调整；
- 大规模导入才考虑临时降低 HNSW 建索引开销，必须在测试环境验证并在导入后恢复；
- 不因追求导入速度关闭校验或无限提高并发。

对当前几十万级预期，重新 embedding 的成本和 DashScope 限流通常比 Qdrant upsert 更可能成为瓶颈，应先测量再调优。

### 阶段 4：追平增量

全量完成后，从 T0 开始用复合 cursor 追增量，直到同步 lag 小于约定阈值。切流前执行最后一轮增量并冻结短暂切换窗口，或让同步任务持续写 candidate Collection。

检查：

- cursor 单调推进且可恢复；
- 同时间戳数据没有漏读；
- 更新覆盖相同稳定 point ID；
- 删除/下线记录已移除；
- `embedding_model_id`、`vector_version` 只有预期值；
- `(platform, kw_uid)` 无非预期重复。

### 阶段 5：离线与在线前验收

数据验收：

```text
MySQL 可同步数
= Cloud 有效业务身份数
+ 可解释跳过数
+ 可解释失败数
```

不要只比较 Qdrant point 总数；当前旧 ID 设计可能产生重复业务身份。至少分平台核对：扫描、投影为空、成功、失败、删除、商业向量可用和唯一业务身份数量。

质量验收：

- 固定需求集分别搜索本地和 Cloud；
- 比较 top-K 重叠、Recall@K、MRR/nDCG；
- 抽查品牌、品类、内容风格和地区/粉丝硬条件；
- 确认 Cloud 结果均能按 `platform + kw_uid` 回源；
- 验证 commercial 缺失时 content 仍可召回；
- 验证两个不同版本不会混查。

性能验收：

- 记录 Qdrant 双路查询、MySQL 回源、rerank 和端到端 P50/P95/P99；
- 记录超时率、429、5xx 和 SQL-only 降级率；
- 用接近真实候选规模测试，不用 `candidateLimit=1000` 作为默认压测；
- 通过固定并发逐级加压，不直接冲击正式 Cluster。

### 阶段 6：切流

优先使用 alias：

1. candidate Collection 通过全部验收；
2. 创建或更新 `creator_vectors_current` alias 指向 candidate；
3. 应用 `QDRANT_COLLECTION` 指向稳定 alias；
4. 原子切换 alias；
5. 小流量观察后逐步放量；
6. 旧 Collection 保持只读且至少保留一个完整观察窗口。

如果当前客户端/运维尚未实现 alias，则先使用配置切换：更新 `QDRANT_URL`、`QDRANT_API_KEY`、`QDRANT_COLLECTION`，滚动重启实例。配置切换不是原子的，应确保实例版本一致，并监控新旧环境同时被访问的窗口。

alias 只重定向请求，不会复制 payload 或向量。必须先完整写入和验证 candidate Collection。

### 阶段 7：观察与收尾

观察期至少覆盖一个业务峰值和一次增量同步周期。确认：

- Cloud 查询和端到端延迟稳定；
- optimizer/indexing 正常；
- 同步 lag、失败率和降级率达标；
- DashScope 费用和 Qdrant Cloud 用量符合预算；
- 本地与 Cloud 结果差异可解释；
- 回滚步骤已演练。

观察期结束后再停止本地写入。旧 Collection/本地实例删除属于单独的不可逆操作，需人工批准；本指南不授权删除。

## 6. 回滚方案

触发条件示例：

- 端到端 P95/P99 连续超阈值；
- Cloud 错误率、超时率或 SQL-only 降级率超阈值；
- point/业务身份对账失败；
- 固定评测集显著退化；
- 版本混查、漏数、重复 point 或回源失败；
- 成本异常增长。

回滚：

1. 停止向新 Collection 放量，但保留现场只读；
2. alias 原子切回旧 Collection，或回滚应用的 Qdrant 配置；
3. 确认 SQL-only 降级仍可用；
4. 不回滚 MySQL；
5. 保存脱敏指标、错误码、Collection 状态和同步 cursor；
6. 修复后从成功游标重放或重新全量构建 candidate；
7. 重新完成数据、质量和性能验收再切流。

切流前不得删除旧 Collection。模型或投影规则升级时也遵循“新建、回填、验证、alias 切换、观察、再清理”。不同 embedding 模型的向量不能在同一向量空间混用。

## 7. 监控、备份与恢复

### 7.1 最小监控集

Qdrant/Cloud：

- Cluster/Collection 健康状态；
- point 数、indexed vector 数、待索引量和 optimizer 状态；
- CPU、内存、磁盘/存储、网络；
- 请求 QPS、P50/P95/P99、超时、429 和 5xx；
- 各 named vector 查询延迟。

应用链路：

- embedding/rerank 延迟、失败、限流和费用；
- 同步 scanned/upserted/skipped/deleted/failed；
- 复合 cursor 和同步 lag；
- MySQL 回源缺失率；
- SQL-only 降级次数、原因和持续时间；
- 查询使用的 Collection/alias、模型和 vector version。

### 7.2 告警原则

阈值必须根据基线压测设定，不能照搬通用数字。至少建立：可用性、尾延迟、错误率、同步落后、point 数异常变化、存储接近配额、provider 限流和降级率告警。

### 7.3 备份策略

Qdrant 是派生索引，恢复优先级：

1. MySQL + 固定代码/模型配置全量重建；
2. Qdrant snapshot 加速同版本恢复；
3. 本地旧 Collection 仅作迁移回滚，不作为长期唯一备份。

迁移前为本地 Collection 创建快照并验证可读；Cloud 上线后按套餐能力配置备份/快照，并实际做恢复演练。快照必须与 Qdrant 版本、Collection schema、模型 ID、vector version 和生成时间关联。不要只验证“快照文件存在”。

不要手工解包、合并或复制 Qdrant segment/WAL。若 Cloud 套餐或版本对 snapshot 导入有约束，以 Cloud 控制台和当前官方文档为准；无法保证兼容时，从 MySQL 重建。

## 8. 安全与数据治理

- MySQL 使用只读账号和最小表权限；
- Qdrant Key 与 DashScope Key 分离、定期轮换；
- 禁止把 Key 写进 `mcp.json`、URL、日志、测试 fixture 或提交历史；
- payload 只保存回源必需字段；
- Embedding 前继续执行现有白名单投影与脱敏；
- 不记录完整客户 Brief、完整达人原文、完整向量或完整 provider 响应；
- Cloud 项目成员和 API Key 权限遵循最小权限；
- 删除本地实例、Collection 或 snapshot 必须单独审批。

## 9. 验收清单

### 代码与配置

- [ ] MCP real-mode 配置使用 DashScope 和 Qdrant Cloud 变量；
- [ ] 代码读取 `QDRANT_API_KEY`，密钥未进入仓库或日志；
- [ ] `QDRANT_VECTOR_SIZE=1024` 与模型输出一致；
- [ ] 复合 cursor 已实现并覆盖边界测试；
- [ ] 稳定 point ID/历史策略已确定；
- [ ] stale point 删除与对账已实现；
- [ ] candidate/rerank 上限已收紧。

### Schema 与数据

- [ ] `content`、`commercial` 均为 1024 维 Cosine；
- [ ] `platform` keyword index 已创建；
- [ ] 模型 ID 和 vector version 分布唯一且符合预期；
- [ ] 各平台有效业务身份数量与 MySQL 对账；
- [ ] 重复同步幂等；更新覆盖、删除移除；
- [ ] commercial 可选向量与 payload 标志一致。

### 功能、质量与可靠性

- [ ] 双路召回、合并、回源、硬过滤、rerank 全链路通过；
- [ ] 固定评测集达到约定 Recall@K、MRR/nDCG；
- [ ] P50/P95/P99、错误率和费用在预算内；
- [ ] Qdrant、Embedding、Rerank 故障均能明确降级；
- [ ] alias/config 切流和回滚已演练；
- [ ] 快照恢复或 MySQL 全量重建已演练；
- [ ] 日志抽查无凭据和敏感完整 payload。

## 10. 推荐实施顺序

1. 修正 MCP 配置；
2. 修复复合 cursor；
3. 确定稳定 point ID 和删除策略；
4. 增加 payload index、版本隔离和对账；
5. 收紧召回/rerank 上限并建立评测集；
6. 创建 Cloud 测试 Cluster，导入小样本；
7. 完成全量回填和增量追平；
8. 完成数据、质量、性能、安全验收；
9. alias 或配置小流量切换；
10. 覆盖业务峰值观察并演练回滚；
11. 人工批准后再处理本地资源退役。

## 11. 官方参考

- [Qdrant Cloud](https://qdrant.tech/documentation/cloud/)
- [Collections and named vectors](https://qdrant.tech/documentation/concepts/collections/)
- [Collection aliases](https://qdrant.tech/documentation/concepts/collections/#collection-aliases)
- [Payload indexing](https://qdrant.tech/documentation/concepts/indexing/#payload-index)
- [Points and vector updates](https://qdrant.tech/documentation/concepts/points/)
- [Bulk upload](https://qdrant.tech/documentation/database-tutorials/bulk-upload/)
- [Snapshots](https://qdrant.tech/documentation/concepts/snapshots/)
- [Monitoring](https://qdrant.tech/documentation/guides/monitoring/)
- [Embedding model migration](https://skills.qdrant.tech/qdrant-model-migration/SKILL.md)

## 12. 当前代码定位

- real runtime：`vector-mcp/src/runtime.ts`
- Qdrant schema、校验、upsert 和查询：`vector-mcp/src/vector/real-qdrant.ts`
- 同步、双路召回、回源与 rerank：`vector-mcp/src/vector/pipeline.ts`
- MySQL 读取与 cursor：`vector-mcp/src/db/mysql-source.ts`
- 文本投影和脱敏：`vector-mcp/src/source/projection.ts`
- MCP Tool 入口：`vector-mcp/src/tools/handlers.ts`
- 当前 MCP 配置：`YPmcn/mcp.json`
