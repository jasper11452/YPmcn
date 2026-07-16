# 阶段-工具-证据-约束 矩阵

Hook phase 是 24h TTL 本地安全投影，不是 provider 状态。provider 未广告 outputSchema；只有实际结果 `success === true` 且本步骤所需证据存在时才推进。

## 主链矩阵

| 本地 phase | 工具 | 所需实际证据 | 硬约束 |
|---|---|---|---|
| `requirement_draft` | `validate_requirement(payload)` | 新会话 | 必填项不缺；平台必须 `xhs`/`dy`；档期未过期 |
| `requirement_ready` | `search_creators(id)` | success + 实际 `requirement_id` | `id` 必须匹配当前 `requirement_id` |
| `search_completed` | `rank_mcns(id, platform)` | search 实际 success | `id` + `platform` 匹配 |
| `mcn_planning` | 人工确认 → `select_inquiry_form_fields(url?, timeout_seconds?)` | rank success + 三项确认写入 | supply/MCN/message 全部 true |
| `field_selection_ready` | `create_with_distributions(...)` | success + 可解析 description | 6 项发送守卫全部通过 |
| `distribution_sync_pending` | `sync_mcn_inquiry_status(requirement_id, project_id, mcn_id)` | success + 实际 `project_id`、`mcn_id` | 首次 sync；ID 三要素匹配 |
| `waiting_return` | 等 manual 或 cron | 首次 sync 实际 success | 普通消息不解除等待 |
| `recovering` | `sync → ingest → sync` | 回收 sync success + 实际 `inquiry_id` | manual: 明确回收意图；scheduled: `ctx.trigger=cron` |
| `recovery_sync_pending` | `sync_mcn_inquiry_status(...)` | ingest 实际 success | 最终 sync；触发来源一致 |
| `recovered` | `rank_creators(requirement_id, limit)` | 最终 sync 实际 success | `requirement_id` 匹配；已 recovered/closed 则阻断 |
| `recommendation_ready` | `create_submission_batch(run_id)` | rank success + 实际 `run_id` | `run_id` 匹配 |
| `submission_batch_ready` | `record_client_feedback(run_id, feedback_items)` | create batch 实际 success | `run_id` 匹配 |
| `feedback_routing` | 按实际结果决定 | feedback 实际 success | 不推断后续 |
| `blocked` | 修复证据后重入 | 契约、确认或证据不满足 | 不假成功 |

## 恢复顺序

固定顺序：`sync_mcn_inquiry_status → ingest_mcn_submissions → sync_mcn_inquiry_status`

- **manual**: 明确用户意图后 hook context 传 `recoveryTrigger=manual`
- **scheduled**: 必须有 `ctx.trigger=cron`、`recoveryTrigger=scheduled`
- 任一步结果未知、失败或缺少下游必需 ID，phase 不推进且不得盲目重试

## 只读工具

`get_recommendation_run_detail`、`get_creator_detail`、`get_workflow_state` 仅查询，不推进 phase。`audit_manual_adjustment` 记录人工调整。`manual_source_creators` 用于真实人工补量。

## ID 路由

- `rank_creators` 明确承诺返回 `run_id`
- 其他 ID 不沿用旧映射；证据不足 → `integration_required`
- `get_recommendation_run_detail.run_id` 必须表示正整数
- `get_workflow_state` 需要 `demand_id` + `demand_version` 或 `trace_id`

## 发送门禁

外发必须同时具备：`sessionKey`、`toolCallId`、三项确认(supply/MCN/message)、description 与 `columns` 顺序一一绑定、至少一个 supplierId、未来带时区 deadline。`mcn_recommendation_id` 仅作本地确认绑定，不发送给 provider。
