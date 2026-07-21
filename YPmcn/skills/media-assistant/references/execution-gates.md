# 执行门禁

## 契约与状态

以根 `spec/manifest.json` 指向的 `spec/mcp.json`、`spec/workflow.json` 和运行时 schema 为准。每次业务 Tool 调用前先读 `tools/<tool>.json`；只传其中字段。Endpoint schema 优先；与目标导出契约冲突时返回 `integration_required`，不得自动回退。

会话状态写入 `state/confirmation_guard.json`。`phase/next_action` 是 Agent 编排权威，Provider 的 `workflow_state/allowed_actions` 只能提供业务事实或未知写对账，不能覆盖本地 phase。本地状态只按实际成功响应推进，失败不授权下一步。

## 四步链路

1. 先确认 `platform`、`requirement_id`、`size`、`number`；`size`、`number` 必须匹配 `^[1-9][0-9]*$`。
2. 首个业务 Tool 固定为 `select_inquiry_form_fields({platform})`。等待网页提交；把每行“字段名：备注”转为 `{key: 字段名, name: 备注}`，保持原序。
3. 字段成功后调用 `manual_source_creators({requirement_id,size})`。只接受本轮成功响应中的非空、唯一字符串 `inquiry_ids`，无实际 `inquiry_ids` 不 rank。
4. 用这些 `inquiry_ids`、相同 `requirement_id` 和本轮 `columns` 调用 `rank_creators`。成功后同轮调用 `create_submission_batch({requirement_id,size,number})` 导出表格。

禁止在本链发送 `target_count`、`run_id`、`limit` 或旧批次选项。不得把需求 ID、询价 ID、数量或批次号互相替代，也不得复用其他轮次的字段和 ID。

## 失败与恢复

- Hook 不校验普通 Tool 参数、需求完整性、ID 血缘或工作流顺序；只记录实际结果，本地成功投影不等于 Provider 成功。
- 字段页面取消、超时或返回无效字段时停止，不启动手扒。
- 手扒、排序或导出写结果未知时先对账，禁止盲重试；无法取得权威结果就停止。
- 明确参数错误只修该字段；用户要求失败即停时绝不重试。
- 生产 Provider 尚未发布三参数导出契约时，最后一步返回 `integration_required`，不得改用旧 `run_id`。
