# YPmcn 媒介助手插件

OpenClaw 插件，按 `mvp-v2` 机器契约执行达人提报完整链路。插件负责调用前门禁、结果驱动的会话投影和安全恢复；业务真相仍由 MCP、数据库和 provider 持有。

## 完整链路

```text
validate_requirement
→ search_creators(requirement_id)
→ rank_mcns(candidate_pool_id)
→ select_inquiry_form_fields(mcn_recommendation_id)
→ create_with_distributions(..., preview_only=false)
→ sync_mcn_inquiry_status(mcn_recommendation_id, requirement_id)
→ waiting_return
→ sync → ingest_mcn_submissions → sync
→ rank_creators(mcn_recommendation_id)
→ create_submission_batch(run_id)
→ record_client_feedback(run_id, feedback_items)
```

发送成功后不会直接进入等待；首次成功 sync 才会进入 `waiting_return`。普通消息不解除等待。手动和定时回收都必须完成 `sync → ingest → sync`，最终权威状态为 `recovered` 后才能精排。

## Hook 边界

插件注册：`before_tool_call`、`after_tool_call`、`tool_result_persist`、`message_received`、`agent_turn_prepare`、`session_end`。

- 会话投影受 TTL 约束，可随进程退出丢失，不代替数据库事实。
- OpenClaw 2026.6.11 的业务工具名按 `ypmcn__<tool>` 进入 Hook；裸工具名不视为业务工具。
- provider 发送前由具备 `operator.write` scope 的客户端调用 `confirm_distribution_send` session action；缺 `sessionKey`、`toolCallId`、已绑定角色、三项确认或当前字段选择时一律阻断。
- 字段选择是发送前最后确认点，v2 只允许 `preview_only=false`。
- shell、PowerShell、curl 直连 provider 写接口会被阻断。
- content-only MCP wrapper 会先解包，再按对应 output contract 校验；工具结果仍原样持久化，Hook 不记录客户 payload。

## Provider 状态

目标 profile 是 `mvp-v2`。当前生产 endpoint 的只读预检结果是 `legacy-1.9.4`，缺：

- `select_inquiry_form_fields`
- `create_with_distributions`
- `sync_mcn_inquiry_status`

因此完整生产链路当前返回 `integration_required`，不得自动降到旧 `demand_id/demand_version` 调用方式。检查命令：

```bash
node scripts/check-provider-contract.mjs --url https://mcp.eshypdata.com/sse
```

## 开发与安装包

```bash
npm ci
npm test
npm run pack:yp
```

安装时使用生成的 `.tgz`，不要直接选择源码目录。本地测试结果不能作为生产成功证据。

Agent 指令见 [skills/media-assistant/SKILL.md](skills/media-assistant/SKILL.md)。源码仓库中的最终权威是根 `../spec/`；发布包内的 `spec/` 由统一打包脚本从该目录生成。
