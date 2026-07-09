# 企微发送 MCP 工具开发指南

> 基于 MockMCP `create_with_distributions` 开发过程中遇到的所有坑和解决方案。
> 适用场景：Agent → MCP 工具 → 后端 API → 企微群发送 + 表单预填。

## 1. 架构设计

```
Agent 调用 create_with_distributions({id, projectName, deadline, supplierIds})
    ↓
MockMCP:
  1. 查 DB 解析 supplier 名称 → UUID
  2. 查 mcn_recommendation_items 获取 MCN 推荐结果
  3. 查 creator_candidate_pool 获取候选池达人
  4. 按 MCN 分组构建 prefillRowsBySupplier
  5. POST 后端 API /api/projects/create-with-distributions/
    ↓
后端 API:
  6. 创建项目 + 分发
  7. 持久化预填行到 core_formdatarow
  8. 调用企微 API 发送通知
    ↓
企微群收到消息，打开表单链接看到预填达人
```

**关键原则**：MockMCP 不直接调用企微 API，而是**转发到后端**。后端持有企微凭据（corp_id / corp_secret），MockMCP 只需 `YPMCN_API_KEY`。

## 2. 环境变量

```bash
# 必需：后端 API 地址和密钥（从 .zshrc 读取）
export YPMCN_API_KEY="ypmcn_xxxxx"
export YPMCN_BACKEND_URL="https://ypmcn.eshypdata.com"  # 默认值

# 可选：如果不用后端代理，直接用企微
export WECOM_WEBHOOK_URL="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx"
```

## 3. 数据库踩坑记录

### 3.1 UUID 格式不一致

**问题**：DB 表使用 `CHAR(32)` 存储 UUID（无连字符），但 Django REST Framework 序列化时自动加连字符（36 字符）。

| 来源 | 格式 | 示例 |
|---|---|---|
| `core_supplier.id` | 无连字符 | `8bc3c2dd9b4e41618a7b57f2a3616c61` |
| 后端 API 返回的 `dist.supplier` | 带连字符 | `8bc3c2dd-9b4e-4161-8a7b-57f2a3616c61` |

**解决**：
- 传给后端 API 的 `prefillRowsBySupplier` 的 key **必须带连字符**（后端用 DRF 反序列化）
- `core_formdatarow` 插入时用无连字符（DB 列是 CHAR(32)）
- 表单 URL 的 `channelId` 用带连字符（匹配后端 API 返回的格式）

```javascript
// 从 DB CHAR(32) 转为带连字符的 UUID
function toDashedUUID(raw) {
  if (raw.includes("-")) return raw;
  return raw.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
}

// 从带连字符的 UUID 转为 CHAR(32)
function toCompactUUID(dashed) {
  return dashed.replace(/-/g, "");
}
```

### 3.2 MySQL JSON 列被 mysql2 自动解析

**问题**：`customer_demands.raw_messages_json` 列类型是 `JSON`，mysql2 会自动解析为 JavaScript 对象（数组），而不是字符串。

```javascript
// ❌ 错误：raw_messages_json 是数组，不是字符串
const text = row.raw_messages_json;  // [{role: "client", content: "..."}]
text.includes("粉丝");  // 不会匹配，text 是对象

// ✅ 正确：先提取实际文本内容
const rawData = row.raw_messages_json;
const text = typeof rawData === "string" ? rawData :
  Array.isArray(rawData) ? rawData.map(m => m.content || "").join(" ") :
  JSON.stringify(rawData || "");
```

### 3.3 外键约束

**问题**：`core_distribution` 有 FK 指向 `core_project` 和 `core_supplier`，MockMCP 合成的 ID 无法满足约束。

**解决**：MockMCP 不直接写 `core_distribution`，完全依赖后端 API 创建分发记录。try/catch 容错。

```javascript
// ❌ 不要直接 INSERT core_distribution
// ✅ 调后端 API，让它处理
const resp = await fetch(`${BACKEND_URL}/api/projects/create-with-distributions/`, {...});
```

### 3.4 mcn_recommendation_items 列名

**问题**：实际表结构与预期不一致。

| 预期列名 | 实际列名 | 说明 |
|---|---|---|
| `demand_id` | `customer_demand_id` | CHAR(32)，有 FK 到 customer_demands |
| 无 | `item_id` | AUTO_INCREMENT 主键，INSERT 时不要包含 |

