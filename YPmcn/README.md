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
- Native Plugin 将 OpenClaw `before_tool_call`、`after_tool_call`、`session_end` 事件桥接到包内 Python Hook；`.claude/settings.json` 仅供 Claude Code 仓库开发会话使用。
- 当前 YP Action `2026.7.1` 内置 OpenClaw `2026.4.14`，Headless smoke 与开发依赖以该实际运行时为基线；业务工具资格名称以根 `spec/mcp.json` 为准，裸工具名不视为 Host 侧业务工具。
- provider 发送前由具备 `operator.write` scope 的客户端调用 `confirm_distribution_send` session action；缺 `sessionKey`、`toolCallId`、已绑定角色、三项确认或当前字段选择时一律阻断。
- 字段选择是发送前最后确认点，v2 只允许 `preview_only=false`。
- shell、PowerShell、curl 直连 provider 写接口会被阻断。
- content-only MCP wrapper 会先解包，再按对应 output contract 校验；工具结果仍原样持久化，Hook 不记录客户 payload。

## Provider 状态

开发 profile 默认连接 `http://192.168.0.129:32008/sse`，当前 15 个业务工具输入契约通过只读检查；公开向量查询 `search_creator_tag_vectors` 正在接入，作为可选能力，仅在 `tools/list` 实际广告后调用。生产 `https://mcp.eshypdata.com/sse` 当前未路由到 YPmcn 业务 Provider，因此完整生产链路保持 `integration_required`。

```bash
npm run mcp:dev
npm run verify:provider
npm run mcp:prod
npm run verify:provider:prod
```

源码可一键切换 profile；发布暂存始终使用生产 SSE，开发机 PASS 不作为生产成功证据。

## 开发与安装包

```bash
npm ci
npm test
npm run pack:yp
```

安装时使用生成的 `.tgz`，不要直接选择源码目录。本地测试结果不能作为生产成功证据。

Agent 指令见 [skills/media-assistant/SKILL.md](skills/media-assistant/SKILL.md)。源码仓库中的最终权威是根 `../spec/`；发布包内的 `spec/` 由统一打包脚本从该目录生成。
