# validate_requirement

## 何时调用

Brief 首次进入、媒介补充缺失项、客户或媒介修改需求时调用。它是任何需求链路的第一条业务工具。

## 输入

需求主表固定为 `customer_demands`；`validate_requirement` 写入 `customer_demands`，字段以 `references/creator_candidate_pool_schema.csv` 的 `字段` 列为准。达人资源库物理表固定为 `xhs_creator_accounts`、`dy_creator_accounts`；字段从需求主表继承，后续筛选进入 `creator_candidate_pool`。

解析后的需求字段直接作为顶层参数传入，按运行时 `inputSchema` 传：
- 解析字段（`platform`、`quantity_total`、`submission_deadline_at`、`budget_max_cents`、`content_requirements` 等 `customer_demands` 字段）
- 可选 `raw_messages`（保留用户原文）
- 可选 `project_context`、`existing_demand_id`、`existing_demand_version`

解析字段由 Agent 对照 `references/creator_candidate_pool_schema.csv` 解析用户 Brief 后构造。

**字段精度（必守）**：
- `platform` 传 `"xhs"`（小红书）或 `"dy"`（抖音），不为 `xiaohongshu`
- 金额单位**分**：3万 → `budget_max_cents: 3000000`
- 预算/单价区间：必须同时有 `budget_min_cents` 和 `budget_max_cents`；单值写闭区间，只给上限时下限按业务可接受下界归一
- 返点单位**小数**：20% → `rebate_min_rate: 0.2`。`rebate_max_rate` 可选，未填时无上限
- 原文不存在的值传 `null`，不编造

当前继续前必填项：`platform`、`submission_deadline_at`、`raw_messages_json`、`budget_min_cents`、`budget_max_cents`、`budget_raw`、`rebate_min_rate`、`rebate_raw`、`quantity_total`。缺任一项时不可继续候选搜索。返点仅下限必填，`rebate_max_rate` 可选。

必填项满足后，额外需求按 `references/creator_candidate_pool_schema.csv` 匹配到需求表字段或达人筛选字段；字段不确定时写入模糊项并向用户确认。无独立字段的筛选条件落入 `requirements_json` 或等价确认字段。

## 输出成功证据

`success=true`，且 `data.id` 为需求表主键。`status=ready` 时还应有可展示的 `requirement_parsed` 摘要。

`demand_id`、`demand_version` 若后端返回，仅作内部版本字段，不作为 `search_creators`、`rank_mcns` 或 `rank_creators` 入参。

## 调用后必须停在哪里

`status=draft` 时停在补充缺失必填字段。`status=ready` 时直接进入 `search_creators`。

## 禁止

不得为满足 ready 编造平台、数量、deadline、预算、内容要求或返点。
