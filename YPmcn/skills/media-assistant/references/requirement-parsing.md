# 需求字段边界

`validate_requirement` 接收两类入参：Agent 解析的顶层需求字段 + 可选 `raw_messages`。

需求主表固定为 `customer_demands`；`validate_requirement` 写入 `customer_demands`，字段以 `references/creator_candidate_pool_schema.csv` 的 `字段` 列为准。达人资源库物理表固定为 `xhs_creator_accounts`、`dy_creator_accounts`；字段从需求主表继承，进入候选层后统一落到 `creator_candidate_pool`。

## Ready 阻断

缺少以下任一项 → `status=draft`，不得 `search_creators`：
- `platform`
- `submission_deadline_at`
- `raw_messages_json`
- `budget_min_cents`
- `budget_max_cents`
- `budget_raw`
- `rebate_min_rate`
- `rebate_raw`
- `quantity_total`

预算/单价必须区间化，返点仅下限必填。单值写成闭区间；只给上限时，下限按业务可接受下界归一并保留 `budget_raw` / `rebate_raw`。`rebate_max_rate` 可选，未填时视为无上限。

必填项满足后，客户 Brief 中仍有额外需求时，Agent 参考 `creator_candidate_pool_schema.csv` 做字段匹配并直接复核落库，不需弹窗确认。不确定字段写入模糊项由后端处理，不阻断 `search_creators`。

## 字段精度

| 字段 | 值 |
|---|---|
| `platform` | `"xhs"` / `"dy"`，不是 `xiaohongshu` / `小红书` |
| `budget_*_cents` | 单位 **分**，不是元 |
| `rebate_*_rate` | 单位 **小数**（0.2 = 20%），不是整数 20。`rebate_min_rate` 必填，`rebate_max_rate` 可选 |
| 单值预算 | 写成闭区间 |
| 只有上限 | 下限按业务可接受下界归一 |
| 返点无上限 | 不传 `rebate_max_rate` |
| 无独立字段的筛选条件 | 放入已确认额外需求/`requirements_json` 等价字段 |

## 禁止

- 把 Agent 推断写成 `raw_messages` 并标 `client`/`media`
- 为满足 ready 编造平台/预算/返点/数量/截止日期/ID/版本
- 额外需求字段未匹配就直接筛选
- 用业务调用试错探测 schema
- schema 冲突时继续调
