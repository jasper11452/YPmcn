# MCP 工具总表

| 工具 | 作用 | 当前输入 | 副作用/边界 |
|---|---|---|---|
| `validate_requirement` | 校验并写入 Brief | `payload` | 业务写；仓库无自然语言/语音解析器 |
| `search_creators` | 从现有达人数据库硬筛 | `id` | 仅数据库过滤；禁止浏览器/外搜 |
| `rank_mcns` | 基于当前候选生成 MCN 建议 | `id`, `platform`；可带调优字段 | 业务写；排序算法和生产结果未验证 |
| `select_inquiry_form_fields` | 获取并确认询价表字段 | 可选 `url`, `timeout_seconds` | 发送前确认；只信实际 description |
| `create_with_distributions` | 创建外部项目并向供应商分发 | `projectName`, `deadline`, `columns`, `supplierIds`, `prefillRows`, `prefillRowsBySupplier`；可选 `description`, `usageScope` | 外部写；三项确认和发送守卫必须齐全 |
| `sync_mcn_inquiry_status` | 对账询价/回收状态 | `requirement_id`, `project_id`, `mcn_id`；可选 cron 字段 | 业务写/同步；三个 ID 必须有证据 |
| `ingest_mcn_submissions` | 摄取真实 MCN 回收条目 | `inquiry_id`, `items` | 业务写；不能跳过最终 sync |
| `manual_source_creators` | 导入真实人工补量结果 | `demand_id`, `demand_version`；可选 `search_context`, `manual_results` | 业务写；不是自动网页搜达人 |
| `rank_creators` | 对统一候选池精排 | `requirement_id`, `limit` | 业务写；必须实际返回 `run_id` |
| `create_submission_batch` | 从推荐 run 创建提报批次 | `run_id`；其余可选字段按 schema | 业务写；未知结果禁止重复建批次 |
| `record_client_feedback` | 记录客户对当前 run 的反馈 | `run_id`, `feedback_items`；可选 `requirement_changes` | 业务写；不得猜反馈状态 |
| `get_recommendation_run_detail` | 查询推荐、提报和反馈事实 | `run_id` 与 include flags | 只读；不推进流程 |
| `get_creator_detail` | 查询单个达人事实 | `platform`, `kwUid` 与 include flags | 只读；不得从昵称猜 UID |
| `audit_manual_adjustment` | 记录人工调整审计 | `run_id`, `adjustments`, `operator_id` | 业务写；缺操作者/原因则停止 |
| `get_workflow_state` | 按需求版本或 trace 查询流程事实 | `demand_id` + `demand_version`，或 `trace_id` | 只读；用于对账，不替代步骤成功证据 |
| `search_creator_tag_vectors` | 按需求语义召回并回源校验达人 | `positiveRequirements`, `negativeRequirements`；可选平台、项目、硬过滤和数量字段 | 只读；迁移中能力，仅在远程 Provider 实际广告时调用；结果必须带 MySQL 回源证明或明确降级原因 |

Provider 没有广告 outputSchema。保留实际返回作为证据；不得把旧输出字段当正式契约，也不得用 `business_health` 代替业务证据。

详细调用规则见同名 [tools/](tools/) 卡片。当前生产 Provider 和外部数据库均为未验证能力；“工具已定义”不等于“业务已完成”。
