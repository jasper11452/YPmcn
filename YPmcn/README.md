# YPmcn 媒介助手插件

YP Action/OpenClaw 插件，按 `mvp-v2` 机器契约执行达人提报链路。插件负责参数门禁和不可逆外发确认；业务状态由 MCP 从数据库派生。

## 完整链路

```text
validate_requirement
→ search_creators(id)
→ 展示供需比与机构/手扒比例 → AskUserQuestion 确认
→ rank_mcns(id, platform)
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

插件注册 `before_tool_call`、`after_tool_call`、`session_end`。

- Hook 不保存业务 phase，不依赖 `sessionKey`、`session_start` 或生命周期事件；`session_end` 只做机会性 TTL 清理。
- 唯一本地状态是 10 分钟一次性确认凭证：搜索后的供给方案确认与企微外发确认；仅保存请求哈希和安全摘要。
- 每个 YPmcn 调用前按机器契约校验参数；shell、PowerShell、curl 直连 provider 写接口会被阻断。
- `rank_mcns` 首次调用返回 `YP_SUPPLY_PLAN_CONFIRMATION_REQUIRED`；供需比与机构/手扒方案经 AskUserQuestion 确认且参数未变化时只放行一次。
- provider 发送首次调用返回 `YP_CONFIRMATION_REQUIRED`；AskUserQuestion 精确确认且请求参数未变化时只放行一次。
- Reject、超时、修改、凭证过期或未知写结果均 fail closed。
- Hook 不记录客户 Brief、消息正文或完整 payload。

## Provider 状态

开发 profile 默认连接开发 MCP；当前 15 个业务工具输入契约通过只读检查。生产 provider 只有在 `tools/list` 实际广告完整业务工具后才可称为可用。

```bash
npm run mcp:dev
npm run verify:provider
npm run mcp:prod
npm run verify:provider:prod
```

发布暂存始终使用生产 SSE；开发机 PASS 不作为生产成功证据。

## 开发与安装包

```bash
npm ci
npm test
npm run pack:yp
```

安装时使用生成的 `.tgz`，不要直接选择源码目录。本地测试结果不能作为生产业务成功证据。

Agent 指令见 [skills/media-assistant/SKILL.md](skills/media-assistant/SKILL.md)。机器契约以根目录 `../spec/` 为准；发布包内 spec 由统一打包脚本生成。
