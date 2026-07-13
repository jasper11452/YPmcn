# OpenClaw Hook 行为

Hook 是 mvp-v2 的本地安全门，不是数据库事实来源。状态按 `sessionKey` 保存为 TTL 会话投影，并在 `session_end` 清除。

OpenClaw 2026.6.11 暴露给 Hook 的 bundle-MCP 工具名是 `ypmcn__<tool>`；适配器只接受该宿主名和批准的 `mcp__ypmcn__<tool>` canonical 名，裸名或其他 server namespace 不取得 YPmcn 业务身份。

| 事件 | 行为 |
|---|---|
| `before_tool_call` | 校验目标 profile、参数 schema、阶段、语义 ID、发送确认和恢复证据；默认失败关闭 |
| `after_tool_call` | 只在完整成功证据存在时推进会话投影 |
| `tool_result_persist` | 不改写工具结果，保留 provider/MCP 原始证据 |
| `message_received` | 仅三种明确回收表达写入手动确认；普通消息不解除等待 |
| `agent_turn_prepare` | 注入 phase 和安全 ID 摘要，不记录 payload |
| `session_end` | 只删除结束会话的投影 |

插件另注册 `confirm_distribution_send` session action。OpenClaw Gateway 以 `operator.write` scope 校验调用者，action 再把角色和三项确认绑定到当前 `mcn_recommendation_id`；Hook 不读取宿主不会提供的 `operatorRole`、`gateState` 或 `confirmations` 事件字段。

## 业务文档与机器阶段映射

原始业务文档展示的是面向 Hook 的简化状态投影；完整权威定义在仓库根 `spec/workflow.json` 的 14 个机器阶段。业务文档中的 `project_distribution_completed` 是展示布尔值，不是额外阶段：它由首次 sync 的权威证据派生，对应 `distribution_sync_pending → waiting_return`，不能由普通消息或 Agent 自行置位。

## provider 发送守卫

`create_with_distributions` 缺任一证据即阻断：

- `sessionKey`、`toolCallId`；
- 当前推荐已通过 `confirm_distribution_send` 记录已知 `operatorRole`，且 `supplyConfirmed=true`、`mcnConfirmed=true`、`messageConfirmed=true`；
- 当前会话合法字段选择，且 `columns` 与有序 items 完全相同；
- 未来且带时区的 deadline/remindAt；
- 非空 supplier IDs、`usageScope=project`、`preview_only=false`。

shell、Bash、PowerShell、curl 对 provider 写 API 的绕过会返回 `INTEGRATION_REQUIRED`。

## 结果推进

- content-only MCP result wrapper 先从 text JSON 解包；标准工具只接受通过对应 output contract 的 `{success,data,error}`，字段选择是唯一顶层结果例外。
- 缺 success evidence 不推进，失败结果不改 phase。
- 字段选择结果只在当前阶段和 `mcn_recommendation_id` 同时匹配时写入；迟到结果不能覆盖当前选择证明。
- 分发成功进入 `distribution_sync_pending`，首次 sync 成功才进入 `waiting_return`。
- ingest 成功进入 `recovery_sync_pending`，最终 sync 收口后才允许 rank。
- 会话摘要不包含 Brief、描述、预算原文、消息正文、凭据或完整状态对象。
