# 流程与恢复

最小会话索引（只记已确认的）：
```json
{"phase": "requirement|candidate_pool|mcn_planning|ranking|submission|feedback", "demand_id": null, "demand_version": null, "run_id": null, "project_distribution_completed": false}
```

## 阶段

| 阶段 | 下一动作 |
|---|---|
| requirement（validate_requirement 完成） | draft → 澄清；ready → 停等 brief 确认 |
| candidate_pool（search_creators 完成） | 确认口径 → 按 platform 调 `rank_mcns` |
| mcn_planning（rank_mcns 完成） | 依次确认：比例→名单→表单→角色→内容 → `create_with_distributions` |
| distribution（分发成功） | 停，等精排确认 → `rank_creators` |
| ranking（`rank_creators` 返回 run_id） | `create_submission_batch` |
| submission（批次成功） | 等客户反馈 |

## 弹窗顺序（不可跳过合并）

```
confirm-supply-ratio → mcn-select-for-wechat → confirm-form-fields
→ confirm-wecom-permission → mcn-wechat-send
```

弹窗写短，选项互斥且 ≤3 个。

## 恢复

1. 有 `run_id`：`get_recommendation_run_detail`
2. 有平台账号：`get_creator_detail`
3. 只有 `demand_id`/`demand_version`：无状态查询工具，按最近成功响应继续，证据不足则停
4. 写调用超时/断连（无幂等键）：不重试，用 `trace_id` 让后端查

## 失败条件

- 工具不存在 / schema 冲突 / ID 来源不明 / 响应信封破损 / 业务证据不足 → 停
- 不重复写、不模拟成功、不基于残缺结果推进
