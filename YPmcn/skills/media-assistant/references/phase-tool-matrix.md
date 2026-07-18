# 数据库权威状态与 Tool 矩阵

`workflow_state` 由数据库事实派生，`allowed_actions` 是下一步授权；Skill/Hook 不维护第二套 phase。

| Phase | 事实与主要动作 |
|---|---|
| `requirement_draft` | 非 ready；`validate_requirement` |
| `requirement_ready` | 无候选；`search_creators` |
| `candidate_pool_ready` | 有候选；确认供给方案后 `rank_mcns` |
| `mcn_planning` | 有 MCN 方案；选字段、补量、外发 |
| `waiting_mcn_return` | 已真实外发；sync / ingest |
| `candidate_pool_enriched` | 外发成功且回收完成；`rank_creators` |
| `recommendation_ready` | 已精排；audit（可选）/ `create_submission_batch` |
| `submission_batch_ready` | 已建批次；`record_client_feedback` |
| `feedback_routing` | 已记录反馈；按返回事实继续 |
| `blocked` / `closed` | 只读或返回的唯一修复动作 |

## 查询与口径

仅在接手已有需求、上下文/证据丢失、状态冲突、写结果未知或不可逆外发前调用 `get_workflow_state`；其余连续步骤复用上一成功响应。

候选数须带字段名：`workflow_state.candidate_count` 是池内总行数，`candidate_summary.<platform>.hard_filter_passed` 是硬筛通过数，`inquiry_advice.initial_candidate_count` 是去重且有 MCN 关系的供给计算数，三者可不同。供给确认展示 MCP `supply_plan` 的十个字段，机构/手扒比例两端都按达人账号数。

## 身份链

- `validate_requirement(payload)` 返回需求身份；`search_creators(id)`、`rank_mcns(id, platform)`、`rank_creators(requirement_id, limit)` 使用同一 `customer_demands.id`。
- `demand_id + demand_version` 连接需求版本、推荐 run 与提报；`project_id + mcn_id + requirement_id` 必须回查同一 distribution。
- `inquiry_id` 必须已存在且归属明确；`run_id` 只能来自精排成功响应或状态查询。证据不足 → `integration_required`，不得猜测或取最近记录。

## 写入与恢复

写操作目标 Ledger 状态为 `started → succeeded/failed/unknown`；unknown 只能查询对账，不得盲目重试。本地确认凭证不等于数据库幂等，是否生效以远程 trace/重放证据为准。

`select_inquiry_form_fields` 与用户确认不形成 phase；外部创建后，只有 `sync_mcn_inquiry_status` 查到真实 project/distribution 才进入等待。回收固定 `sync → ingest → sync`。

每次写后只接受实际 MCP 返回或对账所得的 `workflow_state + allowed_actions`；Hook、Ask、示例和推断不推进 phase。写结果未知进入 `reconciliation_required`；身份不唯一报 `integration_required`。`details.deniedReason="plugin-before-tool-call"` 只说明本地 Hook 拒绝且未到 MCP。
