# 阶段-工具-证据-约束 矩阵

Hook phase 是 24h TTL 本地安全投影，不是 provider 状态。provider 未广告 outputSchema；只有实际结果 `success === true` 且本步骤所需证据存在时才推进。

## 当前能力边界

- 本矩阵描述目标业务顺序和本地调用门禁，不代表生产闭环已验收。
- 当前可证明的是 Spec 契约、输入校验、Hook 阻断、会话投影及部分独立向量检索；生产 Provider、外部数据库、企微发送与真实回收链路仍需外部证据。
- 任一阶段只有“实际 MCP 返回 + 本步骤必需 ID/状态”才算完成；Schema、自动化测试、健康检查和本地 phase 均不能替代业务证据。

## 业务流程

### 流程 A：Brief 进入与确认

1. 接收文本、表格内容或语音转写文本；当前仓库不提供自然语言/语音转写器。
2. 把 Brief 拆成原子需求，按 `reference_schema.csv` 提取平台、达人官方报价档位、项目总预算、返点、DDL、数量及高频筛选字段；不确定值保留原文或列入歧义，不猜测。
3. 向用户展示完整字段预览、原文保留、歧义和解析评分；只有 `score > 80` 且无硬阻断项时继续。
4. 调用 `validate_requirement(payload)` 写入/校验需求。
5. 只有返回可证明当前需求标识和 ready 状态时进入搜索；否则停在 `requirement_draft`。

### 流程 B：数据库硬筛与供给判断

1. 调用 `search_creators(id)` 过滤现有达人数据库；禁止浏览器和互联网搜索。
2. 硬条件不得被向量相似度或其他软特征覆盖，未知值不得直接判失败。
3. 展示数据库实际候选和供给缺口。当前三层数量（客户目标/机构提报/内部候选池）及 MCN/野生/去重统计尚未完整建模，不得补造。

### 流程 C：MCN 推荐与发送前确认

1. 调用 `rank_mcns(id, platform)` 生成 MCN 建议；不得暗自放宽条件凑数。
2. 向用户展示供给、目标 MCN 和拟发送消息，逐项取得 supply/MCN/message 三项确认。
3. 调用 `select_inquiry_form_fields` 获取字段说明，展示字段与备注并确认。
4. 调用 `create_with_distributions` 创建外部项目和分发。它是写操作；结果未知不得重复创建。

### 流程 D：等待、回收与摄取

1. 首次调用 `sync_mcn_inquiry_status` 对账后进入等待；普通聊天消息不能解除等待。
2. manual 回收必须有明确用户意图；scheduled 回收必须有 cron 上下文。
3. 严格执行 `sync → ingest_mcn_submissions → sync`。任一步失败、结果未知或缺 ID 都停止。
4. 当前真实供应商确认/删除/补充、催收周期和企微回执未完成生产验收，不得声称已闭环。

### 流程 E：人工补量

1. 数据库或机构供给不足时先展示缺口并取得人工确认。
2. `manual_source_creators` 只接收已有真实来源、可核验的人工结果；不得用虚拟达人或虚构报价。
3. 人工补量与机构结果必须保留来源，后续统一去重；当前分层统计和服务端强制顺序未完整验证。

### 流程 F：精排、提报与反馈

1. 回收最终 sync 成功后调用 `rank_creators`，保存实际 `run_id`。
2. 需要核对时用只读的 `get_recommendation_run_detail`、`get_creator_detail`；查询不推进 phase。
3. 人工调序、增删或改数量后，在 `recommendation_ready` 调用业务写 `audit_manual_adjustment` 留痕；`run_id` 必须匹配当前会话，每项调整必须有原因。
4. 审计成功仍停在 `recommendation_ready`，再调用 `create_submission_batch(run_id)` 生成批次；未知结果先查状态，不创建第二批。
5. 客户给出明确反馈后调用 `record_client_feedback`；仅按实际返回决定重跑、变更或结束。

### 流程 G：状态核对与失败恢复

