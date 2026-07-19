# 执行门禁

## 契约与证据

先用运行时 `tools/list` 核对根 `spec/manifest.json` 指向的 `spec/mcp.json`、`spec/workflow.json` 和错误契约。Endpoint schema 优先；不兼容即 `integration_required`。Tool 存在不等于步骤成功，Hook、Ask、示例、测试或 reference MCP 都不是生产证据。

每次写后只按实际返回的 `workflow_state + allowed_actions` 推进。写结果未知只能用 `get_workflow_state` 对账，禁止盲重试；本地确认不替代数据库幂等。`blocked/closed` 只执行返回允许的只读或修复动作。

需求身份来自 `validate_requirement`；`demand_id+demand_version` 只用于状态版本，`project_id+mcn_id+requirement_id` 绑定 distribution，`inquiry_id` 绑定回收，`run_id` 只来自精排或验证状态。达人/机构沿用实际 `kwUid/supplier_id`，不得猜 `creator_id/supplier_binding_id`。价格来自平台 `kolOfficialPriceL1/L2/L3`；需求返点不是机构实际返点。

## 人工门禁

`search_creators` 成功后的下一个 Tool 必须直接是 `rank_mcns({id, platform})`，同一轮连续执行；两者之间不得插入 `AskUserQuestion`、文字确认、状态查询或其他 Tool。`id` 复用 `validate_requirement.data.id`，`platform` 复用已确认平台，只添加用户明确要求且 live schema 支持的排名参数。`search_creators` 或 `rank_mcns` 报错时立即停止后续业务 Tool，并在同一轮调用原生 `AskUserQuestion`：缺参/非法值请求精确澄清，明确后端错误提供安全恢复选择，未知写结果先对账且禁止盲重试。

`rank_mcns` 成功后再展示实际 MCN 列表、缺口和 Provider-backed 供给方案，等待用户完成 supply 与 MCN 选择；搜索时记录的供给摘要只用于该外发前确认，不得自行重算或编造。随后才选择询价字段并确认 message。外发前 supply、MCN、message 三项结果仍必须由 `confirm_distribution_send` session action 记录。

选择询价字段后展示实际 description、机构名单和固定消息预览。外发前重新查询同一项目状态并确认动作授权；supply、MCN、message 三项确认必须由 `confirm_distribution_send` session action 记录。首次外发 Hook 返回的 marker 和绑定摘要必须原样展示，只有“确认发送”才以完全相同参数继续；修改、拒绝、超时、过期或参数变化均重新确认或停止。session action 不可用时返回 `integration_required`，不得自行设计替代接口。

## 工具边界与恢复

- `search_creators` 只查现有库，不开浏览器或外搜。`manual_source_creators` 只在外发前导入已关联当前需求的真实人工结果，不能替代外发和回收。
- 外发成功后按实际返回身份执行 `sync → ingest_mcn_submissions → sync`；无真实回收 items 不 ingest，不轮询。只有真实外发、全部回收和 `candidate_pool_enriched` 才可 `rank_creators`。
- 详情 Tool 只读且不推进流程；`audit_manual_adjustment` 仅用于有操作者和原因的明确人工调整。批次成功后才导出；客户有具体反馈后才记录，不猜状态。

Hook 的 `before_tool_call`、`after_tool_call`、`session_end` 只做无会话依赖的安全守卫，不推进数据库 phase，也不记录完整 payload。任何 `block=true` 或 `details.status="blocked"` 都立即停止；只有实际远程 response/trace 才能归因 MCP/Provider。
