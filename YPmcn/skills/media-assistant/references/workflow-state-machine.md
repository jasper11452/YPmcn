# 流程与恢复

最小会话索引（只记已确认的，数据库事实优先于本地状态）：
```json
{"phase": "requirement|candidate_pool|mcn_planning|distribution|ranking|submission|feedback", "requirement_id": null, "candidate_pool_id": null, "mcn_plan_id": null, "run_id": null, "inquiry_ids": [], "last_tool": null, "last_trace_id": null, "last_error": null, "project_distribution_completed": false, "wait_gate": null}
```

`workflow_state` / `allowed_actions` 是 MCP 可选增强；当前没有 `get_workflow_state` 工具时，不伪造状态。

## 阶段

| 阶段 | 下一动作 |
|---|---|
| requirement（validate_requirement 完成） | draft → 澄清；ready → 停等 brief 确认 |
| candidate_pool（search_creators 完成） | 用 `search_creators.data.id` 调 `rank_mcns` |
| mcn_planning（rank_mcns 完成） | 展示供需关系、建议手扒比例、建议询价 MCN 列表；依次确认：比例→名单→表单→角色→内容 → `create_with_distributions` |
| distribution（分发成功） | 停，等机构回填和手扒结果回收到候选池；确认对候选池进行达人精排 → `rank_creators` |
| ranking（`rank_creators` 返回 run_id） | `create_submission_batch` |
| submission（批次成功） | 等客户反馈 |

## 弹窗顺序（不可跳过合并）

```
confirm-supply-ratio → mcn-select-for-wechat → confirm-form-fields
→ confirm-wecom-permission → mcn-wechat-send
→ confirm-ranking-after-supply-ready（仅在回填/手扒回收到候选池后）
```

弹窗写短，选项互斥且 ≤3 个。

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
