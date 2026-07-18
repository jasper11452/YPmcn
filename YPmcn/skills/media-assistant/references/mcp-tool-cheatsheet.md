# MCP 工具总表

| 工具 | 作用 | 当前输入 | 副作用/边界 |
|---|---|---|---|
| `validate_requirement` | 校验并写入 Brief | `payload` | 业务写；仓库无自然语言/语音解析器 |
| `search_creators` | 硬筛并生成供给计划 | `id` | 向量仅为内部软召回；返回去重硬筛数和固定 supply_plan；禁止浏览器/外搜 |
| `rank_mcns` | 基于当前候选生成 MCN 建议 | `id`, `platform`；可带调优字段 | 业务写；排序算法和生产结果未验证 |
| `select_inquiry_form_fields` | 获取并确认询价表字段 | 可选 `url`, `timeout_seconds` | 发送前确认；只信实际 description |
| `create_with_distributions` | 创建外部项目并向供应商分发 | `projectName`, `deadline`, `columns`, `supplierIds`, `prefillRows`, `prefillRowsBySupplier`；可选 `description`, `usageScope` | 外部写；当前 schema 未透传 notification_template，也没有外部 exactly-once |
| `sync_mcn_inquiry_status` | 对账询价/回收状态 | `requirement_id`, `project_id`, `mcn_id`；可选 cron 字段 | 目标实现查询发送方并独占 inquiry upsert；使用前仍以当前远程 Tool 响应为准 |
| `ingest_mcn_submissions` | 摄取真实 MCN 回收条目 | `inquiry_id`, `items` | 业务写；不能跳过最终 sync |
| `manual_source_creators` | 导入已关联到需求的真实人工补量结果 | `requirement_id` | 业务写；不是自动网页搜达人，结果必须已由媒介在服务端关联到该需求 |
| `rank_creators` | 对统一候选池精排 | `requirement_id`, `limit` | 业务写；必须实际返回 `run_id` |
| `create_submission_batch` | 从推荐 run 创建提报批次 | `run_id`；其余可选字段按 schema | 业务写；成功后可用宿主 export_csv 按固定 12 列渲染 |
| `record_client_feedback` | 记录客户对当前 run 的反馈 | `run_id`, `feedback_items`；可选 `requirement_changes` | 业务写；不得猜反馈状态 |
| `get_recommendation_run_detail` | 查询推荐、提报和反馈事实 | `run_id` 与 include flags | 只读；不推进流程 |
| `get_creator_detail` | 查询单个达人事实 | `platform`, `kwUid` 与 include flags | 只读；不得从昵称猜 UID |
| `audit_manual_adjustment` | 记录人工调整审计 | `run_id`, `adjustments`, `operator_id` | 业务写；缺操作者/原因则停止 |
| `get_workflow_state` | 按需求版本或 trace 查询流程事实 | `demand_id` + `demand_version`，或 `trace_id` | 只读；用于对账，不替代步骤成功证据 |

Provider 没有广告 outputSchema。保留实际返回作为证据；不得把旧输出字段当正式契约，也不得用 `business_health` 代替业务证据。

详细调用规则见同名 [tools/](tools/) 卡片。当前生产 Provider 和外部数据库均为未验证能力；“工具已定义”不等于“业务已完成”。
