# 执行门禁

## 契约与本地状态

以根 `spec/manifest.json` 指向的 `spec/mcp.json`、`spec/workflow.json` 和运行时 schema 为准。每次业务 Tool 调用前先读 `tools/<tool>.json`；只传其中字段。Tool 存在不等于成功，只有实际 MCP 返回是业务证据。

会话编排状态写入本地 `state/confirmation_guard.json` 的 `workflow` 与 `workflow_events`。`phase/next_action` 是 Agent 编排权威，Provider 的 `workflow_state/allowed_actions` 只作业务事实或未知写对账，不能覆盖本地 phase。Hook 只按实际成功响应推进；失败保留阶段并进入恢复。本地状态不伪造 Provider 成功。

需求身份来自 `validate_requirement.data.id`；它用于 `search_creators/rank_mcns` 的 `id` 及后续 `requirement_id`。`demand_id+demand_version` 只用于对账，`project_id+supplierIds+requirement_id` 绑定 distribution，`inquiry_ids` 绑定回收，`run_id` 来自精排。达人/机构 ID 只复制实际结果，不猜测或展示给用户。

## 连续执行与人工确认

`validate_requirement` 成功后同轮调用 `search_creators`。搜索必须返回相互一致的需求量、命中数、比例、硬/缓冲缺口、风险、建议和动作；缺失/矛盾或高风险建议非正数即恢复，禁止用硬缺口回退成 0。按 `frontend-response.md` 展示后，高风险“供给确认”三选：启动手扒并开始 MCN、仅 MCN、调整一个正整数；提交后同轮调用相应 Tool，不得只回复已确认。

`rank_mcns` 使用动态 MCN 赛马规模，不依赖默认固定 5 家。成功后只显示机构名称、覆盖与缺口，ID 留作 `supplierIds`。选择机构后调用 `select_inquiry_form_fields` 并确认字段。

企微 Tool 只传 `requirement_id`、`supplierIds`、`columns`、纯文本 `description`；不得 JSON 化、杜撰或发送 `requirement_ID/colums`。

`create_with_distributions` 第一次仅预检；`before_tool_call` 以最近 `rank_mcns` 的 ID—名称核对 `supplierIds`，任一名称无法核对即阻断。`EXTERNAL_SEND_CONFIRMATION_REQUIRED` 中的 AskUserQuestion 必须原样调用，并以真实换行逐项展示 MCN、字段和完整企微消息。只有返回“确认发送”才同参数第二次调用；其他结果不外发，修改对象或消息后重新走预检。

## 工具边界与恢复

- Hook 不校验普通 Tool 参数、需求完整性、ID 血缘或工作流顺序；除外发绕过与 AskUserQuestion 外发确认外不做严格阻断。
- `manual_source_creators` 只用 `requirement_id` 和确认的正整数 `target_count` 启动/复用任务；`success=true` 不够，同一记录须含任务 ID、回显输入、允许状态/操作、启动时间和非负入池数。缺失、冲突或写结果未知时禁止盲重试和外发。
- 外发成功后按实际身份执行 `sync → ingest_mcn_submissions → sync`；无实际 `inquiry_ids` 不 ingest，不轮询。
- 写结果未知先对账且禁止盲重试；明确参数错误只修该字段。用户要求失败即停时绝不重试。
- 详情 Tool 只读且不推进；批次成功后才导出，客户有具体反馈后才记录。
