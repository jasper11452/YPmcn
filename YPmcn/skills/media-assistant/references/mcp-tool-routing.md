# MCP 工具路由

生产调用只使用当前 `tools/list` 中的非 `pgy` 工具。

```text
validate_requirement(payload)
→ search_creators(id)
→ rank_mcns(id, platform)
→ 人工确认
→ select_inquiry_form_fields(url?, timeout_seconds?)
→ create_with_distributions(...)
→ sync_mcn_inquiry_status(requirement_id, project_id, mcn_id)
→ ingest_mcn_submissions(inquiry_id, items)
→ sync_mcn_inquiry_status(...)
→ rank_creators(requirement_id, limit)
→ create_submission_batch(run_id)
→ record_client_feedback(run_id, feedback_items)
```

`manual_source_creators` 用于真实人工来源补量；`get_recommendation_run_detail`、`get_creator_detail`、`get_workflow_state` 是只读查询；`audit_manual_adjustment` 记录明确的人工调整。`business_health` 仅检查 provider 健康，不证明任何业务步骤成功。

## ID 路由

当前 provider 未广告 outputSchema。只有拿到实际返回并确认字段语义后，才能把 ID 传给下游。`rank_creators` 的工具描述明确承诺返回 `run_id`；其他 ID 不沿用旧 `candidate_pool_id` / `mcn_recommendation_id` 映射。证据不足时返回 `integration_required`。

`get_recommendation_run_detail.run_id` 虽为 JSON string，值必须表示正整数。`get_workflow_state` 必须提供 `demand_id` + `demand_version`，或提供 `trace_id`。

## 写入门禁

外发前必须完成人工确认和字段确认。任何写调用结果未知时先使用只读证据对账；没有可证明的对账键就停止，不盲目重试。