```sql
-- ✅ 正确的 INSERT
INSERT INTO mcn_recommendation_items 
  (mcn_run_id, customer_demand_id, platform, mcn_id, ...) 
VALUES (?, ?, ?, ?, ...)

-- ❌ 错误的列名
INSERT INTO mcn_recommendation_items (demand_id, ...)  -- 不存在
```

### 3.5 creator_candidate_pool 的 id vs kw_uid

**问题**：`creator_candidate_pool.kw_uid` 存的是 MD5 hash，对应 `xhs_creator_accounts.id`，**不是** `xhs_creator_accounts.kw_uid`。

```javascript
// ✅ 正确：用 id 查
const [creators] = await db.query(
  "SELECT nickname FROM xhs_creator_accounts WHERE id = ?",
  [candidate.kw_uid]
);

// ❌ 错误：用 kw_uid 查
const [creators] = await db.query(
  "SELECT nickname FROM xhs_creator_accounts WHERE kw_uid = ?",
  [candidate.kw_uid]  // 查不到！
);
```

## 4. 表单字段推导

### 4.1 需求文本 → 表单列

`validate_requirement` 应返回 `suggested_columns`，Agent 传给 `create_with_distributions`。若 Agent 未传，MockMCP 从需求文本自动推导。

```javascript
function buildSuggestedColumns(rawText, platform) {
  const cols = [
    {key: "talentName", name: "达人名称", type: "text", required: true, sort_order: 1},
  ];
  // 按关键词匹配
  if (rawText.includes("粉丝")) cols.push({key: "followers", name: "粉丝数", type: "number"});
  if (rawText.includes("互动")) cols.push({key: "avgInteract", name: "近30天互动量", type: "number"});
  if (rawText.includes("内容类型") || rawText.includes("图文") || rawText.includes("视频"))
    cols.push({key: "contentType", name: "内容类型", type: "single_select", options: ["图文","视频","直播","混合"]});
  if (rawText.includes("垂类") || rawText.includes("赛道"))
    cols.push({key: "category", name: "垂类/赛道", type: "text"});
  cols.push({key: "price", name: "报价", type: "number", required: true});
  cols.push({key: "homepage", name: "主页链接", type: "link"});
  return cols;
}
```

**优先级**：Agent 显式传入的 `columns` > 需求文本推导 > 硬编码默认值（4 个基础字段）

## 5. 候选池达人 → 预填数据

### 5.1 按 MCN 精确分组

