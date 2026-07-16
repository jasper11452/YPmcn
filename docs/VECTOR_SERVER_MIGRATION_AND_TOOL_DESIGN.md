# 本地向量能力迁移到阿里云 DashVector 与业务工具设计

## 一句话结论

- 几十万条达人数据建议使用阿里云 DashVector Serverless，减少数据库部署、扩容、备份和升级工作。
- 不搬运本地 Qdrant 测试文件，而是从 MySQL 重新生成向量并写入 DashVector。
- 业务仍然只使用 `search_creators` 和 `rank_creators`。
- 向量检索与相关性排序是两个业务工具的内部步骤，不新增面向业务的“向量排序工具”。
- DashVector 或模型服务失败时自动使用 SQL-only，不能阻断正常找达人。

## 一、目标架构

```text
MySQL 达人数据
→ 本地字段清洗与脱敏
→ 百炼 text-embedding-v4
→ DashVector
→ qwen3-rerank
→ MySQL 当前记录复核
→ search_creators / rank_creators 返回结果
```

各组件的责任：

- MySQL：唯一业务事实源，保存达人当前数据。
- DashVector：保存可重建的向量索引，不拥有业务写权限。
- `text-embedding-v4`：把脱敏后的达人标签和需求文本变成向量。
- `qwen3-rerank`：对召回候选做二次相关性排序。
- YPmcn：执行硬筛选、调用向量能力、处理降级并返回结果。

## 二、为什么选择 DashVector

当前预计有几十万条达人数据，使用托管服务的主要收益是：

- 不需要自己维护 Qdrant 容器和数据盘；
- 不需要自己处理高可用、升级和扩容；
- Serverless 可以按使用量和存储量计费；
- 与阿里云服务器、百炼和网络环境更容易统一管理；
- 后续达人数量和查询量增长时，不需要重新规划单机容量。

需要接受的代价：

- DashVector 与 Qdrant 接口不兼容，需要替换数据库 adapter；
- 会增加阿里云服务费用；
- 以后迁出阿里云时仍需重新建立索引。

由于向量可以从 MySQL 重建，迁移和回滚的业务风险可控。

## 三、DashVector 数据结构

当前设计有两类向量：

- `content`：达人类型、内容类型、内容标签、persona、清洗后的简介；
- `commercial`：品牌、品类、场景、功效、成分和 IP 等商业信息。

推荐使用两个 Collection：

```text
creator_content
creator_commercial
```

两个 Collection 使用相同的达人业务 ID：

```text
platform + kwUid + source_snapshot_date
```

共同保存的 Metadata 只包含回源所需信息：

```text
platform
kwUid
source_table
source_row_id
source_snapshot_date
source_updated_at
embedding_model_id
vector_version
```

不写入 DashVector：

- 原始达人文本；
- 昵称、手机号、URL 等身份信息；
- 完整 MySQL 行；
- Embedding 或 Rerank 分数历史；
- API Key、数据库密码；
- 价格、粉丝量等应由 MySQL 判断的硬条件。

当前 `text-embedding-v4` 本地验证维度为 1024。正式创建 Collection 前仍需在测试实例确认模型输出维度，Collection 维度必须与模型一致。

## 四、从本地 Qdrant 迁移到 DashVector

### 推荐方式：从 MySQL 全量重建

不复制本地 Qdrant volume，也不导出测试 point。正式迁移直接从 MySQL 读取最新达人数据，重新脱敏、Embedding 并写入 DashVector。

这样可以：

- 避免把本地测试残留带到云端；
- 确保云端索引来自最新 MySQL 数据；
- 验证正式全量同步流程；
- 保持 DashVector 随时可删除、可重建。

### 迁移步骤

