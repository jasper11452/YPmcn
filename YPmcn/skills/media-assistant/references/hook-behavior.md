# OpenClaw Hook 行为

Hook 是 mvp-v2 的本地安全门，不是数据库事实来源。状态按 `sessionKey` 保存为 TTL 会话投影，并在 `session_end` 清除。

| 事件 | 行为 |
|---|---|
| `before_tool_call` | 校验精确 Host namespace、参数 schema、服务端 `state_version/allowed_actions`、权威 identifiers 和本地拒绝条件；仅全新会话首次 validate 是无授权 bootstrap，默认 fail-closed |
| `after_tool_call` | 只在逐工具 output contract 完整通过且 state_version 不倒退时更新投影 |
| `tool_result_persist` | 不改写工具结果，保留 provider/MCP 原始证据 |
| `message_received` | 仅三种明确回收表达写入手动确认；普通消息不解除等待 |
| `agent_turn_prepare` | 注入 phase 和安全 ID 摘要，不记录 payload |
| `session_end` | 只删除结束会话的投影 |

## 业务文档与机器阶段映射

原始业务文档展示的是面向 Hook 的简化状态投影；完整权威定义在仓库根 `spec/workflow.json` 的 14 个机器阶段。业务文档中的 `project_distribution_completed` 是展示布尔值，不是额外阶段：它由首次 sync 的权威证据派生，对应 `distribution_sync_pending → waiting_return`，不能由普通消息或 Agent 自行置位。

`get_workflow_state` 是 Hook 获得完整权威投影的唯一途径。只有它或带新 `allowed_actions` 的已验证 recovery 结果能授权下一业务写；写结果没有 `allowed_actions` 时，Hook 清除旧授权并要求写后刷新。`mcp__ypmcn__<contract-tool>` 之外的 bare/foreign 名称不进入业务 Hook。

## provider 发送守卫

`create_with_distributions` 缺任一证据即阻断：

- `sessionKey`、`toolCallId`、已知 `operatorRole`；
- `supplyConfirmed=true`、`mcnConfirmed=true`、`messageConfirmed=true`；
- 当前会话合法字段选择，且 `columns` 与有序 items 完全相同；
- 未来且带时区的 deadline/remindAt；
- 非空 supplier IDs、`usageScope=project`、`preview_only=false`。

shell、Bash、PowerShell、curl 对 provider 写 API 的绕过会返回 `INTEGRATION_REQUIRED`。

## 结果推进

- 标准工具只接受逐工具闭合的 `{success,data,error}`；字段选择是唯一顶层结果例外。
- 缺 success evidence、未知字段、错误 envelope、旧 state_version 或 failure result 都不推进，也不改任何状态或证据。
- 分发成功进入 `distribution_sync_pending`，首次 sync 成功才进入 `waiting_return`。
- ingest 成功进入 `recovery_sync_pending`，最终 sync 收口后才允许 rank。
- 会话摘要不包含 Brief、描述、预算原文、消息正文、凭据或完整状态对象。
