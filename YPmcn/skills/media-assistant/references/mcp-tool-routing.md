# MCP 工具路由

本文件定义当前生产 11 个 YPmcn 工具的调用顺序和成功证据。参数必须逐次对照运行时 `inputSchema` 与 [速查表](mcp-tool-cheatsheet.md)。

## Provider 绑定

1. 按短名匹配工具，允许 provider 前缀。
2. 同一流程固定一个 provider，不跨 provider 混用 ID。
3. 运行时 schema 是参数语法权威；缺失、类型冲突或多 provider 冲突时返回 `integration_required`。
4. 不调用近似工具，不用 shell/HTTP 绕过 MCP。

当前工具：

| 工具 | 调用时机 | 最低成功证据 |
|---|---|---|
| `validate_requirement` | 任意 Brief 的第一条业务调用 | `demand_id`、`demand_version`、`status` |
| `search_creators` | 需求 ready 后立即继续 | 候选池或供给评估结果 |
| `rank_mcns` | 候选池就绪后，按平台排序 | MCN 列表与分发建议 |
| `manual_source_creators` | 供给不足或媒介要求手工补量 | 导入/匹配结果 |
| `ingest_mcn_submissions` | 已获得真实 `inquiry_id` 和回填 items | 接受/拒绝明细或汇总 |
| `rank_creators` | `create_with_distributions` 成功且用户确认精排后 | `run_id` 与推荐项 |
| `create_submission_batch` | 复用有效 `run_id` 生成批次 | 批次号与 submissions |
| `record_client_feedback` | 客户对推荐批次给出反馈 | 更新结果与 `next_action` |
| `audit_manual_adjustment` | 人工删改、替换、强加或重排 | 审计写入结果 |
| `get_creator_detail` | 查询单个达人 | creator 详情 |
| `get_recommendation_run_detail` | 查询/恢复推荐运行 | run、批次及所选详情 |

当前没有 `get_workflow_state`。`create_with_distributions` 取代旧 create_mcn_inquiries，是当前唯一企微分发工具名；通过插件端点发送真实企微询价。先 `preview_only: true` 获取预览，确认后 `preview_only: false` 真实发送。不得再调用旧工具或近似内部服务。

## 主链路

```text
validate_requirement
→ search_creators
→ rank_mcns（每个平台独立）
→ **文本表格：`mcn-select-for-wechat`** — 选择需发送询价的 MCN（编号选择）
→ **文本表格：`mcn-wechat-send`** — 确认企微消息内容
→ create_with_distributions（preview_only: false 真实发送）
→ **文本表格：`proceed-to-ranking`** — 询问是否调用 rank_creators
→ rank_creators
→ create_submission_batch
→ record_client_feedback
```

- `validate_requirement`、`search_creators`、`rank_mcns` 是连续段，补全需求后不要在中间等待确认。
- `rank_mcns` 输出是建议，不是已发送询价。必须依次通过两次文本表格确认：选中 MCN → 确认消息内容，最后才调用 `create_with_distributions` 发送。
- 用户确认发送后调用 `create_with_distributions`（`preview_only: false`）进行企微询价；发送成功前不得调用 `rank_creators`。
- `create_with_distributions` 成功后通过 `文本表格`（`proceed-to-ranking` 模式）再次停，等待用户确认是否精排；不要仅凭模型推断。
- `create_submission_batch` 只使用 `rank_creators` 返回的真实 `run_id`。
- `record_client_feedback.data.next_action` 是反馈后的业务路由；未知枚举停止并报告接入冲突。

## 风险分支

- 中风险 MCN：先通过 `文本表格`（`medium-risk-confirm` 模式）获得用户明确确认，再在 `rank_mcns` 请求中传 `medium_risk_confirmed: true`。
- 风险账号提报：先通过 `文本表格`（`risky-submission-confirm` 模式）获得用户明确确认，再在 `create_submission_batch` 请求中传 `allow_need_confirm_with_risk: true`。
- 不添加结构化 gate 对象；当前 schema 没有 `gate_id` 或 `confirmation_type`。

## 调整与反馈

- 放宽筛选只使用 `search_creators.authorized_relaxations`，具体对象结构以运行时 schema/后端约定为准。
- 手工补量通过 `manual_source_creators`，不得虚构达人或报价。
- 人工调整通过 `audit_manual_adjustment` 留痕，不直接篡改推荐结果。
- 客户反馈必须绑定真实 `run_id`；需求确有变化时回到 `validate_requirement`。

## 响应与恢复

基础信封为 `{success,data,error,trace_id}`。`workflow_state`、`allowed_actions` 是可选扩展，不是当前基础成功条件。

- 有 `run_id` 时，用 `get_recommendation_run_detail` 对账。
- 写调用超时/断连且没有可查询 ID 时，不得盲目重试；当前 schema 没有 `idempotency_key`。记录 `trace_id` 并请后端核对。
- 只有完整成功信封和对应业务证据同时存在时，才更新本地摘要或声称完成。
