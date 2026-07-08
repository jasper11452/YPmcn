# 需求入口

## 流程总览

```
用户输入 Brief
→ Agent 对照 creator_candidate_pool_schema.csv 解析字段
  → 先满足必填字段（platform、demand_id、demand_version 等标注"必填"的字段）
  → 再匹配非必填字段到 CSV 表头（字段名精确匹配）
  → 语义模糊的表头或字段值 → 用 askuserquestion 弹窗让用户澄清
→ 构建完整 JSON 结构，字段名与 CSV"合并结果"列完全对应
→ 调用 validate_requirement，将 JSON 作为 raw_messages 的内容传入
```

Brief 入口的第一条业务工具调用为 `validate_requirement`。但在此之前，**Agent 必须先将用户自然语言 Brief 解析成结构化 JSON，字段名与 `creator_candidate_pool_schema.csv` 的"合并结果"列完全对应**，然后再发送给 `validate_requirement`。

## 字段解析规则

### 1. 读取 Schema

Agent 必须始终以 `creator_candidate_pool_schema.csv` 作为唯一字段权威来源：

- 字段名以 CSV 的"合并结果"列为准（如 `followercount`、`avglike`、`kol_official_price_l1`）
- 必填字段：CSV 末尾 `id` 到 `updated_at` 共 17 行标注"必填"的字段
- 非必填字段：CSV 中所有达人属性字段（`kw_uid` ~ `grow_blogger_type_label`）+ 标注"可空"的字段
- 字段说明从 CSV 的"抖音说明"/"小红书说明"列获取；两说明不一致时标注"请按业务口径确认"的字段，需要用户澄清

### 2. 解析优先级

| 优先级 | 动作 |
|---|---|
| P0 | 从原文提取 `platform`、`quantity_total`、`submission_deadline_at`、`budget_min_cents`/`budget_max_cents`、`content_requirements` 等必填业务字段 |
| P1 | 匹配原文中出现的达人筛选条件到 CSV 达人属性字段（`followercount`、`content_type_label`、`gender` 等） |
| P2 | 原文未涉及的字段保留 null，不编造值 |
| P3 | 语义模糊的表头或字段值 → 用 `askuserquestion` 弹窗让用户澄清 |

### 3. 语义模糊判定

以下情况必须用 `askuserquestion` 弹窗确认，不得自行推断：

- CSV 备注标注"请按业务口径确认"的字段（如 `kol_official_price_l1` 的"1-20S 官方视频报价" vs "图文官方报价"）
- 用户表述包含口语化筛选条件，但有多种 CSV 字段匹配可能（如"互动高" → 需澄清是 `avglike`/`avgcomment`/`avginteract`/`interaction_rate` 中的哪一个）
- 数字、范围、阈值不明确的 KPI（如"粉丝不多" → 需澄清具体 `followercount` 范围）
- CSV 多平台说明不一致且用户原文不足判定口径的字段
- 用户原文出现 CSV 中不存在的筛选概念（→ 返回告知不在当前数据范围，询问是否忽略或停止）

### 4. 构造 JSON

解析完成后，Agent 构造结构化 JSON，结构如下（字段名与 CSV "合并结果"列完全一致）：

```json
{
  "platform": "xhs",
  "quantity_total": 10,
  "submission_deadline_at": "2026-07-20T18:00:00+08:00",
  "submission_deadline_raw": "7月20日前",
  "budget_min_cents": null,
  "budget_max_cents": 500000,
  "budget_raw": "单账号预算5000元",
  "followercount": {"min": 100000, "max": 500000},
  "content_type_label": ["美妆", "护肤"],
  "gender": "female",
  "age2_rate": {"min": 0.3},
  "female_rate": {"min": 0.7},
  "kol_official_price_l1": {"max": 30000},
  "note": "2026夏季新品推广",
  "project_name": "夏季新品",
  "brand": "XX品牌",
  "product": "XX精华液"
}
```

**约束**：
- 字段名必须与 CSV "合并结果"列完全一致（蛇形命名）
- 范围值用 `{"min": x, "max": y}` 对象表示，单边约束只传存在的边
- 枚举值用数组或字符串原文
- 原文明确提及但无对应 CSV 字段的筛选条件放入 `raw_conditions_json` 内部字段
- 不得编造原文未提供的信息

## 调用 validate_requirement

### 请求边界

