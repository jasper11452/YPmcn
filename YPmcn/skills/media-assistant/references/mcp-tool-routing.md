# MCP 工具路由

## 固定顺序

```text
validate_requirement
→ search_creators
→ rank_mcns
→ select_inquiry_form_fields
→ create_with_distributions
→ sync_mcn_inquiry_status
→ waiting_return
→ sync_mcn_inquiry_status → ingest_mcn_submissions → sync_mcn_inquiry_status
→ manual_source_creators（可选补量）
→ rank_creators
→ create_submission_batch
→ record_client_feedback
```

`get_recommendation_run_detail`、`get_creator_detail` 是只读详情查询；`audit_manual_adjustment` 只记录已明确的人工调整。可选 `get_workflow_state` 只能读取权威状态，不能替代链路证据。

## 语义 ID 传递

| 成功证据 | 下游参数 |
|---|---|
| validate_requirement.data.id → requirement_id | `search_creators.requirement_id`、sync/ingest 的 `requirement_id` |
| search_creators.data.id → candidate_pool_id | `rank_mcns.candidate_pool_id` |
| rank_mcns.data.id → mcn_recommendation_id | 字段选择、发送、sync、ingest、精排的 `mcn_recommendation_id` |
| rank_creators.data.run_id → run_id | 提报、反馈、详情、人工调整的 `run_id` |

不凭位置猜 ID，不使用旧版本字段替代语义 ID。任何来源不明或跨 provider 的 ID 都报 `STATE_CONFLICT`/`integration_required` 并停止。

## 人工决策点

1. `rank_mcns` 后确认供需判断与目标 MCN。
2. 外发消息定稿后确认消息。
3. `select_inquiry_form_fields` 返回合法字段选择；这是发送前最后确认。
4. 手动提前回收必须在当前会话明确表达。
5. 有风险达人时先展示证据，再决定是否调整或提报。

## 生产边界

- 每次运行先比对 `tools/list` 与 mvp-v2。
- `create_with_distributions` 是唯一 provider 写入口；不得 shell/curl 直连。
- `manual_source_creators` 只写人工来源及可验证 offer，不伪造账号。
- 写调用超时或断线后，使用 sync/详情查询对账，不重复写。
