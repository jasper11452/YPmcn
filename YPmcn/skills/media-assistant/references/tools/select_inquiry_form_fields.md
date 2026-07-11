# select_inquiry_form_fields

## 何时调用

MCN 方案和外发消息已确认，需要确定询价表单列时调用。字段选择是发送前最后确认点。

## 输入

必填 `mcn_recommendation_id`，值来自 rank_mcns.data.id。

## 输出成功证据

- success === true
- fields
- items
- selected_count === items.length
- selected_count > 0

这是唯一不使用 `{success,data,error}` 标准信封的顶层结果。

## 调用后必须停在哪里

合法结果进入 `field_selection_ready`；将有序 items 原样用于发送 columns。

## 错误与停止条件

禁止 `demand_id`、`demand_version`。map/items 定义不一致、空选择、计数不一致或旧会话证明均停止。

