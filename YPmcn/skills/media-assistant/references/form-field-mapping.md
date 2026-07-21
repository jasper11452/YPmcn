# 字段选择绑定

`select_inquiry_form_fields` 是本轮第一个业务 Tool，必传已确认的 `platform`：`xiaohongshu` 或 `douyin`。不要自行固定 `url`；仅在用户或 Endpoint 明确提供时传可选 `url/timeout_seconds`。

等待网页提交结果。只有成功响应中的 `description` 能逐行按全角或半角冒号拆成非空、唯一的“数据库字段名：字段备注”时才继续：

- 字段名映射为 `key`；备注映射为 `name`。
- 保持页面原顺序，每项仅保留非空 `key/name`。
- 旧 `field_key/field_name` 先改名；丢弃 `type`、`required`、`group` 等元数据。
- 不根据标签猜测数据库字段，不补固定列，不复用上轮字段。

把该数组作为本轮 `rank_creators.columns`。页面取消、超时、重复字段或解析失败时停止，不调用 `manual_source_creators`。