```javascript
// 1. 从 mcn_recommendation_items 获取推荐的 MCN 列表
const [mcnItems] = await db.query(
  "SELECT DISTINCT mcn_id FROM mcn_recommendation_items WHERE mcn_run_id = ?",
  [mcnPlanId]
);
const recommendedMcnIds = new Set(mcnItems.map(m => m.mcn_id));

// 2. 对每个 supplier，找到匹配的 mcn_id
const prefillRowsBySupplier = {};
for (const [supplierName, supplier] of supplierMap) {
  const matchingMcnId = [...recommendedMcnIds].find(mid =>
    mid === supplier.id || mid === supplier.name || mid === supplierName
  );
  if (!matchingMcnId) continue;  // 该 supplier 在本次候选池中无匹配

  // 3. 查该 MCN 在候选池中的达人
  const [candidates] = await db.query(
    "SELECT platform, kw_uid FROM creator_candidate_pool WHERE mcn_id = ? LIMIT 30",
    [matchingMcnId]
  );

  // 4. 查达人详情
  const rows = [];
  for (const c of candidates) {
    const table = c.platform === "dy" ? "dy_creator_accounts" : "xhs_creator_accounts";
    const [creators] = await db.query(
      `SELECT nickname, kol_official_price_l1, kw_user_url FROM \`${table}\` WHERE id = ?`,
      [c.kw_uid]
    );
    if (creators[0]) {
      rows.push({
        talentName: creators[0].nickname,
        platform: c.platform === "dy" ? "抖音" : "小红书",
        price: Number(creators[0].kol_official_price_l1) || 0,
        homepage: creators[0].kw_user_url || "",
      });
    }
  }

  // 5. key 必须用带连字符的 UUID（传给后端 API）
  if (rows.length > 0) {
    prefillRowsBySupplier[toDashedUUID(supplier.id)] = rows;
  }
}
```

**关键**：
- 候选池中 `mcn_id` 来自 `xhs_creator_accounts.organization`（组织名称）
- 匹配逻辑基于 supplier 名称与 MCN 组织名的精确匹配
- **不会串 MCN**——每个 supplier 只得到自己 MCN 的达人

## 6. 表单 URL 拼接

```javascript
// ✅ 正确：从后端 response 取参数
const dist = backendResult.distributions.created[0];
const formUrl = `https://ypmcn.eshypdata.com/form?projectId=${project.id}&channelId=${dist.supplier}&token=${dist.token}`;
```

**关键**：
- `channelId` 用 `dist.supplier`（带连字符的 supplier UUID），**不要**用 `dist.id`（分发 ID）
- `token` 用 `dist.token`（后端生成的表单访问令牌）

## 7. Hooks 门控关系

MockMCP **不实现任何 hook 逻辑**。所有门控在插件层（`YPmcn/src/index.ts`）处理：

| Hook | 检查内容 | 位置 |
|---|---|---|
| `before_tool_call` | 角色检查（仅 media/procurement） | 插件层 |
| `before_tool_call` | deadline 未来时间校验 | 插件层 |
| `before_tool_call` | supplierIds 非空校验 | 插件层 |
| `before_tool_call` | usageScope 归一化为 "project" | 插件层 |
| `before_tool_call` | bash/curl 直连阻断 | 插件层 |
| `after_tool_call` | 发送成功后设置等待锁 | 插件层 |

MockMCP 只负责：参数解析 → DB 查询 → 构建请求 → 转发后端 → 返回结果。

## 8. 测试方法

### 8.1 直接调后端 API（最快验证）

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $YP_WECOM_API_KEY" \
  "https://ypmcn.eshypdata.com/api/projects/create-with-distributions/" \
  -d '{"projectName":"测试","deadline":"2026-07-25T18:00:00+08:00","usageScope":"project","platform":"小红书","columns":[...],"supplierIds":["uuid"],"sendWechatNotification":true,"prefillRowsBySupplier":{...}}'
```

### 8.2 通过 MockMCP 完整链路

```bash
# 启动 MockMCP
node mock-mcp.mjs &

# validate → search → rank_mcns → create_with_distributions
curl -X POST http://localhost:19876/sse -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"create_with_distributions","arguments":{...}}}'
```

### 8.3 Playwright 打开表单验证

```bash
export PWCLI="$HOME/.codex/skills/playwright/scripts/playwright_cli.sh"
"$PWCLI" open "https://ypmcn.eshypdata.com/form?projectId=xxx&channelId=xxx&token=xxx" --headed
sleep 4
"$PWCLI" snapshot
```

### 8.4 DB 直查验证

```sql
-- 检查预填行是否写入
SELECT row_index, row_data FROM core_formdatarow 
WHERE project_id = 'xxx' ORDER BY row_index;

-- 检查分发状态
SELECT id, row_count, status FROM core_distribution 
WHERE project_id = 'xxx';
```

## 9. 常见错误速查

| 错误 | 原因 | 解决 |
|---|---|---|
| `core_formdatarow` 插入 0 行 | `prefillRowsBySupplier` key 无连字符，后端不识别 | key 加连字符 |
| 表单显示"链接无效" | `channelId` 用了 distribution ID 而非 supplier UUID | 用 `dist.supplier` |
| 字段数始终 4 个 | JSON 列被自动解析为对象，文本提取失败 | 判断类型后提取 `.content` |
| `mcn_recommendation_items` FK 失败 | `customer_demand_id` 不存在于 `customer_demands` | 确保用 `dbValidateRequirement` 生成的 demand ID |
| `core_distribution` INSERT 失败 | FK 约束不满足 | 不要直写，用后端 API |
| 达人查不到 | `kw_uid` 对应 `xhs_creator_accounts.id` 而非 `.kw_uid` | 用 `WHERE id = ?` |
| 预填达人为 0 | supplier 名称和 MCN 组织名不匹配 | 检查 `core_supplier.name` 与 `creator_candidate_pool.mcn_id` |
