# 当前 Endpoint 本地会话投影

Hook phase 是 24 小时 TTL 的本地安全投影，不是 provider 状态、业务事实或 `get_workflow_state` 的广告输出。provider 未广告 outputSchema；只有实际结果明确 `success === true` 且本步骤所需证据存在时才推进，否则保持原 phase。

## Phase

| 本地 phase | 所需实际证据 | 下一安全动作 |
|---|---|---|
| `requirement_draft` | 新会话 | `validate_requirement(payload)` |
| `requirement_ready` | success + 实际 `requirement_id` 或 `id` | `search_creators(id)` |
| `search_completed` | search 实际 success | `rank_mcns(id, platform)` |
| `mcn_planning` | rank success + 实际本地确认绑定 ID | 人工确认并选择字段 |
| `field_selection_ready` | success + 可解析 description | `create_with_distributions` |
| `distribution_sync_pending` | success + 实际 `project_id`、`mcn_id` | 首次 sync |
| `waiting_return` | 首次 sync 实际 success | 等明确 manual 或 cron |
| `recovering` | 回收 sync 实际 success；ingest 前还需实际 `inquiry_id` | ingest |
| `recovery_sync_pending` | ingest 实际 success | 最终 sync |
| `recovered` | 最终 sync 实际 success | `rank_creators(requirement_id, limit)` |
| `recommendation_ready` | rank success + 实际 `run_id` | `create_submission_batch(run_id)` |
| `submission_batch_ready` | create batch 实际 success | `record_client_feedback` |
| `feedback_routing` | feedback 实际 success | 按实际结果决定后续，不推断 |
| `blocked` | 契约、确认或证据不满足 | 修复证据后重入，不假成功 |

## 发送门禁

外发必须同时具备 `sessionKey`、`toolCallId`、`operator.write` action 写入的 supply/MCN/message 三项确认，以及已确认 description 与最终 `columns` 的顺序一一绑定。`mcn_recommendation_id` 仅可作为本地确认绑定，绝不发送给当前 provider。

## 恢复顺序

固定顺序：`sync_mcn_inquiry_status` → `ingest_mcn_submissions` → `sync_mcn_inquiry_status`。

- manual：明确用户意图后由 hook context 传 `recoveryTrigger=manual`；provider ingest 参数只有 `inquiry_id`、`items`。
- scheduled：必须有 `ctx.trigger=cron`、`recoveryTrigger=scheduled`，sync 还需实际 `cron_job_id`；`trigger` 不进入 provider 参数。
- 任一步结果未知、失败、含非空 error 或缺少下游必需 ID，phase 不推进且不得盲目重试。
- 会话投影丢失后停止写入并重新取得证据；不能用旧参数重建或宣称 provider 状态。
