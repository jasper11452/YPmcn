# MCP 工具调用速查表

> 当前生产快照：`https://mcp.eshypdata.com/sse`，2026-07-06 通过 `tools/list` 读取。运行时 `inputSchema` 永远优先于本表。

## 1. 每次调用前预检

- [ ] 完整读取目标工具当前运行时 `inputSchema`。
- [ ] 请求体只包含 `properties` 已声明字段，所有 `required` 都有真实来源。
- [ ] Brief 入口若目标是 `validate_requirement`，schema 预检通过后直接调用；不得先向媒介确认。
- [ ] 其他需要媒介确认、选择或授权的节点，使用 `askuserquestion` 弹窗，问题短、选项互斥且最多 3 个。
- [ ] 不用业务调用探测 schema，不猜字段，不发送占位符。
- [ ] ID/版本/`run_id`/`inquiry_id` 来自此前成功响应；平台使用 `xhs`/`dy`。

当前生产请求中不限制额外字段。

## 2. 响应信封

基础响应为：

```json
{
  "success": true,
  "data": {},
  "error": null,
  "trace_id": "..."
}
```

`workflow_state` 和 `allowed_actions` 不是当前基础契约必填项。若实际响应额外提供，可作为可选信息使用。

## 3. 风险确认

| 场景 | 工具 | 实际字段 | 规则 |
|---|---|---|---|
| 中风险 MCN | `rank_mcns` | `medium_risk_confirmed` | 用户明确同意后才传 `true` |
| 风险账号提报 | `create_submission_batch` | `allow_need_confirm_with_risk` | 用户明确同意后才传 `true` |

不要改写成结构化 GateConfirmation，也不要添加 `gate_id/confirmation_type/operator_id`。

## 4. 工具清单

生产 YPmcn 工具共 12 个：10 个写工具、2 个只读查询。`create_with_distributions` 已集成到 MCP 工具集中。没有 `get_workflow_state`。

## 5. 分工具参数

### 5.1 `validate_requirement`

Agent 解析后的需求字段直接作为顶层入参传入，字段名与 `creator_candidate_pool_schema.csv`"合并结果"列完全对应。

必填（至少一项）：解析字段 或 `raw_messages`。

可选：

| 字段 | 类型 |
|---|---|
| `raw_messages` | array[object] |
| `project_context` | object 或 null |
| `existing_demand_id` | string 或 null |
| `existing_demand_version` | integer 或 null |

示例：

```json
{
  "platform": "xhs",
  "quantity_total": 10,
  "submission_deadline_at": "2026-07-20T18:00:00+08:00",
  "budget_max_cents": 500000,
  "content_requirements": "美妆 护肤 好物分享",
  "followercount": {"min": 100000},
  "project_name": "夏季新品",
  "raw_messages": [
    {"role": "client", "content": "客户原始 Brief"}
  ]
}
```

`requirement_parsed` 返回字段按 `customer_demands` 语义落库。`status=ready` 至少要求：`platforms`、`quantity_total`、`submission_deadline_at`，且 `content_requirements` 或 `budget_max_cents`/单价条件至少一个。返点缺失不阻断 ready。

ready 条件只是继续流程的最低门槛，不是字段抽取上限；`raw_messages` 中的其他客户要求应映射到 `customer_demands` 字段，无法独立落字段的保留到 `requirements_json`。

CPM、CPE、互动量、完播率等数字数据要求进入 `requirements_json.performance_thresholds` 或可执行 `filter_rules`。账号类型、内容方向、调性、参考账号等非数字条件进入向量召回和排序，不因类目不匹配默认淘汰候选。

### 5.2 `search_creators`

必填：`demand_id: string`、`demand_version: integer`。

可选：

| 字段 | 类型 | 默认值 |
|---|---|---|
| `authorized_relaxations` | array[object] 或 null | null |
| `write_candidate_pool` | boolean | true |
| `limit` | integer | 500 |

### 5.3 `rank_mcns`

必填：`demand_id: string`、`demand_version: integer`、`platform: string`。

可选：

| 字段 | 类型 | 默认值 |
|---|---|---|
| `minimum_mcn_count` | integer | 5 |
| `target_multiplier` | number | 20 |
| `buffer_rate` | number | 0.1 |
| `medium_risk_confirmed` | boolean | false |
| `limit` | integer | 20 |
| `write_mcn_recommendation_items` | boolean | true |

