# 执行门禁

## 契约与本地状态

以根 `spec/manifest.json` 指向的 `spec/mcp.json`、`spec/workflow.json` 和运行时 schema 为准。每次业务 Tool 调用前先读 `tools/<tool>.json`；只传其中字段。Tool 存在不等于成功，只有实际 MCP 返回是业务证据。

会话编排状态写入本地 `state/confirmation_guard.json` 的 `workflow` 与 `workflow_events`。`phase/next_action` 是 Agent 编排权威，Provider 的 `workflow_state/allowed_actions` 只作业务事实或未知写对账，不能覆盖本地 phase。Hook 只按实际成功响应推进；失败保留阶段并进入恢复。本地状态不伪造 Provider 成功。

需求身份来自 `validate_requirement.data.id`；它用于 `search_creators/rank_mcns` 的 `id` 及后续 `requirement_id`。`demand_id+demand_version` 只用于对账，`project_id+mcn_id+requirement_id` 绑定 distribution，`inquiry_id` 绑定回收，`run_id` 来自精排。达人/机构 ID 只复制实际结果，不猜测或展示给用户。

## 连续执行与人工确认

`validate_requirement` 成功后同轮直接调用 `search_creators`，中间不停止、不确认。`search_creators` 成功后必须先按 `frontend-response.md` 输出固定供需格式，再在题头“供给确认”的弹窗正文中用真实换行完整重复需求数量、实际命中数、供需比、建议拓展数和确认问题；禁止用“以上”等弹窗外引用替代决策信息。确认前禁止调用 `rank_mcns`。弹窗返回“确认并开始MCN赛马”后同轮立即执行，不得只回复已确认。

`rank_mcns` 使用动态 MCN 赛马规模，不依赖默认固定 5 家。成功后只显示机构名称、覆盖与缺口，ID 留作 `supplierIds`。选择机构后调用 `select_inquiry_form_fields` 并确认字段。

企微 Tool 的 live 参数为 `requirement_id`、`supplierIds`、`columns`、`description`；其中 `description` 是 AI 仅根据已确认用户需求整理、可按需换行的微信纯文本，禁止 JSON、代码块或杜撰，`columns` 是用户选定的字段对象列表。业务说法 `requirement_ID/colums` 必须映射为 live key，禁止直接发送拼错字段。

正式外发采用两阶段调用 `create_with_distributions`。第一次是本地预检，`before_tool_call` 用最近一次成功 `rank_mcns` 响应中的真实 ID—名称关系核对全部 `supplierIds`；任一名称无法核对即阻断并返回 MCN 选择。核对通过后返回 `EXTERNAL_SEND_CONFIRMATION_REQUIRED`，其中 `<AskUserQuestionInput>` 内是必须原样使用的宿主 AskUserQuestion 参数：一个问题、两个 option 对象，问题正文用真实换行逐项展示 MCN、字段和完整企微消息。只有返回“确认发送”，才在同轮以完全相同外发参数执行第二次调用；Hook 消耗一次性参数指纹后才触达 Provider。拒绝/取消/关闭/超时、改写弹窗或改变参数都不外发；修改对象或消息后重新走预检。

## 工具边界与恢复

- Hook 不校验普通 Tool 参数、需求完整性、ID 血缘或工作流顺序；除外发绕过与 AskUserQuestion 外发确认外不做严格阻断。
- `search_creators` 只查现有库；`manual_source_creators` 只导入当前需求已有的真实人工结果。
- 外发成功后按实际身份执行 `sync → ingest_mcn_submissions → sync`；无真实 items 不 ingest，不轮询。
- 写结果未知先对账且禁止盲重试；明确参数错误只修该字段。用户要求失败即停时绝不重试。
- 详情 Tool 只读且不推进；批次成功后才导出，客户有具体反馈后才记录。
