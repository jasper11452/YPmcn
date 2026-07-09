# RAG 向量库融合实战指南

> 基于 YPmcn 项目从零到一集成向量检索的全过程记录。涵盖模型选型、API 并发测试、索引构建、评分融合、召回评测五个阶段，每个阶段标注踩过的坑和最终方案。

---

## 1. 架构总览

### 1.1 融合前（纯关键词）

```
需求文本 → 关键词提取 → SQL LIKE 匹配 → 评分排序 → 候选池
```

问题：语义理解为零。"职场效率"和"办公提效"在 SQL 里是两个完全不相关的 LIKE 条件。

### 1.2 融合后（关键词 + 向量双路召回）

```
需求文本
  ├─→ 关键词提取 → SQL 硬筛（城市/预算/关键词 LIKE）
  │                              ↓
  │                        ~200 candidates
  │                              ↓
  ├─→ API Embedding → Cosine 相似度 ──┐
  └─→ BM25 关键词检索 ────────────────┤
                                       ↓
                                  RRF 融合
                                       ↓
                                  [0,1] 归一化
                                       ↓
                          final = 0.4×kw + 0.6×vec
                                       ↓
                                  Top 50 入池
```

关键设计决策：
- **硬筛在前，向量在后**：先用 SQL 把候选从 500 缩到 ~200，再对精筛结果做向量排序。避免对全库做无意义的向量计算。
- **RRF 融合而非加权求和**：密集检索（Cosine）和稀疏检索（BM25）的原始分数尺度不同，RRF（Reciprocal Rank Fusion）按排名融合更鲁棒。
- **向量分数归一化到 [0,1]**：RRF 原始分数在 0.015-0.033 范围，不归一化会被关键词分数（0-1）完全淹没。

---

## 2. Embedding 模型选型

### 2.1 候选模型对比

在 SiliconFlow 免费层实测：

| 模型 | 维度 | 单条耗时 | batch=32 耗时 | 500条预估 | 结论 |
|---|---|---|---|---|---|
| `Qwen/Qwen3-Embedding-8B` | 4096 | **40s+** | 超时 | 3.75 小时 | ❌ 免费层不可用 |
| `BAAI/bge-large-zh-v1.5` | 1024 | 0.48s | **1.18s** | **17 秒** | ✅ 首选 |

### 2.2 踩坑记录

**坑 1：盲目选大模型。** Qwen3-Embedding-8B 是 8B 参数的大模型，免费层吞吐极低。批量请求直接 Socket 断开（`UND_ERR_SOCKET: other side closed`），单条 40 秒超时。不是模型不行，是 API tier 不匹配。

**教训：先测并发，后选模型。** 不要看论文 benchmark 选模型，要看实际 API 可用性。

```bash
# 快速测试脚本：对比不同 batch size 的吞吐
for batch in 1 4 8 16 32; do
  curl -s --max-time 30 -X POST "https://api.siliconflow.cn/v1/embeddings" \
    -H "Authorization: Bearer $KEY" \
    -d "{\"model\":\"BAAI/bge-large-zh-v1.5\",\"input\":[...],\"encoding_format\":\"float\"}" \
    -w "batch=$batch %{time_total}s\n" -o /dev/null
done
```

**坑 2：维度不兼容切换。** Qwen3 是 4096 维，BAAI 是 1024 维。中途换模型必须全量重建索引，不能混用。220 条 Qwen3 向量全部作废。

**教训：建索引时把 model 名写入 JSON 元数据**，加载时校验维度，发现不匹配自动提示重建。

### 2.3 最终选型

```
模型: BAAI/bge-large-zh-v1.5
供应商: SiliconFlow (api.siliconflow.cn)
维度: 1024
吞吐: ~30 条/秒 (batch=32)
中文评测: C-MTEB 排名前 3
成本: 免费层足够 500 条规模
```

---

## 3. 向量索引构建

### 3.1 文本预处理

从 MySQL 创作者的四个标签字段提取文本：

```javascript
// 每个创作者的 embedding 文本 = 四字段去重拼接
const tags = [
  ...content_type_label.split(/[,，、]/),   // "教育职场、学习方法"
  ...content_theme_label.split(/[,，、]/),  // "知识分享、干货输出"
  ...industry_tag_label.split(/[,，、]/),   // "教育培训"
  ...talent_type_label.split(/[,，、]/),    // "腰部达人"
];
const uniqueTags = [...new Set(tags)];
const text = uniqueTags.sort().join(" | ");
// → "学习方法 | 教育职场 | 知识分享 | 腰部达人 | ..."
```

