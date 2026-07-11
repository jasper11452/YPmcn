# mvp-v2 状态与恢复

Hook 状态只是 TTL 会话投影，数据库/provider 状态才是业务事实。

## 精确阶段

| 阶段 | 进入证据 | 下一安全动作 |
|---|---|---|
| `requirement_draft` | 新会话或需求待补 | `validate_requirement` |
| `requirement_ready` | validation 返回 ready 和需求 ID | `search_creators` |
| `candidate_pool_ready` | 候选池写入成功 | `rank_mcns` |
| `mcn_planning` | MCN 建议写入成功 | 人工确认并选择字段 |
| `field_selection_ready` | 顶层字段选择结果合法 | `create_with_distributions` |
| `distribution_sync_pending` | provider 分发成功 | 首次 `sync_mcn_inquiry_status` |
| `waiting_return` | 首次成功 sync | 等明确 manual 或 cron |
| `recovering` | 回收前 sync 成功且非终态 | `ingest_mcn_submissions` |
| `recovery_sync_pending` | ingest 成功 | 最终 sync |
| `recovered` | 最终 sync 返回 recovered | 可选补量后 `rank_creators` |
| `recommendation_ready` | 精排返回 run_id | `create_submission_batch` |
| `submission_batch_ready` | 提报批次写入成功 | 等客户反馈 |
| `feedback_routing` | 客户反馈写入成功 | 按 next_action 路由 |
| `blocked` | 契约、状态或确认不满足 | 修复证据后重入，不假成功 |

## 发送到等待

`create_with_distributions` 成功只能进入 `distribution_sync_pending`。只有首次成功 sync 返回 inquiry batch、inquiry IDs、snapshot、lifecycle 和 response status 后，才能进入 `waiting_return`。发送失败或 sync 失败均不进入等待。

## manual 恢复

1. 当前会话收到明确回收意图，记录确认时间但阶段仍为 `waiting_return`。
2. 带 `recoveryTrigger=manual` 执行 sync。
3. 非终态成功结果进入 `recovering`。
4. `trigger=manual` 执行 ingest。
5. 进入 `recovery_sync_pending`，执行最终 sync。
6. 只有最终 sync 的 lifecycle 为 `recovered` 才进入 `recovered`。

## scheduled 恢复

scheduled 路径必须有 `ctx.trigger=cron`，顺序同样是 sync、`trigger=scheduled` ingest、最终 sync。缺 cron 证据时返回 `RECOVERY_NOT_CONFIRMED`。

## 终态与重启

- lifecycle 已是 `recovered` 或 `closed` 时，不再触发写副作用，使用 `RECOVERY_ALREADY_TERMINAL` 语义。
- 字段选择后投影丢失：重新选择字段，不能伪造快照。
- 发送后首次 sync 前投影丢失：可用 `requirement_id + mcn_recommendation_id` 做幂等 sync 对账。
- ingest 前必须在当前会话先有成功 sync；rank 前最新权威 sync 必须为 recovered。
- 普通消息不解除等待。