业务例外：硬筛后合格 MCN 少于 5 家时，`minimum_mcn_count=5` 自动失效。示例：需求 2 个、硬筛后有 60 位达人，但 60 位达人都属于同一家 MCN，则只向这 1 家或媒介确认后的实际合格 MCN 发送询价；不得为了凑满 5 家放宽硬筛条件，需预警媒介是否启动 `manual_source_creators` 手扒。

### 5.4 `rank_creators`

必填：`demand_id: string`、`demand_version: integer`、`ranking_strategy: string`。

可选：

| 字段 | 类型 | 默认值 |
|---|---|---|
| `run_type` | string | `initial` |
| `kw_uids` | array[string] 或 null | null |
| `ranking_weights` | object[number] 或 null | null |
| `feedback_preferences` | object 或 null | null |
| `exclude_submitted` | boolean | true |
| `allow_manual_sourced_in_initial_run` | boolean | false |
| `source_priority` | array[string] 或 null | null |
| `limit` | integer | 100 |
| `write_recommendation_items` | boolean | true |

### 5.5 `create_submission_batch`

必填：`run_id: string`。

可选：

| 字段 | 类型 | 默认值 |
|---|---|---|
| `target_submission_count` | integer 或 null | null |
| `recommendation_item_ids` | array[string] 或 null | null |
| `exclude_submitted` | boolean | true |
| `allow_need_confirm_with_risk` | boolean | false |
| `created_by` | string | `agent` |

### 5.6 `ingest_mcn_submissions`

必填：`inquiry_id: string`、`items: array[object]`。无其他请求字段。

### 5.7 `manual_source_creators`

必填：`demand_id: string`、`demand_version: integer`。

可选：`search_context: object|null`、`manual_results: array[object]|null`。

### 5.8 `record_client_feedback`

必填：`run_id: string`、`feedback_items: array[object]`。

可选：`requirement_changes: object|null`。

### 5.9 `audit_manual_adjustment`

必填：`run_id: string`、`adjustments: array[object]`、`operator_id: string`。无其他请求字段。

### 5.10 `get_creator_detail`

必填：`platform: string`、`platform_account_id: string`。

可选布尔字段及默认值：`include_offers=true`、`include_mcn=true`、`include_vector_text=false`、`include_recent_metrics=true`。

### 5.11 `get_recommendation_run_detail`

必填：`run_id: string`。

可选布尔字段及默认值：`include_submissions=true`、`include_creator_detail=false`、`include_feedback=true`。

### 5.12 `create_with_distributions`

必填字段以运行时 schema 为准，必须包含未来的带时区 ISO 8601 `deadline` / `remindAt`。

推荐按运行时 schema 选择以下两种形态之一：

```json
{
  "projectName": "618达人提报",
  "description": "请在截止时间前完成达人信息填写。",
  "deadline": "2026-07-07T18:00:00+08:00",
  "usageScope": "project",
  "platform": "小红书",
  "supplierIds": ["supplier-id"],
  "sendWechatNotification": true
}
```

或：

```json
{
  "project": {
    "projectName": "618达人提报",
    "description": "请在截止时间前完成达人信息填写。",
    "deadline": "2026-07-07T18:00:00+08:00",
    "usageScope": "project",
    "platform": "小红书"
  },
  "supplierIds": ["supplier-id"],
  "sendWechatNotification": true
}
```

`usageScope: "project"` 是首选固定写法，不要让模型选择业务枚举；接口文档里的 `项目` 会被 hook 兼容归一为 `project`。先 `preview_only: true` 预览消息，确认后 `preview_only: false` 真实发送。调成功后 Hook 进入等待锁，发送成功前不得调用 `rank_creators`。

## 6. 恢复与失败

- 有 `run_id`：用 `get_recommendation_run_detail` 核对写入结果。
- 只有达人平台账号：用 `get_creator_detail` 查询。
- 更早阶段写调用超时：当前请求 schema 没有幂等键，不得盲目重试；保存响应或错误中的 `trace_id`，让后端核对。
- schema 与本表不一致：以运行时 schema 为准并报告差异，确认后才调用。