### 3.2 增量保存 + 断点续传

**坑 3：全量写入一次保存。** 第一个版本等所有 500 条 embed 完才写文件，API 中途超时或进程被杀，全部丢失。

```javascript
// ❌ 错误：批量 embed → 全量写文件（中途崩溃全丢）
const allVectors = [];
for (const batch of batches) {
  allVectors.push(...await embed(batch));
}
writeFileSync(OUT, JSON.stringify({ points: allVectors }));

// ✅ 正确：每批 embed 后增量写文件
const points = loadExistingPoints(); // 断点续传
for (const batch of remaining) {
  points.push(...await embed(batch));
  writeFileSync(OUT, JSON.stringify({ points })); // 每批保存
}
```

**教训：索引构建脚本必须支持断点续传。** 长耗时任务（即使只有 17 秒）也可能被中断。

### 3.3 索引文件结构

```json
{
  "schemas": [{
    "collectionName": "creator_tags",
    "vectorSize": 1024,
    "distance": "Cosine"
  }],
  "model": "BAAI/bge-large-zh-v1.5",
  "savedAt": "2026-07-09T...",
  "points": [
    {
      "id": "xhs:xhs_1000000123:content:v2",
      "vector": [0.0123, -0.0456, ...],  // 1024 维
      "payload": {
        "platform": "xhs",
        "kw_uid": "xhs_1000000123",
        "raw_tags": ["教育职场", "学习方法", ...],
        "normalized_text": "教育职场 | 学习方法 | ..."
      }
    }
  ]
}
```

关键设计：
- `id` 格式：`{platform}:{kw_uid}:{tag_type}:{version}`，保证可溯源
- `payload.kw_uid` 与 `creator_candidate_pool.kw_uid` 对齐，O(1) 查表
- `normalized_text` 用于 BM25 检索

---

## 4. 查询端集成

### 4.1 异步 Embedding 调用

```javascript
// 查询时实时调用 API 获取 query embedding
async function realEmbed(texts) {
  const resp = await fetch("https://api.siliconflow.cn/v1/embeddings", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "BAAI/bge-large-zh-v1.5",
      input: texts,
      encoding_format: "float"
    }),
    signal: AbortSignal.timeout(15000),  // 15s 超时保底
  });
  return (await resp.json()).data
    .sort((a, b) => a.index - b.index)  // API 不保证顺序！
    .map(d => d.embedding);
}
```

**坑 4：API 返回顺序不保证。** SiliconFlow 的 `data[].index` 字段标注原始输入位置，必须按 index 排序后再取 embedding，否则向量和文本对不上。

### 4.2 双路检索 + RRF 融合

```javascript
async function vectorSearch(queryText) {
  const points = loadVectorIndex();               // 500 × 1024-dim
  const qVec = (await realEmbed([queryText]))[0]; // 1 × 1024-dim

  // 密集检索：Cosine 相似度
  const dense = points.map(p => ({
    kw_uid: p.payload.kw_uid,
    score: cosineSimilarity(qVec, p.vector)
  })).sort((a, b) => b.score - a.score);

  // 稀疏检索：BM25 关键词
  const sparse = bm25Search(queryText, points);   // 基于 tags 文本

  // RRF 融合（k=60）
  const rrf = new Map();
  for (let i = 0; i < dense.length; i++)
    rrf.set(dense[i].kw_uid, 1/(60 + i + 1));
  for (let i = 0; i < sparse.length; i++)
    rrf.set(sparse[i].kw_uid, (rrf.get(sparse[i].kw_uid)||0) + 1/(60 + i + 1));

  return new Map([...rrf].sort((a, b) => b[1] - a[1]));
}
```

### 4.3 分数融合与归一化

**坑 5：不归一化直接加权。** RRF 原始分数在 0.015-0.033 范围，关键词分数在 0-1 范围。`0.4 × kw + 0.6 × vec` 会变成 `0.4 × 0.5 + 0.6 × 0.02 = 0.212`，向量贡献可忽略。

```javascript
// ❌ 错误：RRF 原始值直接加权
r._score = kwScore * 0.4 + vecScore * 0.6;  // vecScore ≈ 0.02, kwScore ≈ 0.5

// ✅ 正确：先归一化到 [0,1] 再加权
const maxV = Math.max(...vecScores, 0.001);
const minV = Math.min(...vecScores);
const range = maxV - minV || 1;
const vNorm = (vecScore - minV) / range;    // 现在 vNorm ∈ [0, 1]
r._score = kwScore * 0.4 + vNorm * 0.6;    // 0.4 × 0.5 + 0.6 × 0.8 = 0.68 ✅
```

