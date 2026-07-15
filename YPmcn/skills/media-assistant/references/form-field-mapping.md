# 询价字段 description 绑定

`select_inquiry_form_fields(url?, timeout_seconds?)` 是只读工具。当前 provider 只在描述中承诺 `数据库字段名：字段备注` 文本，不承诺旧 `fields`、`items` 或 `selected_count`。

## 合法证据

- 实际结果 `success === true` 且没有非空 error；
- 实际 `description` 每个非空行都能按全角或半角冒号拆成字段名与备注；
- 字段名非空、唯一并保留原顺序。

## 发送绑定

用户确认 description 后，`create_with_distributions.columns` 必须与字段名数量和顺序一致；每个 column 对象必须在顶层 key 或 string value 中明确包含对应字段名。无法一一证明时返回 `FIELD_SELECTION_INVALID`。

Hook 只保存 description 与字段名，不声称 provider 返回结构化字段快照。会话证据丢失时重新调用选择工具，不复用旧会话结果。
