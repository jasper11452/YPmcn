# search_creators

## 何时调用

已有 provider 接受的当前需求标识时调用。

`search_creators` 只用于在现有达人数据库中按需求字段过滤候选达人。
禁止为此打开浏览器、调用网页搜索、抓取站外页面或把它解释为外部达人发现工具。

## 输入

必填 `id`。

## 输出成功证据

- retain actual returned payload as downstream evidence
- 达人身份以实际返回的 `kwUid` 为准，供应商身份以实际返回的 `supplier_id` 为准。

## 调用后必须停在哪里

展示实际候选摘要；只有返回证据明确下游 ID 时才继续。

## 能力边界

该工具做数据库硬筛，不代表 MCN/野生达人/去重总量三层统计已完成。当前 MCP 从 `creator_supply_offers.kwUid` 读取平台达人 ID，从 `creator_supply_offers.supplier_id` 读取供应商 ID。向量召回只能作为软特征，不能覆盖平台、预算、返点等硬条件。

## 错误与停止条件

不得把旧 `requirement_id` 或推测的 candidate pool ID 代入 `id`。
不得把 Spec 目标模型中的 `creator_id`、`supplier_binding_id` 当作当前 MCP 字段，也不得根据昵称、机构名或其他字段猜测 `kwUid`、`supplier_id`。
数据库无结果或结果不足时如实返回，不得自动转为浏览器/互联网搜索。