---

## 5. 评测体系

### 5.1 RAG 四层评测框架

```
检索评测 → 重排序评测 → 生成评测 → 整体问答评测
   ↑ 本节聚焦
```

### 5.2 黄金测试集构建

为每个需求定义"相关创作者"的判定函数：

```javascript
const GOLDEN = [{
  name: "家居家电测评",
  req_text: "家居家装类、家电测评类、有娃/有宠家庭...",
  relevant: r => {
    const tags = r.content_type_label.toLowerCase();
    return ["家居","家电","测评","收纳","清洁"].some(k => tags.includes(k));
  },
  relevantDesc: "家居/家电/家庭类"
}];
```

**坑 6：黄金集太宽导致 Recall 失真。** 第一版把 35-50% 的创作者标记为"相关"，Recall@10 始终 4.8%，三种方法几乎无差异。不是因为方法差，而是黄金集区分度不够。

**教训：** 黄金标注应该是"高度匹配"而非"弱相关"。用人工标注 20-30 对精确匹配，而非关键词自动标注。

### 5.3 核心指标

| 指标 | 含义 | 何时用 |
|---|---|---|
| **Recall@K** | 前 K 个结果中包含多少相关项 | 评测"有没有找回来" |
| **MRR** | 第一个相关结果排第几的倒数均值 | 评测"找回来后排得靠不靠前" |
| **NDCG** | 考虑多级相关度的排序质量 | 黄金集有多级标注时使用 |
| **Hit Rate** | 前 K 中至少命中一个相关 | 对比不同检索方案 |

### 5.4 评测脚本模板

```javascript
function computeMetrics(rankedIds, relMap, Ks = [3, 5, 10, 20]) {
  const relPositions = [];
  rankedIds.forEach((id, rank) => {
    if (relMap.get(id)) relPositions.push(rank + 1);
  });

  const total = relPositions.length;
  const result = {};
  for (const K of Ks) {
    const topK = relPositions.filter(p => p <= K).length;
    result[`Recall@${K}`] = total > 0 ? topK / total : 0;
    result[`MRR@${K}`] = total > 0
      ? relPositions.filter(p => p <= K).reduce((s, p) => s + 1/p, 0) / total
      : 0;
  }
  return result;
}
```

---

## 6. 踩坑清单

| # | 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|---|
| 1 | 大模型 API 不可用 | 40s 超时，Socket 断开 | 免费层不支持 8B 模型 | 先测并发再选模型 |
| 2 | 换模型维度不兼容 | 4096→1024，旧向量作废 | 没记录 model 元数据 | JSON 存 model 字段 |
| 3 | 全量写入一次保存 | 进程被 kill 数据全丢 | 没做增量保存 | 每 batch 写一次文件 |
| 4 | API 返回顺序错乱 | embedding 和文本对不上 | API 不保证顺序 | 按 `data[].index` 排序 |
| 5 | 不归一化直接加权 | 向量贡献为零 | RRF 分数范围太小 | 先 [0,1] 归一化再加权 |
| 6 | 黄金测试集太宽 | 3 方法 Recall 完全一样 | 35%+ 标记为相关 | 人工标注精准匹配 |
| 7 | 候选池太小 | Recall 数值无意义 | 500 人 vs 50% 相关率 | 扩展候选池到 5000+ |

---

## 7. 快速接入 Checklist

对接新的 RAG 库时，按以下顺序验证：

```
□ 1. 选模型：测 3 个 batch size（1/16/32）的实际吞吐
□ 2. 建索引：增量保存 + 断点续传，JSON 存 model 名
□ 3. 验查询：单条 embedding 能正常返回，10s 内
□ 4. 验融合：归一化后向量贡献 > 30%（不是 < 5%）
□ 5. 建黄金集：人工标注 20 对精准匹配
□ 6. 跑评测：对比纯关键词 vs 纯向量 vs 混合
□ 7. 调权重：网格搜索 [0.3, 0.5, 0.7] 找最优
□ 8. 上线：搜索接口加 `vector: N/M candidates` 日志
```

---

## 8. 关键文件清单

