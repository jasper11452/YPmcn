# 需求入口

用户输入 Brief → Agent 对照 `creator_candidate_pool_schema.csv` 解析字段 → 构造 JSON 调 `validate_requirement`

## 表与字段口径

需求主表固定为 `customer_demands`；`validate_requirement` 写入 `customer_demands`，字段以 `references/creator_candidate_pool_schema.csv` 的 `字段` 列为准。达人资源库物理表固定为 `xhs_creator_accounts`、`dy_creator_accounts`；字段从需求主表继承，按平台可用列匹配，候选中间层仍是 `creator_candidate_pool`。

## 字段精度

| 字段 | 规则 |
|---|---|
| `platform` | `"xhs"`（小红书）、`"dy"`（抖音）。**禁止** `xiaohongshu` / `小红书` |
| `budget_min_cents` | 单位 **分**。预算/单价必须区间化；原文只给上限时下限按业务可接受下界归一 |
| `budget_max_cents` | 单位 **分**。3万 → `3000000` |
| `rebate_min_rate` / `rebate_max_rate` | 单位 **小数**。20% → `0.2`，**禁止**传 `20`。`rebate_min_rate` 必填，`rebate_max_rate` 可选（未填时视为无上限） |
| 无独立字段的筛选条件 | 放入 `requirements_json` |

继续前必填项：`platform`、`submission_deadline_at`、`raw_messages_json`、`budget_min_cents`、`budget_max_cents`、`budget_raw`、`rebate_min_rate`、`rebate_raw`、`quantity_total`。缺任一项不可继续。返点仅下限必填，`rebate_max_rate` 可选（未填时视为无上限）。

字段名与 CSV `字段` 列完全一致（蛇形命名）。额外需求必须参考 `creator_candidate_pool_schema.csv` 匹配到需求表字段或达人筛选字段，直接复核落库，不需弹窗确认。

## 调用后

- `status=draft`：展示最多 3 个缺失项/模糊点用弹窗问用户
- `status=ready`：直接展示摘要（平台、数量、deadline、预算/返点区间等），进入 `search_creators`
- 用户修改 Brief：重新解析 → 调 `validate_requirement`
- `VERSION_CONFLICT` → 停，让用户选"重新校验/放弃/强制覆盖"

**参考**：CSV 字段来源 `references/creator_candidate_pool_schema.csv`
