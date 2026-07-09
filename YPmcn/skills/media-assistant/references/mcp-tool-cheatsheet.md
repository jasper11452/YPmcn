# MCP 工具调用速查表

## 通用规则

- 每次调工具前读该工具的 `inputSchema`，只传 schema 有的字段
- 响应尽量包含 `{success, data, error, trace_id}`；`workflow_state`/`allowed_actions` 可选
- 缺少 `trace_id` 或信封细项不由 hook 阻断；按业务 ID 和流程状态继续判断
- 只有 `success=true` + 业务 ID/结果存在才可说完成

## 工具参数速查

### validate_requirement
| 字段 | 类型 | 说明 |
|---|---|---|
| `platform` | string | `"xhs"` / `"dy"` |
| `quantity_total` | number | |
| `submission_deadline_at` | string | ISO 8601 带时区 |
| `raw_messages_json` | string | 必填，客户原始需求 JSON |
| `budget_min_cents` / `budget_max_cents` | number | 必填区间，单位：分 |
| `budget_raw` | string | 必填，预算/单价原文 |
| `rebate_min_rate` / `rebate_max_rate` | number | 必填区间，单位：小数 |
| `rebate_raw` | string | 必填，返点原文 |
| `raw_messages` | array | 可选，用户原文 |
| `project_context` | object | 可选 |

### search_creators
| 字段 | 类型 |
|---|---|
| `id` | string（来自 `validate_requirement.data.id`） |

### rank_mcns
| 字段 | 类型 |
|---|---|
| `id` | string（来自 `search_creators.data.id`） |
| `medium_risk_confirmed` | boolean（仅用户确认后传 true）|

### rank_creators
| 字段 | 类型 |
|---|---|
| `id` | string（优先来自汇总后的候选池/回填结果；按运行时 schema） |
| `ranking_strategy` | string |

### create_with_distributions
| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 来自 `rank_mcns.data.id` 的 MCN 排序方案 ID |
| `deadline` / `remindAt` | string | ISO 8601，**两步走**：先 `preview_only: true` |
| `supplierIds` / `supplier_ids` | array | |
| `usageScope` | string | `"project"` |
| `sendWechatNotification` | boolean | 可选 |
| `prefillRowsBySupplier` / `prefill_rows_by_supplier` | object | 可选但推荐；按 MCN/供应商预填候选达人 |
| `preview_only` | boolean | 预览模式 |

### create_submission_batch
| 字段 | 类型 |
|---|---|
| `run_id` | string（来自 `rank_creators`）|
| `allow_need_confirm_with_risk` | boolean |

### 其他
- `get_creator_detail`: `creator_id`
- `get_recommendation_run_detail`: `run_id`
- `ingest_mcn_submissions`: `inquiry_id`, `items`
- `manual_source_creators`: `id`, `creator_ids`（`id` 取当前需求/候选上下文，按运行时 schema）
- `record_client_feedback`: `run_id`, `feedback_items`，可选 `requirement_changes`
- `audit_manual_adjustment`: `run_id`, `adjustments`, `operator_id`
