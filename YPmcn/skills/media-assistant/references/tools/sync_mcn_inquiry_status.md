# sync_mcn_inquiry_status

## 何时调用

分发成功后的首次对账、manual/scheduled 回收前对账，以及 ingest 后最终收口时调用。

## 输入

必填 `mcn_recommendation_id`、`requirement_id`，均来自当前链路语义 ID。

## 输出成功证据

- success === true
- data.inquiry_batch_id
- data.inquiry_ids
- data.snapshot_id
- data.lifecycle_status
- data.response_status
- data.state_version
- data.allowed_actions

## 调用后必须停在哪里

首次 sync 进入 `waiting_return`；回收前非终态 sync 进入 `recovering`；ingest 后最终 sync 只有 recovered 才进入 `recovered`。后续写只以返回的新 `state_version` 和 `allowed_actions` 授权。

## 错误与停止条件

只允许输入两个语义 ID。明确禁止 `demand_id`、`demand_version`、`mode`、`provider_project_id`、`provider_distribution_id`、`distribution_batch_ref`、`distributions`、`fields`、`items`、`selected_count`、`inquiry_batch_id`、`inquiry_ids`、`snapshot_id`、`lifecycle_status`、`response_status`、`submitted_item_count`、`missing_item_count`、`count`。manual/cron 只是审计来源；没有服务端 `refresh_recovery` 或 `finalize_recovery`、关键身份冲突、旧投影或畸形结果时停止。
