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
- data.recovery_operation_id
- data.state_version
- data.allowed_actions

## 调用后必须停在哪里

进入 `recovery_sync_pending`，必须执行最终 `sync_mcn_inquiry_status`；此时不能精排。仅结果的新 `allowed_actions` 含 `finalize_recovery` 时可继续。

## 错误与停止条件

禁止 `demand_id`、`demand_version`、`items`。manual 文本、scheduled/cron 与本地 phase 都不是授权；没有服务端 `request_recovery`、关键身份冲突、CAS/state_version 冲突或 output contract 不完整时停止。
