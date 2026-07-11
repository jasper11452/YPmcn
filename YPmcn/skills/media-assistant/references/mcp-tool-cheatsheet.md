# mvp-v2 参数速查

| 工具 | 核心输入 | 成功后语义 |
|---|---|---|
| `validate_requirement` | raw 或 structured 至少一种 | `data.id` 是 requirement_id |
| `search_creators` | `requirement_id` | `data.id` 是 candidate_pool_id |
| `rank_mcns` | `candidate_pool_id` | `data.id` 是 mcn_recommendation_id |
| `select_inquiry_form_fields` | `mcn_recommendation_id` | 顶层 fields/items/count |
| `create_with_distributions` | recommendation ID、项目、时间、supplier、columns、`preview_only=false` | provider project 与 distribution refs |
| `sync_mcn_inquiry_status` | recommendation ID + requirement ID | inquiry batch、snapshot、双状态 |
| `ingest_mcn_submissions` | 两个语义 ID + `manual`/`scheduled` | ingest batch 与计数 |
| `manual_source_creators` | requirement ID + manual results | manual batch |
| `rank_creators` | recommendation ID | run_id |
| `create_submission_batch` | run_id | batch ID/no/count |
| `record_client_feedback` | run_id + feedback items | updated count + next action |

标准结果是 `{success,data,error}`；`select_inquiry_form_fields` 是唯一顶层字段结果例外。写失败不可用缺省成功填补。
