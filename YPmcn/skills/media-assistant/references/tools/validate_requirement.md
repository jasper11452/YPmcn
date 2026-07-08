# validate_requirement

## 何时调用

Brief 首次进入、媒介补充缺失项、客户或媒介修改需求时调用。它是任何需求链路的第一条业务工具。

## 输入

解析后的需求字段直接作为顶层参数传入，按运行时 `inputSchema` 传：
- 解析字段（`platform`、`quantity_total`、`submission_deadline_at`、`budget_max_cents`、`content_requirements` 等 `customer_demands` 字段）
- 可选 `raw_messages`（保留用户原文）
- 可选 `project_context`、`existing_demand_id`、`existing_demand_version`

解析字段由 Agent 对照 `references/creator_candidate_pool_schema.csv` 解析用户 Brief 后构造。

**字段精度（必守）**：
- `platform` 传 `"xhs"`（小红书）或 `"dy"`（抖音），不为 `xiaohongshu`
- 金额单位**分**：3万 → `budget_max_cents: 3000000`
- 返点单位**小数**：20% → `rebate_min_rate: 0.2`
- 原文不存在的值传 `null`，不编造

无独立字段的筛选条件落入 `requirements_json`。

## 输出成功证据

`success=true`，且 `data` 中有 `demand_id`、`demand_version`、`status`。`status=ready` 时还应有可展示的 `requirement_parsed` 摘要。

## 调用后必须停在哪里

`status=draft` 时停在补充缺失字段。`status=ready` 时停在结构化 brief 确认，展示平台、数量、deadline、预算/内容要求、数据指标、表单字段影响，用户确认后才进入 `search_creators`。

## 禁止

不得为满足 ready 编造平台、数量、deadline、预算、内容要求或返点。
