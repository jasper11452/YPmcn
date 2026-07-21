# 执行门禁

## 契约与状态

以根 `spec/manifest.json` 指向的 `spec/mcp.json`、`spec/workflow.json` 和运行时 schema 为准。每次业务 Tool 调用前先读 `tools/<tool>.json`；只传其中字段。Endpoint schema 优先；与目标导出契约冲突时返回 `integration_required`，不得自动回退。

会话状态写入 `state/confirmation_guard.json`。`phase/next_action` 是 Agent 编排权威，Provider 的 `workflow_state/allowed_actions` 只能提供业务事实或未知写对账，不能覆盖本地 phase。本地状态只按实际成功响应推进，失败不授权下一步。

## 手扒与五步导出链

1. 先确认完整需求和 `size`；导出时再确认 `platform`、字段与 `number`。`size`、`number` 必须匹配 `^[1-9][0-9]*$`。
2. 仅导出时先调用 `select_inquiry_form_fields({platform})`，且只调用一次；直接使用 Tool 等待网页 callback 后返回的字段，并规范化为保持原序的 `{key,name}`，Tool 返回后不得重新打开字段网页。只手扒时不以字段选择为前置。
3. 每次手扒前都重新解析完整 Brief 并调用 `validate_requirement`，新建时省略旧 `id/demandVersion`。必须取得本次实际成功响应新生成的非空需求 ID。
4. 紧邻调用 `manual_source_creators({requirement_id,size})`，其中 ID 必须等于第 3 步的新 ID 且只使用一次。无当前新 ID、ID 错配、已消费或中间插入其他业务 Tool 时，重新解析需求。
5. 导出时只接受该手扒成功响应中的非空、唯一字符串 `inquiry_ids`，无实际 `inquiry_ids` 不 rank；用它们、相同 `requirement_id` 和本轮 `columns` 调用 `rank_creators`。调用前比较本次与上一次 `rank_creators.requirement_id`，相同时提示“已根据需求进行排序，请注意”并继续调用，不得阻断；成功后同轮调用 `create_submission_batch({requirement_id,size,number})`。

手扒可从任意 phase 发起，不检查历史库是否检索过该需求，也不检查其他流程是否完成；唯一调用门槛是紧邻需求解析的新 ID。禁止发送 `target_count`、`run_id`、`limit` 或旧批次选项，不得复用其他轮次的字段和 ID。

## 失败与恢复

- Hook 仅消费并核对本次手扒的新需求 ID，不用 phase、历史检索或其他流程完成度阻断；本地成功投影不等于 Provider 成功。
- 导出场景的字段页面取消、callback 超时或 Tool 返回无效字段时停止该导出链；不得重开页面或拿旧字段继续。
- 重复 `rank_creators.requirement_id` 只触发提示，不改变参数、不阻止调用，也不新增确认步骤。
- 手扒、排序或导出写结果未知时先对账，禁止盲重试；无法取得权威结果就停止。
- 明确参数错误只修该字段；用户要求失败即停时绝不重试。
- 生产 Provider 尚未发布三参数导出契约时，最后一步返回 `integration_required`，不得改用旧 `run_id`。