当前生产 schema：

| 字段 | 类型 | 必填 | 来源 |
|---|---|---|---|
| `raw_messages` | array[object] | 是 | 用户/媒介原始消息 + Agent 解析的结构化 JSON |
| `project_context` | object 或 null | 否 | 用户明确提供的项目上下文 |
| `existing_demand_id` | string 或 null | 否 | 既有 MCP 成功响应 |
| `existing_demand_version` | integer 或 null | 否 | 既有 MCP 成功响应 |

结构化的解析 JSON 放入 `raw_messages` 中，与原文共存，Agent 解析层不替换原文：

```json
{
  "raw_messages": [
    {"role": "client", "content": "小红书找 10 个美妆博主，单账号预算 5000 元"},
    {"role": "agent", "content": "<结构化 JSON>"}
  ],
  "project_context": {
    "project_name": "夏季新品"
  }
}
```

不得发送 `trace_id`、`idempotency_key`、`parsed_requirement`、`parsed_requirement_draft` 或 gate 字段。

### raw_messages

- 保留原文，不把 Agent 推断伪装为客户事实。
- 每个元素使用对象；推荐包含 `role` 与 `content`。
- `role` 优先使用 `client`、`media`、`agent`、`system`。
- 用户原文用 `client`；媒介转述用 `media`；Agent 的解析结构化 JSON 用 `agent`。
- Agent 解析层放在 `role: "agent"` 的消息中，格式为 JSON 字符串，与 `role: "client"` 的原始消息并列。
- 只有原文确实提供时间时才带 `sent_at`；未知时省略或按运行时 schema 使用 null，不得用当前时间伪造。

## 结果处理

收到 `validate_requirement` 响应后：

- `success=false`：展示错误摘要，停止。
- `success=true, status=draft`：只根据 MCP 返回的 `missing_fields`、`blocking_fields`、`clarifying_questions` 展示最多 3 个缺失必填项或语义模糊点，并按 `requirement-draft` 模式用 `askuserquestion` 弹窗让媒介补齐/暂缓/放弃；不自行推断缺失项。
- `success=true, status=ready`：展示结构化 brief 摘要（平台、数量、deadline、预算/内容要求、数据指标和表单字段影响），按 `confirm-structured-brief` 模式用 `askuserquestion` 弹窗等待媒介确认。确认后才调用 `search_creators`。
- 用户实质修改 Brief：无需先确认是否重新校验，Agent 重新解析 → 构造结构化 JSON → 追加到 `raw_messages` 后再次调用 `validate_requirement`。若修改影响后续不可逆动作，再用 `askuserquestion` 弹窗确认继续或暂停。

结构化需求由 MCP 在响应中返回并落库。Agent 不在请求中发送独立 `parsed_requirement` 顶层字段，解析层以 `role: "agent"` 消息嵌入 `raw_messages`。

## 版本冲突处理

当 `validate_requirement` 返回 `VERSION_CONFLICT` 错误（`success=false, error.code=VERSION_CONFLICT`）时，表示传入的 `existing_demand_version` 与服务端当前版本不一致。标准处理流程：

1. **停止当前操作**：不继续使用过时版本推进后续流程。
2. **展示冲突摘要**：告知媒介"需求版本已更新，需重新校验"，展示服务端返回的当前版本号（`server_demand_version`）。
3. **按 `askuserquestion`（`requirement-modify` 模式）询问**媒介下一步：重新校验 / 放弃本次修改 / 强制覆盖（需媒介明确授权）。
4. **媒介选择重新校验**：不传 `existing_demand_id` 和 `existing_demand_version`，Agent 重新解析最新 Brief → 构造结构化 JSON → 调用 `validate_requirement`，获取最新版本。
5. **不可自动重试**：版本冲突表明服务端数据已被其他操作更新，盲目用旧版本覆盖可能导致数据丢失。

`VERSION_CONFLICT` 与一般的 `success=false` 不同——前者有明确的恢复路径（重新校验），后者通常是参数错误或服务异常，按错误摘要处理即可。

## 参考

- 字段权威来源：`references/creator_candidate_pool_schema.csv`（"合并结果"列即为字段名）
- 解析结果放入 raw_messages 的 agent 角色消息中
- 交互模式参考 [用户交互模式](ask-user-question-patterns.md) 的 `requirement-draft` 弹窗
