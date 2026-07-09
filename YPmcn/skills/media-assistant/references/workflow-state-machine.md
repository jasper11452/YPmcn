# 流程与恢复

最小会话索引（只记已确认的，数据库事实优先于本地状态）：
```json
{"phase": "requirement_draft|requirement_ready|candidate_pool_ready|mcn_planning|waiting_mcn_return|candidate_pool_enriched|recommendation_ready|submission_batch_ready|feedback_routing", "requirement_id": null, "candidate_pool_id": null, "mcn_recommendation_id": null, "run_id": null, "inquiry_ids": [], "last_tool": null, "last_trace_id": null, "last_error": null, "project_distribution_completed": false, "wait_gate": null}
```

`workflow_state` / `allowed_actions` 是 MCP 可选增强；当前没有 `get_workflow_state` 工具时，不伪造状态。

## 阶段

| 阶段 | 下一动作 |
|---|---|
| requirement_draft（validate_requirement 缺字段） | 停，问缺失项 |
| requirement_ready（validate_requirement 完成且必填项齐全） | `search_creators` |
| candidate_pool_ready（search_creators 完成） | 用 `search_creators.data.id` 调 `rank_mcns` |
| mcn_planning（rank_mcns 完成） | 展示供需关系、建议手扒比例、建议询价 MCN 列表；用户同意/修改 MCN 列表；Agent 根据需求表非空字段拟写企微消息；依次确认：`confirm-supply-ratio` → `mcn-select-for-wechat` → `confirm-form-fields` → `confirm-wecom-permission` → `mcn-wechat-send` → `create_with_distributions`（先 preview 再正式发） |
| waiting_mcn_return（分发成功） | 停，等机构回填和手扒结果回收到候选池；需要手扒时同步启动 |
| candidate_pool_enriched（回填/手扒回收到候选池） | 确认对候选池进行达人精排 → `rank_creators` |
| recommendation_ready（`rank_creators` 返回 run_id） | 风险确认（有风险时）→ `create_submission_batch` |
| submission_batch_ready（批次成功） | 媒介查看首批提报表 → 等客户反馈 |
| feedback_routing（record_client_feedback 完成） | 补批/重排/需求变更 |

## 弹窗顺序（不可跳过合并）

```
confirm-supply-ratio → mcn-select-for-wechat → confirm-form-fields
→ confirm-wecom-permission → mcn-wechat-send
→ confirm-ranking-after-supply-ready（仅在回填/手扒回收到候选池后，确认对候选池精排）
→ confirm-risky-submission（有风险账号时）
```

弹窗写短，选项互斥且 ≤3 个。

## 风险确认

- 中风险（`pending_gate.gate = confirm_medium_risk`）：`rank_mcns` + `medium_risk_confirmed: true`
- 风险提报（`pending_gate.gate = confirm_risky_submission`）：`create_submission_batch` + `allow_need_confirm_with_risk: true`
- 只能用户确认后设 true，不得默认

## 恢复

1. 有 `run_id`：`get_recommendation_run_detail`
2. 有平台账号：`get_creator_detail`
3. 只有链式 `id`：按最近成功响应判断它属于 requirement/candidate_pool/mcn_plan；证据不足则停
4. 写调用超时/断连：当前请求 schema 没有幂等键，不得自动重试，用 `trace_id` 让后端查

风险 gate 只使用真实字段：`medium_risk_confirmed=true`、`allow_need_confirm_with_risk=true`。

项目分发调用失败不进入等待锁；当前不创建 Cron。

## 失败条件

- 工具不存在 / schema 冲突 / ID 来源不明 / 业务证据不足 → 停
- 不重复写、不模拟成功、不基于残缺结果推进