1. 在阿里云购买 DashVector Serverless，选择与业务服务器相同或网络延迟最低的地域。
2. 创建专用 Cluster Endpoint 和 API Key。
3. 创建 `creator_content`、`creator_commercial` 两个 Collection。
4. 将现有 `RealQdrantClient` 替换为 `DashVectorClient` adapter。
5. 保持上层同步、搜索、脱敏、MySQL 回源和 SQL-only 降级接口不变。
6. 使用少量脱敏数据测试写入、查询、Metadata 和删除。
7. 执行首次全量同步：MySQL → 脱敏 → Embedding → DashVector。
8. 对比 MySQL 可同步数量与两个 Collection 的 Doc 数量。
9. 使用真实需求抽样检查召回和 Rerank 结果。
10. 将本地测试环境切换到 DashVector，并保留 Qdrant 一段观察期。
11. 稳定后停止本地 Qdrant，后续使用人工触发的增量同步。

## 五、迁移验收

至少确认：

- 两个 Collection 的达人数量与 MySQL 可同步记录基本一致；
- 同一个达人重复同步不会生成重复 Doc；
- 达人数据更新后可以覆盖同一业务记录；
- 已失效达人不会继续返回；
- `content` 和 `commercial` 查询都能返回正确平台的达人；
- 查询结果会重新读取 MySQL 当前记录；
- DashVector 断开时会自动返回 SQL-only 结果；
- 日志中没有 API Key、数据库密码、原始敏感文本和完整向量；
- 不把向量相似度当成地区、价格、粉丝量或合规判断。

## 六、回滚方式

如果 DashVector 出现问题：

1. 关闭向量检索开关；
2. `search_creators`、`rank_creators` 自动使用 SQL-only；
3. MySQL 保持不变，不执行数据回滚；
4. 必要时临时切回本地或服务器 Qdrant；
5. 修复后从 MySQL 重新建立 DashVector Collection；
6. 抽样验证后恢复向量检索。

DashVector 是派生索引，回滚不应修改 MySQL。

## 七、用户需要提供什么

### 阿里云信息

- 阿里云账号下可购买 DashVector 的权限；
- 目标地域；
- DashVector Serverless 实例；
- Cluster Endpoint；
- 专用 DashVector API Key；
- 阿里云服务器与 DashVector 的网络访问策略；
- 预算与费用告警阈值。

不要把 API Key 发在聊天中。用户只需要把 Key 写入服务器受限 env 文件，并告诉实施人员文件路径。

### MySQL 信息

- MySQL 只读地址和账号；
- 抖音、小红书实际源表；
- 达人唯一身份字段；
- 更新时间或增量游标字段；
- 哪些达人状态允许进入索引；
- 全量同步时间窗口。

### 业务验收材料

- 20～50 条有代表性的真实需求；
- 每条需求期望出现的达人或相关性判断；
- 明显不应出现的达人类型；
- 可接受的查询时间和降级行为。

## 八、环境配置

建议通过受限 env 文件或密钥管理服务提供：

```text
YP_MYSQL_HOST
YP_MYSQL_PORT
YP_MYSQL_USER
YP_MYSQL_PASSWORD
YP_MYSQL_DATABASE
DASHSCOPE_API_KEY
DASHSCOPE_WORKSPACE_ID
DASHVECTOR_API_KEY
DASHVECTOR_ENDPOINT
DASHVECTOR_CONTENT_COLLECTION
DASHVECTOR_COMMERCIAL_COLLECTION
DASHVECTOR_VECTOR_SIZE
```

配置要求：

- API Key 不写入 Git；
- 不在日志中输出完整 Endpoint 凭据或请求头；
- DashVector Key 只授予所需 Collection 权限；
- 测试和生产使用不同的实例或不同的 Collection；
- 配置费用告警和调用量监控。

## 九、用户需要操作什么

用户侧尽量只保留这些动作：

1. 购买 DashVector Serverless；
2. 选择地域并创建实例；
3. 创建 API Key；
4. 配置阿里云网络访问；
5. 把 MySQL 和 DashVector 凭据写入服务器 env 文件；
6. 提供真实需求用于抽样验收；
7. 批准正式切换和回滚窗口。

adapter 开发、全量同步、增量同步、测试和回滚脚本由实施人员完成，不要求业务用户手工操作向量数据。

