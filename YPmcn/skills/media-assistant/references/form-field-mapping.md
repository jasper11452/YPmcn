# 询价表单字段映射

`select_inquiry_form_fields(mcn_recommendation_id)` 是只读工具，也是发送前最后确认点。

## 合法结果

- 顶层 `success === true`；
- `fields` 是按 key 索引的定义 map；
- `items` 是发送列的唯一顺序；
- `selected_count === items.length` 且大于 0；
- map 与 items 对同一 key 的 `{key,name,type,required}` 完全一致。

## 发送映射

`create_with_distributions.columns` 必须逐项等于当前会话的 `items`。不能重新排序、删改 required、添加运行时选择之外的列，也不能用旧会话字段选择。

字段快照由首次 `sync_mcn_inquiry_status` 负责创建或复用；Hook 只保存短期选择证明。进程重启导致证明丢失时，发送前必须重新选择。
