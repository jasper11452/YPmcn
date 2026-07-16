# Hook 行为

| Claude Hook | Python 实现 | 行为 |
|---|---|---|
| `PreToolUse` | `hooks/pre_tool_guard.py` | 校验工具名、参数、会话 phase、语义 ID 与发送确认；允许调用时通过 `additionalContext` 软提醒先读工具卡、契约门禁、阶段矩阵及场景相关 reference |
| `PostToolUse` | `hooks/post_tool_update.py` | 仅从实际成功结果提取最小证据并推进本地状态；未知输出不推进 |
| `Stop` | `hooks/session_cleanup.py` | 清理超过 TTL 的会话投影 |

Hook 通过 `.claude/settings.json` 挂载，以 `session_id` 隔离状态；不记录完整 payload。

软 reference 门禁不会伪造或持久化“已阅读”状态，也不会因未读而阻断调用。Agent 只能在本会话实际打开 reference 后声称已阅读。

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
