# get_creator_detail

## 何时调用

只读核对单个达人事实、报价或风险时调用。

## 输入

必填 `platform`、`kwUid`；只建议发送实际生效的 `include_offers`、`include_mcn`。`include_vector_text`、`include_recent_metrics` 当前实现未使用，不要发送。

## 输出成功证据

- retain actual returned payload as downstream evidence

## 调用后必须停在哪里

查询不推进主链，只展示已确认事实。

## 能力边界

只查询现有数据库中的单个达人，不打开浏览器补资料。当前 MCP 使用 `creator_supply_offers.kwUid` 定位平台达人，并以 `creator_supply_offers.supplier_id` 表示供应商。字段缺失、过期或来源冲突必须显式展示，不把缺失当作零或不合格。

## 错误与停止条件

不得发送旧 `creator_id` 或 Spec 目标字段 `supplier_binding_id`，不得从昵称猜 `kwUid`，也不得自行推导 `supplier_id`。
