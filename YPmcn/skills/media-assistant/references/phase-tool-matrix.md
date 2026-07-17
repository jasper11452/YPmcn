# 数据库权威状态与 Tool 矩阵

`workflow_state` 由现有业务表派生。`allowed_actions` 是下一步业务授权；Skill 和 Hook 不自行维护第二套 phase。

| Phase | 数据库事实 | 主要允许动作 |
|---|---|---|
| `requirement_draft` | 需求不是 ready | `validate_requirement` |
| `requirement_ready` | ready 且没有候选 | `search_creators` |
| `candidate_pool_ready` | 已有候选、供给方案尚未确认或没有 MCN 方案 | 弹框确认后 `rank_mcns`；可在外发前 `manual_source_creators` |
| `mcn_planning` | 已有 MCN 方案、尚未形成真实分发 | `select_inquiry_form_fields`, `create_with_distributions`, `manual_source_creators` |
| `waiting_mcn_return` | 企微外发成功，存在已发或待回收询价 | `sync_mcn_inquiry_status`, `ingest_mcn_submissions` |
| `candidate_pool_enriched` | 企微外发成功且活动平台回收完成 | `rank_creators` |
| `recommendation_ready` | 精排成功、尚未提报 | `audit_manual_adjustment`, `create_submission_batch` |
| `submission_batch_ready` | 已创建提报批次 | `record_client_feedback` |
| `feedback_routing` | 已记录反馈 | 按返回事实决定 |
| `blocked` / `closed` | 冲突或终态 | 只读查询或明确修复动作 |

## 查询时机

调用 `get_workflow_state`：

1. 接手已有 `demand_id + demand_version`。
2. 上下文压缩或无法证明当前状态。
3. 写结果超时、断连、证据不足或 `WRITE_RESULT_UNKNOWN`。
4. MCP 返回状态冲突或 identity ambiguous。
5. 不可逆外发前。

其他连续步骤复用上一响应中的完整状态，避免每步重复查询。

## 候选数量口径

- `workflow_state.candidate_count`：已经落入候选池的总行数。
- `candidate_summary.<platform>.hard_filter_passed`：通过硬筛的候选行数。
- `rank_mcns.data.inquiry_advice.initial_candidate_count`：去重并具备 MCN 关系、实际进入 MCN 供给计算的候选数。

三个数字允许不同。回复时必须带口径名称，不得统称为“候选数量”或把差异解释为状态冲突。

搜索完成后还必须从已校验需求和实际搜索结果生成六个确认字段：`demand_count`、`database_candidate_count`、`supply_demand_ratio`、`recommended_mcn_count`、`recommended_manual_count`、`recommended_mcn_manual_ratio`。Ask 确认是进入 `rank_mcns` 的人工门禁，不是新的数据库 phase。

## 身份链

- `validate_requirement(payload)` 返回需求身份。
- `search_creators(id)` 与 `rank_mcns(id, platform)` 使用 `customer_demands.id`。
- `rank_creators(requirement_id, limit)` 使用同一内部 requirement ID。
- `customer_demands.id` 连接候选、MCN 方案和询价。
- `demand_id + demand_version` 连接需求版本、推荐 run 和提报。
- 外发使用 supplier 与 prefill 行反查唯一需求；零个或多个匹配都必须阻断。
- `project_id + mcn_id + requirement_id` 必须能回查同一真实 distribution。
- `inquiry_id` 必须已存在且归属明确后才能 ingest。
- `run_id` 必须来自 `rank_creators` 或状态查询。
- 证据不足 → `integration_required`，不得猜测或选择最近记录。

## 写结果

所有写操作先写 Ledger `in_progress`，完成后标记 `succeeded/failed/unknown`。相同幂等键已成功则返回已有摘要；unknown 只能查询对账，不得盲目重试。

`select_inquiry_form_fields` 和用户确认是外发准备，不形成持久 phase。只有真实项目和 distribution 写入并镜像为 inquiry 后，状态才进入 `waiting_mcn_return`。