1. 用 `get_workflow_state(demand_id, demand_version)` 或 `get_workflow_state(trace_id)` 查询权威工作流事实。
2. 写结果未知时先查询/对账；不能确认幂等时禁止盲目重试。
3. 本地 Hook phase 丢失、过期或与 Provider 冲突时，以 Provider 实际证据为准并返回 `integration_required`。
4. 权限、审计、脱敏导出、统一复核队列和非功能验收尚未完成，遇到相关要求必须明确报告能力缺口。

## 主链矩阵

| 本地 phase | 工具 | 所需实际证据 | 硬约束 |
|---|---|---|---|
| `requirement_draft` | `validate_requirement(payload)` | 新会话 | 必填项不缺；平台必须 `xiaohongshu`/`douyin`；档期未过期 |
| `requirement_ready` | `search_creators(id)` | success + 实际 `requirement_id` | `id` 必须匹配当前 `requirement_id` |
| `search_completed` | `rank_mcns(id, platform)` | search 实际 success | `id` + `platform` 匹配 |
| `mcn_planning` | 人工确认 → `select_inquiry_form_fields(url?, timeout_seconds?)` | rank success + 三项确认写入 | supply/MCN/message 全部 true |
| `field_selection_ready` | `create_with_distributions(...)` | success + 可解析 description | 6 项发送守卫全部通过 |
| `distribution_sync_pending` | `sync_mcn_inquiry_status(requirement_id, project_id, mcn_id)` | success + 实际 `project_id`、`mcn_id` | 首次 sync；ID 三要素匹配 |
| `waiting_return` | 等 manual 或 cron | 首次 sync 实际 success | 普通消息不解除等待 |
| `recovering` | `sync → ingest → sync` | 回收 sync success + 实际 `inquiry_id` | manual: 明确回收意图；scheduled: `ctx.trigger=cron` |
| `recovery_sync_pending` | `sync_mcn_inquiry_status(...)` | ingest 实际 success | 最终 sync；触发来源一致 |
| `recovered` | `rank_creators(requirement_id, limit)` | 最终 sync 实际 success | `requirement_id` 匹配；已 recovered/closed 则阻断 |
| `recommendation_ready` | 可选 `audit_manual_adjustment(...)` → `create_submission_batch(run_id)` | rank success + 实际 `run_id`；审计返回实际 success | 两个写操作均要求匹配 `run_id`、当前会话和 `toolCallId`；审计不推进 phase |
| `submission_batch_ready` | `record_client_feedback(run_id, feedback_items)` | create batch 实际 success | `run_id` 匹配 |
| `feedback_routing` | 按实际结果决定 | feedback 实际 success | 不推断后续 |
| `blocked` | 修复证据后重入 | 契约、确认或证据不满足 | 不假成功 |

## 恢复顺序

固定顺序：`sync_mcn_inquiry_status → ingest_mcn_submissions → sync_mcn_inquiry_status`

- **manual**: 明确用户意图后 hook context 传 `recoveryTrigger=manual`
- **scheduled**: 必须有 `ctx.trigger=cron`、`recoveryTrigger=scheduled`
- 任一步结果未知、失败或缺少下游必需 ID，phase 不推进且不得盲目重试

## 只读工具

`get_recommendation_run_detail`、`get_creator_detail`、`get_workflow_state` 与远程 `search_creator_tag_vectors` 仅查询，不推进 phase。向量查询仅在 Provider 实际广告时可用，必须保留 MySQL 回源证明或明确降级原因。`audit_manual_adjustment` 是仅允许在 `recommendation_ready` 调用且不推进 phase 的业务写。`manual_source_creators` 用于真实人工补量。

## ID 路由

- `rank_creators` 明确承诺返回 `run_id`
- 其他 ID 不沿用旧映射；证据不足 → `integration_required`
- `get_recommendation_run_detail.run_id` 必须表示正整数
- `get_workflow_state` 需要 `demand_id` + `demand_version` 或 `trace_id`

## 发送门禁

外发必须同时具备：`sessionKey`、`toolCallId`、三项确认(supply/MCN/message)、description 与 `columns` 顺序一一绑定、至少一个 supplierId、未来带时区 deadline。`mcn_recommendation_id` 仅作本地确认绑定，不发送给 provider。
