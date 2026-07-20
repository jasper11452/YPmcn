# 询价字段绑定

`select_inquiry_form_fields` 只读。仅当实际成功且 `description` 每个非空行都能按全角或半角冒号拆成非空、唯一的“数据库字段名：备注”时，才按原顺序展示并让用户确认。

生成 `columns`：字段名→必填 `key`，备注→`name`；旧 `field_key`/`field_name` 改名。不得猜 `fields/items/count` 或根据标签映射字段。选择不发送、不推进 phase。
