# 本地向量数据库迁移到自建服务器与业务工具设计

## 一句话结论

- 本地验证成功后，服务器上重新部署同版本 Qdrant，再从 MySQL 全量重建索引；通常不需要搬运本地测试数据。
- 业务仍然只使用 `search_creators` 和 `rank_creators`。
- 向量检索与相关性排序应作为这两个工具的内部步骤，不新增面向业务的“向量排序工具”。
- Qdrant 或模型服务失败时自动使用 SQL-only，不能阻断正常找达人。

## 一、如何从本地迁移到自建服务器

### 推荐方式：服务器重新建索引

Qdrant 中的数据来自 MySQL，可以重新生成。迁移时推荐在服务器重新读取 MySQL、脱敏、生成向量并写入 Qdrant，而不是复制本地测试库。

这样做的好处：

- 服务器拿到的是最新达人数据；
- 不会把本地测试残留带到服务器；
- 可以顺便验证全量同步流程；
- 出问题时删除 Qdrant collection 后可以重建，不影响 MySQL。

### 迁移步骤

1. 在服务器安装 Docker，并固定 Qdrant 镜像版本。
2. 创建独立数据目录和备份目录。
3. Qdrant 只开放给 YPmcn 服务访问，不直接暴露到公网。
4. 在服务器配置 MySQL 只读连接、DashScope API Key 和 Qdrant 地址。
5. 启动 Qdrant，检查健康状态。
6. 执行首次全量同步：MySQL → 本地脱敏 → `text-embedding-v4` → Qdrant。
7. 检查同步数量、失败数量和抽样搜索结果。
8. 将 YPmcn 的 `QDRANT_URL` 切换到服务器地址。
9. 验证 `search_creators`、`rank_creators` 和 SQL-only 降级。
10. 稳定后再开启按需增量同步。

### 上线检查

至少确认：

- Qdrant 中的达人数量与 MySQL 可同步记录数量基本一致；
- 同一个达人重复同步不会产生重复记录；
- 达人信息更新后可以覆盖旧向量；
- 已失效达人不会继续返回；
- Qdrant 断开时仍能返回 SQL-only 结果；
- 返回达人前会重新读取 MySQL 当前记录；
- 日志里没有 API Key、数据库密码、原始敏感文本和完整向量。

### 回滚方式

如果服务器向量检索有问题：

1. 关闭向量检索开关；
2. `search_creators`、`rank_creators` 自动使用 SQL-only；
3. 保留 MySQL，不做任何回滚；
4. 修复后重新建立 Qdrant collection，再恢复向量检索。

Qdrant 是派生索引，不是业务事实源，因此回滚不应修改 MySQL。

## 二、用户需要提供什么

### 服务器信息

- 服务器 IP 或内网地址；
- SSH 登录方式；
- Linux 系统版本；
- Docker 是否已安装；
- 可使用的数据盘目录；
- 预计达人数量和每月增长量；
- 是否已有域名、HTTPS、VPN 或内网；
- 备份保存位置和保留时间。

初期可参考：4 核 CPU、8 GB 内存、100 GB SSD。最终容量需要根据达人数量、向量维度和历史保留策略估算。

### 网络与权限

- 允许服务器只读访问 MySQL；
- 创建专用 MySQL 只读账号；
- 如果 MySQL 有白名单，加入服务器出口 IP；
- Qdrant 的 6333/6334 端口只对业务服务器或内网开放；
- 不把数据库密码和 API Key 发在聊天中。

### 环境配置

建议通过服务器上的受限 env 文件或密钥管理系统提供：

```text
YP_MYSQL_HOST
YP_MYSQL_PORT
YP_MYSQL_USER
YP_MYSQL_PASSWORD
YP_MYSQL_DATABASE
DASHSCOPE_API_KEY
QDRANT_URL
QDRANT_COLLECTION
QDRANT_VECTOR_SIZE
```

用户只需要告诉实施人员 env 文件路径，不需要发送其中的值。

### 业务确认

用户还需要确认：

- 哪些达人状态允许进入索引；
- 小红书和抖音实际源表及更新时间字段；
- 全量同步时间窗口；
- 增量同步由谁触发；
- 索引最多允许比 MySQL 落后多久；
- 出现失败时通知谁；
- 抽样验收使用哪些真实需求。

