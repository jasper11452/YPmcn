# 字段选择绑定

MCN 询价外发场景中，`select_inquiry_form_fields` 在 `create_with_distributions` 之前调用，必传已确认的 `platform`：`xiaohongshu` 或 `douyin`。手动拓展达人及其表格导出不调用字段选择。不要自行固定 `url`；仅在用户或 Endpoint 明确提供时传可选 `url/timeout_seconds`。

只调用一次 Tool，然后停止主动操作并等待用户本人在网页选择、确认和提交；禁止代用户点击、预选、推断或提交任何字段。等待期间不得再次调用，成功、取消、超时或 callback 无效后也禁止再次打开或要求用户重开字段网页。成功响应可以直接提供字段数组，也可以在 `description` 中逐行返回“数据库字段名：字段备注”；仅当结果能规范化为非空、唯一字段时才继续：

- 字段名映射为 `key`；备注映射为 `name`。
- 保持页面原顺序，每项仅保留非空 `key/name`。
- 旧 `field_key/field_name` 先改名；丢弃 `type`、`required`、`group` 等元数据。
- 不根据标签猜测数据库字段，不补固定列，不复用上轮字段。

把该数组作为本轮 `create_with_distributions.columns`。页面取消、callback 超时、重复字段或解析失败时停止本次 MCN 外发链，不得重开网页或复用旧字段。