| 文件 | 用途 |
|---|---|
| `/tmp/ypmcn-vectors-real.json` | 500 创作者的 1024 维 BAAI 向量索引 |
| `mock-mcp.mjs` L92-175 | `realEmbed()` + `vectorSearch()` + RRF + 归一化 |
| `mock-mcp.mjs` L370-420 | `dbSearchCreators` 中向量融合逻辑 |
| `scripts/build-vector-index.mjs` | 假向量索引构建（128 维，已废弃） |
| `vector-mcp/src/vector/qdrant.ts` | FakeQdrantClient：Cosine/BM25/RRF 参考实现 |
| `vector-mcp/src/providers/siliconflow-embedding.ts` | SiliconFlow API 客户端参考实现 |

---

## 9. 重建索引命令

```bash
# 需要 SILICONFLOW_API_KEY 环境变量
# 重建脚本见上文 4.2 节，核心逻辑：
#   读取 xhs_creator_accounts → 提取 tags → batch embed → 增量保存

# 当前索引状态
python3 -c "
import json
d = json.load(open('/tmp/ypmcn-vectors-real.json'))
print(f'{len(d[\"points\"])} vectors, {len(d[\"points\"][0][\"vector\"])}-dim, model={d[\"model\"]}')
"
# 输出: 500 vectors, 1024-dim, model=BAAI/bge-large-zh-v1.5

---

## 10. 部署与迁移

### 10.1 自包含架构

当前向量检索**不依赖任何独立向量数据库服务**（Qdrant、Milvus、Chroma、Weaviate 等均不需要）：

```
mock-mcp.mjs 启动
  ├─→ 加载 /tmp/ypmcn-vectors-real.json 到内存（一次性）
  ├─→ 查询时：调用 SiliconFlow API 获取 query embedding
  └─→ 内存中做 Cosine 相似度搜索 + RRF 融合
```

核心设计：
- **向量存储**：纯 JSON 文件，启动时 `JSON.parse` 至内存，无外部服务依赖
- **Embedding 计算**：走云端 API（SiliconFlow BAAI/bge-large-zh-v1.5），不部署本地模型
- **搜索执行**：内存 `Array` 操作（`map` + `sort`），500 个 1024 维向量的 Cosine 搜索约 2ms
- **候选池数据**：最终结果仍从 MySQL 查询，向量层只返回排名

### 10.2 部署 checklist

将 `mock-mcp.mjs` 部署到 OpenClaw 或 YP Action 的 MCP Server，只需满足三个条件：

| # | 条件 | 操作 | 不满足的后果 |
|---|---|---|---|
| 1 | **向量索引文件就位** | 复制 `/tmp/ypmcn-vectors-real.json` 到目标环境同路径，或在 `mock-mcp.mjs` 中修改 `VECTOR_INDEX_PATH` | 搜索降级为纯关键词检索，无向量排序 |
| 2 | **环境变量 `SILICONFLOW_API_KEY` 已设置** | `export SILICONFLOW_API_KEY=sk-xxx` 或写入容器 env | query embedding 调用失败，搜索降级为纯关键词 |
| 3 | **MySQL 网络可达** | 确保目标环境能访问同组 MCP 工具的数据库配置 | 向量排名有结果但无法回表查创作者详情 |

验证脚本：

```bash
# 在目标环境运行，确认三要素就绪
test -f /tmp/ypmcn-vectors-real.json && echo "✅ 向量索引存在" || echo "❌ 缺失向量索引"
[ -n "$SILICONFLOW_API_KEY" ] && echo "✅ SILICONFLOW_API_KEY 已设" || echo "❌ 未设 API Key"
curl -s --max-time 5 \
  -H "Authorization: Bearer $SILICONFLOW_API_KEY" \
  "https://api.siliconflow.cn/v1/embeddings" 2>/dev/null >/dev/null \
  && echo "✅ SiliconFlow API 可达" || echo "❌ API 不可达"
```

### 10.3 何种情况下需要重建索引

| 场景 | 是否重建 | 操作 |
|---|---|---|
| 部署到新环境，复制已有 JSON | **否** | 直接复制文件即可 |
| 创作者池扩容（新增创作者） | **是** | 运行构建脚本生成新 JSON |
| 创作者标签字段更新 | **是** | 增量 rebuild：只 embed 有变更的创作者 |
| 更换 embedding 模型 | **是** | 全量重建，旧维度 JSON 直接废弃 |
| 纯扩候选池（不改创作者标签） | **否** | 候选池筛选用 DB，与向量索引无关 |

重建命令：

```bash
export SILICONFLOW_API_KEY=sk-xxx
node scripts/build-vector-index.mjs
```

```
