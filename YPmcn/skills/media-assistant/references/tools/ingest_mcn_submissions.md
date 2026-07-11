# ingest_mcn_submissions

## 何时调用

当前会话先完成匹配触发方式的成功 sync，阶段为 `recovering` 时调用。

## 输入

必填 `mcn_recommendation_id`、`requirement_id`、`trigger`；trigger 只能是 `manual` 或 `scheduled`。

## 输出成功证据

- success === true
- data.id
- data.accepted_count
- data.rejected_count
- data.created_submission_item_count

## 调用后必须停在哪里

进入 `recovery_sync_pending`，必须执行最终 `sync_mcn_inquiry_status`；此时不能精排。

## 错误与停止条件

禁止 `demand_id`、`demand_version`、`items`。没有当前 sync 证据、触发类型不匹配或 scheduled 不在 cron 上下文时停止。
