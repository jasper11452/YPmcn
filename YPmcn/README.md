# YPmcn 媒介助手插件

YP Action/OpenClaw 插件，按 `mvp-v2` 机器契约执行达人提报链路。插件只对不可逆企微外发做本地硬确认；参数与业务状态由 MCP/Provider 校验并从数据库派生。

## 完整链路

```text
select_inquiry_form_fields(platform) → 网页选择字段
→ manual_source_creators(requirement_id, size)
→ rank_creators(inquiry_ids, requirement_id, columns) 筛选去重
→ create_submission_batch(requirement_id, size, number) 导出表格
```

`size` 与 `number` 使用正整数十进制字符串。只有字段选择成功后才启动手扒；`rank_creators` 只消费本轮手扒实际返回的 `inquiry_ids`，并沿用相同需求和所选字段。排序成功后由 `create_submission_batch` 直接导出，不再调用宿主 `export_csv`，也不使用旧 `target_count` 或 `run_id` 参数。

## Hook 边界

插件注册 `before_prompt_build`、`before_tool_call`、`after_tool_call`、`session_end`。

- Hook 按会话把本地 phase、next_action 和脱敏事件写入 `state/confirmation_guard.json`；实际 MCP 结果仍是业务事实证据。
- 需求 preview 只作为提示上下文，不形成 Tool 权限门禁；Skill、resources、prompts、普通宿主工具和除企微外发外的 YPmcn Tool 均不被 Hook 阻断。
- 本地 JSON 是 Agent 编排状态权威，但 Hook 不对普通 Tool 做严格顺序/参数阻断；Provider 状态仅用于业务事实和未知写对账。
- shell、PowerShell、curl 直连 provider 的企微外发接口会被阻断，避免绕过最终确认。
- provider 发送调用会触发 Native Approval；Allow 由宿主继续同一待执行调用，Reject/超时/取消不触达 Provider。
- 参数变化、重放或未知写结果都必须产生新的 Native Approval；唯一例外是 Provider 明确无写入并指出未绑定机构时，只缩减这些机构的续发可继承原确认。
- Hook 不记录客户 Brief、消息正文或完整 payload。

## Provider 状态

开发与生产 profile 统一连接 `https://mcp.eshypdata.com/sse`。仓库保留的 15 个业务工具契约仍须通过当前 endpoint 的实时 `tools/list` 检查，不能把旧快照冒充实时结果。2026-07-21 只读检查已确认字段选择、手扒和排序的新输入；三参数 `create_submission_batch` 尚待 Provider 发布，生产导出当前保持 `integration_required`。

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
