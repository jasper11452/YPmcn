# MCP 参数速查

| 工具 | 当前输入 |
|---|---|
| `validate_requirement` | `payload` |
| `search_creators` | `id` |
| `rank_mcns` | `id`, `platform`；可带调优字段 |
| `select_inquiry_form_fields` | 可选 `url`, `timeout_seconds` |
| `create_with_distributions` | `projectName`, `deadline`, `columns`, `supplierIds`, `prefillRows`, `prefillRowsBySupplier`；可选 `description`, `usageScope` |
| `sync_mcn_inquiry_status` | `requirement_id`, `project_id`, `mcn_id`；可选 cron 字段 |
| `ingest_mcn_submissions` | `inquiry_id`, `items` |
| `manual_source_creators` | `demand_id`, `demand_version`；可选 `search_context`, `manual_results` |
| `rank_creators` | `requirement_id`, `limit` |
| `create_submission_batch` | `run_id`；其余可选字段按 schema |
| `record_client_feedback` | `run_id`, `feedback_items`；可选 `requirement_changes` |
| `get_recommendation_run_detail` | `run_id` 与 include flags |
| `get_creator_detail` | `platform`, `kw_uid` 与 include flags |
| `audit_manual_adjustment` | `run_id`, `adjustments`, `operator_id` |
| `get_workflow_state` | `demand_id` + `demand_version`，或 `trace_id` |

Provider 没有广告 outputSchema。保留实际返回作为证据；不得把旧输出字段当正式契约，也不得用 `business_health` 代替业务证据。
