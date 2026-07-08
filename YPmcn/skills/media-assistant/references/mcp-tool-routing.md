# MCP 工具路由

## 主链路

```
validate_requirement → search_creators → rank_mcns → rank_creators → create_submission_batch → record_client_feedback
```

- `rank_mcns` 前必已完成 `confirm-supply-ratio` 弹窗
- 中风险：`medium_risk_confirmed: true` 后调 `rank_mcns`
- `rank_mcns` 成功后停，5 步确认（比例→名单→表单→权限→内容）→ `create_with_distributions`
- `create_with_distributions` 成功后停，`proceed-to-ranking` 弹窗 → `rank_creators`
- `create_submission_batch` 复用 `rank_creators` 的 `run_id`。不传错 `demand_id`

## 工具表

| 工具 | 来源 |
|---|---|
| `validate_requirement`、`search_creators`、`rank_mcns`、`rank_creators`、`create_submission_batch`、`get_recommendation_run_detail`、`record_client_feedback`、`manual_source_creators`、`audit_manual_adjustment` | MCP |
| `create_with_distributions` | MCP（需 preview → 正式两步） |
| `ingest_mcn_submissions` | MCP |
| `get_creator_detail` | MCP |