## 三、用户需要操作什么

用户侧尽量只保留这些动作：

1. 准备服务器和网络；
2. 创建 MySQL 只读账号并配置白名单；
3. 把凭据写入服务器 env 文件；
4. 提供 20～50 条有代表性的需求用于验收；
5. 抽查排序结果，指出明显不相关的达人；
6. 批准正式切换和回滚窗口。

Docker 部署、Qdrant 配置、全量同步、测试和回滚脚本应由实施人员完成，不要求业务用户手工操作数据库。

## 四、向量能力放在哪个工具里

## `search_creators`：找出并初排达人

推荐流程：

```text
读取需求
→ 解析地区、平台、粉丝量、价格等硬条件
→ MySQL 硬筛
→ 对筛选后的达人做向量相关性排序
→ Rerank 精排
→ 回到 MySQL 检查达人当前状态
→ 返回候选达人
```

向量能力在这里解决的是：“硬条件都满足时，哪些达人和需求内容更匹配？”

例如，客户要找“敏感肌修护、成分讲解能力强”的达人。地区、粉丝量和价格由 MySQL 判断；内容是否匹配由向量检索和 Rerank 帮助排序。

## `rank_creators`：对已接受候选做最终业务排序

推荐流程：

```text
接收已接受候选
→ 检查候选状态
→ 读取内容相关性结果
→ 结合价格、覆盖率、历史表现和缺失情况
→ 输出最终排序及解释
```

这里的相关性只是一个排序因素，不能压过硬条件，也不能把缺失数据直接当成最差数据。

## 是否需要两个阶段都调用模型

最小方案：

- `search_creators` 执行向量检索和 Rerank，生成相关候选；
- `rank_creators` 复用相关性结果，并结合业务指标做最终排序。

如果候选数据在两个阶段之间发生变化，`rank_creators` 可以重新计算相关性，但不应默认重复调用模型，避免增加费用和延迟。

## 五、是否单独建立“向量排序工具”

### 推荐：不建立公开业务工具

原因：

- 业务用户不需要理解 Qdrant、Embedding 或 Rerank；
- 单独工具可能绕过地区、粉丝量、价格、合规等硬筛选；
- 调用方需要自己拼接多个工具，流程更容易出错；
- 将来更换模型或向量数据库时，会影响公开接口；
- 失败降级更难统一处理。

对用户而言，仍然只是：

- `search_creators`：找达人；
- `rank_creators`：排达人。

向量数据库只是内部实现方式。

### 如果工程上确实需要内部工具

可以保留一个仅供 YPmcn 内部调用的能力，但不加入公开业务 Tool 列表。

建议内部名称：`rank_creator_relevance`

#### 最小输入

```json
{
  "requirement_id": "需求ID",
  "candidates": [
    {"platform": "dy", "kw_uid": "达人ID"}
  ]
}
```

也可以在还没有需求 ID 时临时使用：

```json
{
  "requirement_text": "敏感肌修护，擅长成分讲解",
  "candidates": [
    {"platform": "dy", "kw_uid": "达人ID"}
  ]
}
```

必须至少提供 `requirement_id` 或 `requirement_text` 之一。候选达人必须已经通过硬筛选。

#### 最小输出

```json
{
  "status": "ok",
  "retrieval_mode": "vector",
  "ranked_candidates": [
    {"platform": "dy", "kw_uid": "达人ID", "rank": 1}
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
    {"platform": "dy", "kw_uid": "达人ID", "rank": 1}
  ],
  "degraded_reason": "vector_store_unavailable"
}
```

不建议对业务返回：

- 原始向量；
- Embedding 模型内部参数；
- Qdrant point ID；
- 未解释的相似度小数；
- API 请求详情。

## 六、最终建议

采用下面的业务结构：

```text
业务用户
  ├─ search_creators
  │    └─ 内部：SQL 硬筛 + 向量相关性 + Rerank + MySQL 复核
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

后一种方式把内部技术步骤暴露给业务，调用复杂、容易绕过规则，也不利于将来更换实现。
