# search_creators

## 何时调用

已有 provider 接受的当前需求标识时调用。

`search_creators` 只用于在现有达人数据库中按需求字段过滤候选达人。
禁止为此打开浏览器、调用网页搜索、抓取站外页面或把它解释为外部达人发现工具。

## 输入

必填 `id`。

## 输出成功证据

- retain actual returned payload as downstream evidence
- candidate price evidence identifies platform creator-table price tiers
- candidate rebate evidence identifies the supplier default rebate
- requirement rebate thresholds are not presented as actual supplier rebate
- 达人身份以实际返回的 `kwUid` 为准，供应商身份以实际返回的 `supplier_id` 为准。
- 达人价格档位来自对应平台达人表：`kolOfficialPriceL1/L2/L3`、`downloadPriceL1/L2/L3`。
- 返点来自 `creator_supply_offers.supplier_id → core_supplier.default_rebate_rate`。当前关系表没有持久化 `rebate_min_rate/rebate_max_rate` 列。
- 需求的 `rebateMinRate/rebateMaxRate` 只用于硬筛，不是机构实际返点。

## 调用后必须停在哪里

展示实际候选摘要，并分别标注“库内达人价格”“供应商默认返点”“缺失值”。随后以字段形式展示 `demand_count`、`database_candidate_count`、`supply_demand_ratio`、`recommended_mcn_count`、`recommended_manual_count`、`recommended_mcn_manual_ratio`，用 Ask 弹框确认。用户未明确确认前禁止调用 `rank_mcns` 或继续后续步骤；缺少计算输入时停止，不猜测。

## 能力边界

该工具做数据库硬筛，不代表 MCN/野生达人/去重总量三层统计已完成。达人身份、资料和分档价格从平台达人表读取；达人—机构关系经 `creator_supply_offers` 关联，返点从 `core_supplier.default_rebate_rate` 读取。返回中的 `price_cents` 是运行时兼容字段；单个 `price_cents=null` 不能证明达人表没有价格。向量召回只能作为内部软特征，不能覆盖硬条件。

## 错误与停止条件

不得把旧 `requirement_id` 或推测的 candidate pool ID 代入 `id`。
不得把 Spec 目标模型中的 `creator_id`、`supplier_binding_id` 当作当前 MCP 字段，也不得根据昵称、机构名或其他字段猜测 `kwUid`、`supplier_id`。
数据库无结果或结果不足时如实返回，不得自动转为浏览器/互联网搜索。
不得把需求中的返点下限（例如 `rebateMinRate=0.3`）说成某家机构实际返回 30%。
