# MCP 工具调用速查表

## 通用规则

- 每次调工具前读该工具的 `inputSchema`，只传 schema 有的字段
- 响应 `{success, data, error, trace_id}`；`workflow_state`/`allowed_actions` 可选
- `success=true` → `error=null`；反之 `data=null`，`error` 对象
- 只有 `success=true` + 业务 ID/结果存在才可说完成

## 工具参数速查

### validate_requirement
| 字段 | 类型 | 说明 |
|---|---|---|
| `platform` | string | `"xhs"` / `"dy"` |
| `quantity_total` | number | |
| `submission_deadline_at` | string | ISO 8601 带时区 |
| `budget_min_cents` / `budget_max_cents` | number | 单位：分 |
| `rebate_min_rate` / `rebate_max_rate` | number | 单位：小数 |
| `raw_messages` | array | 可选，用户原文 |
| `project_context` | object | 可选 |

### search_creators
| 字段 | 类型 |
|---|---|
| `demand_id` / `demand_version` | string / number |
| `platform` | string |

### rank_mcns
| 字段 | 类型 |
|---|---|
| `demand_id` / `demand_version` | string / number |
| `platform` | string |
| `medium_risk_confirmed` | boolean（仅用户确认后传 true）|

### rank_creators
| 字段 | 类型 |
|---|---|
| `demand_id` / `demand_version` | string / number |
| `platform` | string |

### create_with_distributions
| 字段 | 类型 | 说明 |
|---|---|---|
| `deadline` / `remindAt` | string | ISO 8601，**两步走**：先 `preview_only: true` |
| `supplierIds` / `supplier_ids` | array | |
| `usageScope` | string | `"project"` |
| `sendWechatNotification` | boolean | 可选 |
| `preview_only` | boolean | 预览模式 |

### create_submission_batch
| 字段 | 类型 |
|---|---|
| `run_id` | string（来自 `rank_creators`）|
| `allow_need_confirm_with_risk` | boolean |

### 其他
- `get_creator_detail`: `creator_id`
- `get_recommendation_run_detail`: `run_id`
- `ingest_mcn_submissions`: `mcn_id`, `demand_id`
- `manual_source_creators`: `demand_id`, `creator_ids`
- `record_client_feedback`: `submission_batch_id`, `feedback_type`, `feedback_content`
- `audit_manual_adjustment`: `adjustment_id`, `action`
