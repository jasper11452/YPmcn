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
- candidate rebate evidence identifies creator-supplier relationship values
- requirement rebate thresholds are not presented as actual supplier rebate
- 达人身份以实际返回的 `kwUid` 为准，供应商身份以实际返回的 `supplier_id` 为准。
- 达人价格档位来自对应平台达人表：`kolOfficialPriceL1/L2/L3`、`downloadPriceL1/L2/L3`。
- 返点来自当前 `kwUid + supplier_id` 的达人—机构关系：`rebate_min_rate/rebate_max_rate`。
- 需求的 `rebateMinRate/rebateMaxRate` 只用于硬筛，不是机构实际返点。

## 调用后必须停在哪里

展示实际候选摘要，并分别标注“库内达人价格”“关系返点”“缺失值”；只有返回证据明确下游 ID 时才继续。

## 能力边界

该工具做数据库硬筛，不代表 MCN/野生达人/去重总量三层统计已完成。达人身份、资料和价格从 `xhs_creator_accounts` 或 `dy_creator_accounts` 按 `platform + kwUid` 读取；供应商身份和返点从达人—机构关系按 `platform + kwUid + supplier_id` 读取。单个 `price_cents=null` 不能证明达人表没有价格，必须检查分档价格字段。向量召回只能作为软特征，不能覆盖平台、预算、返点等硬条件。

## 错误与停止条件

不得把旧 `requirement_id` 或推测的 candidate pool ID 代入 `id`。
不得把 Spec 目标模型中的 `creator_id`、`supplier_binding_id` 当作当前 MCP 字段，也不得根据昵称、机构名或其他字段猜测 `kwUid`、`supplier_id`。
数据库无结果或结果不足时如实返回，不得自动转为浏览器/互联网搜索。
不得把需求中的返点下限（例如 `rebateMinRate=0.3`）说成某家机构实际返回 30%。
