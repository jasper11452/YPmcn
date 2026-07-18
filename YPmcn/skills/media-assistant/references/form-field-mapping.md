# 询价字段绑定

`select_inquiry_form_fields` 只读。仅当实际成功且 `description` 每个非空行都能按全角或半角冒号拆成非空、唯一的“数据库字段名：备注”时，才按原顺序展示并让用户确认。

确认后逐项生成 `columns`：字段名原样作 `name`，备注作 `description`；不得猜旧 `fields/items/count`，也不得仅凭前端标签映射数据库字段。字段选择本身不发送、不推进 phase。
