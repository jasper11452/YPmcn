# Hook 行为

| Hook | 行为 |
|---|---|
| `before_tool_call` | 校验 Host qualified 工具名、live 参数、会话 phase、调用证据与发送确认；只会额外阻断 |
| `after_tool_call` | 仅从实际 `success === true` 且无非空 error 的结果提取最小证据；未知输出不推进 |
| `message_received` | 只记录当前会话明确 manual 回收意图 |
| `session_end` | 删除对应 TTL 会话投影 |
| `tool_result_persist` | 不改写工具结果，保留 provider/MCP 原始证据 |
| `agent_turn_prepare` | 注入脱敏的本地 phase/ID 摘要，并明确不是 provider 事实；不记录 payload |

插件注册 `confirm_distribution_send` session action。Gateway 以 `operator.write` scope 校验调用者；action 保持公开 payload：`mcn_recommendation_id`、`operatorRole`、`supplyConfirmed`、`mcnConfirmed`、`messageConfirmed`。其中 `mcn_recommendation_id` 只绑定当前会话实际观察到的本地计划 ID，不发送给 provider。

## provider 外发守卫

`create_with_distributions` 缺任一项即阻断：

- 当前 `sessionKey` 和 `toolCallId`；
- media/procurement 角色及三项 true 确认；
- 已确认 description 与最终 `columns` 顺序一一绑定；
- 当前 live schema 的全部必填参数；
- 至少一个 supplier ID；
- 未来且带时区的 `deadline`。

旧 `mcn_recommendation_id`、`remindAt`、`preview_only`、`sendWechatNotification` 不得进入 provider 参数。shell、Bash、PowerShell、curl 绕过 provider 写 API 会返回 `INTEGRATION_REQUIRED`。

## 结果与恢复

- provider 没有广告 outputSchema；`workflow_state`、`allowed_actions`、状态字符串只作为原始观察，不解释为 provider 契约。
- 缺实际 success 或下游必需 ID时不推进 phase，不盲目重试。
- sync 使用 `requirement_id`、`project_id`、`mcn_id`；ingest 使用 `inquiry_id`、`items`。
- manual/scheduled 来源只在 hook context；scheduled 还必须有 `ctx.trigger=cron`，不能把 `trigger` 塞进 provider 参数。
