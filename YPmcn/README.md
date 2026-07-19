# YPmcn 媒介助手插件

YP Action/OpenClaw 插件，按 `mvp-v2` 机器契约执行达人提报链路。插件只对不可逆企微外发做本地硬确认；参数与业务状态由 MCP/Provider 校验并从数据库派生。

## 完整链路

```text
validate_requirement
→ search_creators(id)
→ rank_mcns(id, platform)
→ 展示供需比、机构/手扒比例与 MCN 结果 → AskUserQuestion 确认
→ select_inquiry_form_fields()
→ manual_source_creators（可选，仅企微外发前）
→ AskUserQuestion 一次性确认
→ create_with_distributions(...)
→ sync_mcn_inquiry_status(requirement_id, project_id, mcn_id)
→ waiting_mcn_return
→ sync / ingest_mcn_submissions / sync（完成回收）
→ rank_creators(requirement_id)
→ create_submission_batch(run_id)
→ record_client_feedback(run_id, feedback_items)
```

发送成功并能从真实 project/distribution 镜像询价后进入 `waiting_mcn_return`。只有企微发送成功且回收完成才能进入 `candidate_pool_enriched` 并调用 `rank_creators`；手扒仅可在企微外发前补量，不能替代这两个状态事实。

## Hook 边界

插件注册 `before_prompt_build`、`before_tool_call`、`after_tool_call`、`session_end`。

- Hook 不保存业务 phase，不依赖 `sessionKey`、`session_start` 或生命周期事件；`session_end` 只做机会性 TTL 清理。
- 需求 preview 只作为提示上下文，不形成 Tool 权限门禁；Skill、resources、prompts、普通宿主工具和除企微外发外的 YPmcn Tool 均不被 Hook 阻断。
- 参数、ID 血缘、工作流顺序和业务动作授权交给 MCP/Provider；Hook 不重复实现一套本地业务状态机。
- shell、PowerShell、curl 直连 provider 的企微外发接口会被阻断，避免绕过最终确认。
- provider 发送首次调用返回 `YP_CONFIRMATION_REQUIRED`；AskUserQuestion 精确确认且请求参数未变化时只放行一次。
- Reject、超时、修改、参数变化、重放或未知写结果都不会沿用旧确认；再次尝试必须重新确认。
- Hook 不记录客户 Brief、消息正文或完整 payload。

## Provider 状态

开发与生产 profile 统一连接 `https://mcp.eshypdata.com/sse`。仓库保留的 15 个业务工具契约仍须通过当前 endpoint 的实时 `tools/list` 检查，不能把旧快照冒充实时结果。

```bash
npm run mcp:dev
npm run verify:provider
npm run mcp:prod
npm run verify:provider:prod
```

发布包写入统一远程 SSE，包内不含 Vector MCP。YP Action/OpenClaw 已支持 SSE；`.codex-plugin/plugin.json` 通过 `mcpServers` 指向包内 `.mcp.json`。Codex 插件结构校验已通过，但“YP Action 在没有预存全局配置的全新环境安装 tgz 后自动注册 MCP”仍必须用干净安装环境验收，不能用手工 `mcp set` 代替。

## 开发与安装包

```bash
npm ci
npm test
npm run pack:yp
```

安装时使用生成的 `.tgz`，不要直接选择源码目录。安装后先确认远程 `ypmcn-mcp` 已被宿主注册，再运行真实 Live E2E；本地测试不能作为生产业务成功证据。

Agent 指令见 [skills/media-assistant/SKILL.md](skills/media-assistant/SKILL.md)。机器契约以根目录 `../spec/` 为准；发布包内 spec 由统一打包脚本生成。

`hooks/*.py` 只保留为历史状态机的确定性回归工件，不是当前 YP Action 执行面，也不会进入发布包；当前宿主实际运行的是 `src/runtime-hooks.ts` 注册的 Node Hook。
