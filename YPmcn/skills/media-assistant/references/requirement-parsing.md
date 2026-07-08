# 需求字段边界

`validate_requirement` 接收两类入参：Agent 解析的顶层需求字段 + 可选 `raw_messages`。

## Ready 阻断

缺少以下任一项 → `status=draft`，不得 `search_creators`：
- `platforms`
- `quantity_total`
- `submission_deadline_at`
- `content_requirements` 或 `budget_max_cents`/单价条件至少一个

返点不是 ready 阻断。用户没提返点不要为了继续而编造。

## 字段精度

| 字段 | 值 |
|---|---|
| `platform` | `"xhs"` / `"dy"`，不是 `xiaohongshu` / `小红书` |
| `budget_*_cents` | 单位 **分**，不是元 |
| `rebate_*_rate` | 单位 **小数**（0.2 = 20%），不是整数 20 |
| 原文未提的下限 | `null`，不编造 |
| 无独立字段的筛选条件 | `requirements_json` |

## 禁止

- 把 Agent 推断写成 `raw_messages` 并标 `client`/`media`
- 为满足 ready 编造平台/内容/预算/数量/截止日期/ID/版本
- 用业务调用试错探测 schema
- schema 冲突时继续调