## 十、向量能力放在哪个工具里

### `search_creators`：硬筛后做相关性召回和初排

推荐流程：

```text
读取需求
→ 解析地区、平台、粉丝量、价格等硬条件
→ MySQL 硬筛
→ DashVector 相关性检索
→ qwen3-rerank 精排
→ MySQL 当前记录复核
→ 返回候选达人
```

向量能力解决的是：“硬条件都满足时，哪些达人和需求内容更匹配？”

例如，客户要找“敏感肌修护、成分讲解能力强”的达人。地区、粉丝量和价格由 MySQL 判断；内容是否匹配由 DashVector 和 Rerank 帮助排序。

### `rank_creators`：对已接受候选做最终业务排序

推荐流程：

```text
接收已接受候选
→ 检查候选状态
→ 读取或重新计算内容相关性
→ 结合价格、覆盖率、历史表现和缺失情况
→ 输出最终排序及解释
```

相关性只是一个软排序因素，不能推翻硬条件，也不能把缺失数据直接当成最差数据。

### 是否需要两个阶段都调用模型

最小方案：

- `search_creators` 执行 DashVector 检索和 Rerank，生成相关候选；
- `rank_creators` 复用相关性结果，并结合业务指标做最终排序。

只有候选数据或需求发生变化时，`rank_creators` 才重新计算相关性，避免重复调用模型增加费用和延迟。

## 十一、是否单独建立“向量排序工具”

### 推荐：不建立公开业务工具

原因：

- 业务用户不需要理解 DashVector、Embedding 或 Rerank；
- 单独工具可能绕过地区、粉丝量、价格和合规等硬筛选；
- 调用方需要自己拼接多个步骤，更容易出错；
- 更换向量服务时会影响公开接口；
- 失败降级无法统一处理。

对用户而言仍然只有：

- `search_creators`：找达人；
- `rank_creators`：排达人。

DashVector 只是内部实现方式。

### 如果工程上需要内部能力

可以保留内部函数或内部服务，但不加入公开业务 Tool 列表。

建议内部名称：`rank_creator_relevance`

最小输入：

```json
{
  "requirement_id": "需求ID",
  "candidates": [
    {"platform": "dy", "kwUid": "达人ID"}
  ]
}
```

在没有需求 ID 时，可临时使用：

```json
{
  "requirement_text": "敏感肌修护，擅长成分讲解",
  "candidates": [
    {"platform": "dy", "kwUid": "达人ID"}
  ]
}
```

候选达人必须已经通过硬筛选。

最小输出：

```json
{
  "status": "ok",
  "retrieval_mode": "vector",
  "ranked_candidates": [
    {"platform": "dy", "kwUid": "达人ID", "rank": 1}
  ],
  "degraded_reason": null
}
```

降级时：

```json
{
  "status": "degraded",
  "retrieval_mode": "sql-only",
  "ranked_candidates": [
    {"platform": "dy", "kwUid": "达人ID", "rank": 1}
  ],
  "degraded_reason": "vector_store_unavailable"
}
```

不向业务返回：

- 原始向量；
- Embedding 模型内部参数；
- DashVector Doc ID；
- 未解释的相似度小数；
- API 请求详情。

## 十二、最终建议

采用：

```text
业务用户
  ├─ search_creators
  │    └─ 内部：MySQL 硬筛 + DashVector + Rerank + MySQL 复核
  └─ rank_creators
       └─ 内部：相关性 + 价格/表现/缺失处理 + 最终解释
```

不要采用：

```text
业务用户
  → search_creators
  → vector_search
  → vector_rank
  → rank_creators
```

后一种方式把内部技术步骤暴露给业务，调用复杂、容易绕过规则，也不利于以后更换向量服务。

## 参考资料

- [DashVector 产品介绍](https://help.aliyun.com/zh/document_detail/2510225.html)
- [DashVector 快速入门](https://help.aliyun.com/zh/document_detail/2510223.html)
- [DashVector 计费说明](https://help.aliyun.com/zh/document_detail/2510232.html)
