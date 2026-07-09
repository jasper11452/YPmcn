# MCP 工具路由

## 主链路

```
validate_requirement → search_creators → rank_mcns → create_with_distributions → ingest_mcn_submissions/manual_source_creators → rank_creators → create_submission_batch → record_client_feedback
```

- 需求主表固定为 `customer_demands`，候选中间层固定为 `creator_candidate_pool`；达人资源库物理表固定为 `xhs_creator_accounts`、`dy_creator_accounts`，字段从需求主表继承后按平台匹配
- `validate_requirement.data.id` → `search_creators({id})`
- `search_creators.data.id` → `rank_mcns({id})`
- `rank_mcns.data.id` → `create_with_distributions({id, ...企微发送字段})`
- 中风险：`medium_risk_confirmed: true` 后调 `rank_mcns`
- `rank_mcns` 成功后，MCP 返回达人供需关系（需求数量/候选数量/MCN 覆盖数量/缺口）、建议手扒比例及原因、建议询价 MCN 列表；前端必须展示这些信息，让用户同意或修改 MCN 列表
- 用户确认后，Agent 根据 `validate_requirement.data.id` 读取 `customer_demands` 非空字段拟写企微消息
- 发送前依次完成 5 步确认（`confirm-supply-ratio` → `mcn-select-for-wechat` → `confirm-form-fields` → `confirm-wecom-permission` → `mcn-wechat-send`），不可跳过或合并
- 需要手扒时，在 MCN 列表确认后同步启动 `manual_source_creators`（不等 MCN 回填结束）
- `create_with_distributions` 先 `preview_only: true` 预览 → 用户确认 → `preview_only: false` 正式发；使用固定接口字段，不自造新字段。每个 MCN 必须有唯一填报链接，用 `prefillRowsBySupplier` / `prefill_rows_by_supplier` 预填候选池中属于该 MCN 的达人
- `create_with_distributions` 成功后停，等机构回填和手扒结果回收到候选池 → 确认对候选池进行达人精排 → `rank_creators`
- `create_submission_batch` 复用 `rank_creators` 的 `run_id`。不传错链式 `id`
- 风险提报只在用户确认后传 `allow_need_confirm_with_risk: true`

## 工具表

当前生产 12 个 YPmcn 工具。企微分发统一使用 `create_with_distributions`，取代旧 `create_mcn_inquiries`。当前没有 `get_workflow_state`；运行时 schema 是参数语法权威，当前 schema 没有 `idempotency_key` 时不得自动重试。

| 工具 | 来源 |
|---|---|
| `validate_requirement` | MCP |
| `search_creators` | MCP |
| `rank_mcns` | MCP |
| `create_with_distributions` | MCP（需 preview → 正式两步） |
| `ingest_mcn_submissions` | MCP |
| `manual_source_creators` | MCP |
| `rank_creators` | MCP |
| `create_submission_batch` | MCP |
| `record_client_feedback` | MCP |
| `audit_manual_adjustment` | MCP |
| `get_creator_detail` | MCP |
| `get_recommendation_run_detail` | MCP |

客户反馈统一看 `record_client_feedback.data.next_action`。如需放宽条件，必须记录用户授权后的 `authorized_relaxations`。
